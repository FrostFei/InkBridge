import { db, withWorkspaceLock } from './db';
import { mergeValues } from './merge';
import { equalValue, isSupported, validatePath } from './types';
import type {
  Conflict,
  FileValue,
  GitRemote,
  NoteFile,
  RemoteSnapshot,
  SyncTransaction,
  Workspace,
} from './types';

const MAX_ATTEMPTS = 3;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const conflictId = (workspaceId: string, path: string) =>
  `${workspaceId}:${encodeURIComponent(path)}`;
function eligiblePath(path: string): boolean {
  try {
    return validatePath(path) === path;
  } catch {
    return false;
  }
}

/** A partial tree is an error, never evidence that a previously known file was deleted. */
function validateSnapshot(snapshot: RemoteSnapshot, head: string): void {
  if (snapshot.head !== head) throw new Error('远端快照与请求的提交不一致，已停止同步。');
  const regular = new Map(
    snapshot.entries
      .filter((entry) => entry.type === 'blob' && ['100644', '100755'].includes(entry.mode))
      .map((entry) => [entry.path, entry]),
  );
  for (const entry of regular.values()) {
    if (
      isSupported(entry.path) &&
      eligiblePath(entry.path) &&
      (!snapshot.files[entry.path] || snapshot.files[entry.path].sha !== entry.sha)
    ) {
      throw new Error(`远端快照不完整，尚未读取 ${entry.path}；本地内容已保留。`);
    }
  }
  for (const [path, file] of Object.entries(snapshot.files)) {
    if (!regular.has(path) || !eligiblePath(path) || regular.get(path)!.sha !== file.sha)
      throw new Error(`远端快照文件索引不一致：${path}`);
  }
}

function retainCached(
  value: FileValue | null,
  ...sources: (FileValue | null | undefined)[]
): FileValue | null {
  if (value?.kind !== 'binary' || value.blob) return value;
  const cached = sources.find(
    (source) => source?.kind === 'binary' && source.sha === value.sha && source.blob,
  );
  return cached?.kind === 'binary' ? { ...value, blob: cached.blob } : value;
}

function candidateAdditions(files: Iterable<NoteFile>, remote: RemoteSnapshot): string[] {
  const local = new Map([...files].map((file) => [file.path, file]));
  return [
    ...new Set([
      ...[...local.values()]
        .filter((file) => file.base === null && file.current !== null)
        .map((file) => file.path),
      ...Object.keys(remote.files).filter((path) => !local.get(path)?.base),
    ]),
  ].sort();
}
function relatedPaths(
  type: Conflict['type'],
  path: string,
  additions: string[],
): string[] | undefined {
  return type === 'delete-modify' || type === 'rename'
    ? additions.filter((candidate) => candidate !== path)
    : undefined;
}

async function capture(
  workspaceId: string,
): Promise<{ transaction: SyncTransaction; workspace: Workspace }> {
  return db.transaction('rw', db.workspaces, db.files, db.transactions, async () => {
    const workspace = await db.workspaces.get(workspaceId);
    if (!workspace) throw new Error('找不到本地仓库。');
    const captured = await db.files.where('workspaceId').equals(workspaceId).toArray();
    const transaction: SyncTransaction = {
      id: crypto.randomUUID(),
      workspaceId,
      phase: 'captured',
      captured,
      createdAt: Date.now(),
      baseHead: workspace.head,
    };
    await db.transactions.add(transaction);
    return { transaction, workspace };
  });
}

function sameSelection(a: Conflict, b: Conflict): boolean {
  return (
    a.resolved === b.resolved &&
    a.revision === b.revision &&
    a.remoteHead === b.remoteHead &&
    a.draft === b.draft &&
    a.keepBothPath === b.keepBothPath &&
    equalValue(a.resolution ?? null, b.resolution ?? null)
  );
}

async function selectionsStillValid(transaction: SyncTransaction): Promise<boolean> {
  return db.transaction('r', db.conflicts, db.files, async () => {
    for (const chosen of transaction.resolutions ?? []) {
      const current = await db.conflicts.get(chosen.id);
      const file = await db.files.get([transaction.workspaceId, chosen.path]);
      if (
        !current ||
        !current.resolved ||
        !sameSelection(current, chosen) ||
        (file?.revision ?? 0) !== chosen.revision
      )
        return false;
      if (
        chosen.keepBothPath &&
        (await db.files.get([transaction.workspaceId, chosen.keepBothPath]))?.current
      )
        return false;
    }
    return true;
  });
}

async function compute(
  transaction: SyncTransaction,
  remote: RemoteSnapshot,
): Promise<{
  merged: Record<string, FileValue | null>;
  conflicts: Conflict[];
  resolutions: Conflict[];
}> {
  const captured = new Map(transaction.captured.map((file) => [file.path, file]));
  const previous = new Map(
    (await db.conflicts.where('workspaceId').equals(transaction.workspaceId).toArray()).map(
      (conflict) => [conflict.path, conflict],
    ),
  );
  const paths = new Set([...captured.keys(), ...Object.keys(remote.files), ...previous.keys()]);
  const additions = candidateAdditions(captured.values(), remote);
  const merged: Record<string, FileValue | null> = Object.create(null);
  const copies = new Map<string, FileValue>();
  const conflicts: Conflict[] = [];
  const resolutions: Conflict[] = [];
  for (const path of paths) {
    const file = captured.get(path);
    const old = previous.get(path);
    // A post-capture edit has its own proven base (the captured editor content),
    // even though the file's synchronized base has already advanced to the commit.
    const base = old?.rebase ? old.base : (file?.base ?? null);
    const local = file?.current ?? null,
      incoming = remote.files[path]?.value ?? null;
    if (local && remote.entries.some((entry) => entry.path === path) && !remote.files[path]) {
      throw new Error(
        `路径 ${path} 在远端是受保护的未支持文件，不能自动覆盖。请先重命名本地文件。`,
      );
    }
    const result = mergeValues(base, local, incoming);
    const valid =
      old &&
      old.revision === (file?.revision ?? 0) &&
      old.remoteHead === remote.head &&
      equalValue(old.base, base) &&
      equalValue(old.local, local) &&
      equalValue(old.remote, incoming);
    if (valid && old.resolved) {
      merged[path] = old.resolution ?? null;
      if (old.keepBothPath) {
        // A remote addition or another resolution may have occupied the requested copy path.
        if (
          captured.get(old.keepBothPath)?.current ||
          previous.has(old.keepBothPath) ||
          remote.entries.some((entry) => entry.path === old.keepBothPath) ||
          copies.has(old.keepBothPath)
        ) {
          conflicts.push({ ...old, resolved: false });
          continue;
        }
        if (!incoming) {
          conflicts.push({ ...old, resolved: false });
          continue;
        }
        copies.set(old.keepBothPath, incoming);
      }
      resolutions.push(old);
    } else if (result.conflict || old) {
      // Even when newer inputs could now auto-merge, an earlier human selection must be
      // explicitly revalidated. Keep its draft, with the new B/L/R shown alongside it.
      const type = result.conflict ?? old!.type;
      conflicts.push({
        id: conflictId(transaction.workspaceId, path),
        workspaceId: transaction.workspaceId,
        path,
        type,
        base,
        local,
        remote: incoming,
        relatedPaths: relatedPaths(type, path, additions),
        revision: file?.revision ?? 0,
        remoteHead: remote.head,
        draft: old?.draft,
        rebase: old?.rebase,
        resolved: false,
      });
    } else merged[path] = result.value;
  }
  // Apply copies last so an existing tombstone cannot replace the kept copy with null.
  for (const [path, value] of copies) merged[path] = value;
  return { merged, conflicts, resolutions };
}

function verifyAccepted(transaction: SyncTransaction, snapshot: RemoteSnapshot): void {
  if (!transaction.merged)
    throw new Error('已提交事务缺少持久化快照，需要人工恢复；本地内容已保留。');
  for (const path of new Set([
    ...Object.keys(transaction.merged),
    ...Object.keys(snapshot.files),
  ])) {
    if (!equalValue(transaction.merged[path] ?? null, snapshot.files[path]?.value ?? null)) {
      throw new Error(`远端提交内容未通过确认：${path}。本地副本与事务已保留。`);
    }
  }
}

/** Atomic acknowledgment: only captured revisions are replaced; newer edits remain dirty. */
async function acknowledge(transaction: SyncTransaction, snapshot: RemoteSnapshot): Promise<void> {
  await db.transaction('rw', db.workspaces, db.files, db.transactions, db.conflicts, async () => {
    const workspace = await db.workspaces.get(transaction.workspaceId);
    if (!workspace) throw new Error('确认同步时本地仓库不存在。');
    const captured = new Map(transaction.captured.map((file) => [file.path, file]));
    const live = new Map(
      (await db.files.where('workspaceId').equals(transaction.workspaceId).toArray()).map(
        (file) => [file.path, file],
      ),
    );
    const oldConflicts = new Map(
      (await db.conflicts.where('workspaceId').equals(transaction.workspaceId).toArray()).map(
        (conflict) => [conflict.path, conflict],
      ),
    );
    const additions = candidateAdditions(live.values(), snapshot);
    const paths = new Set([...live.keys(), ...captured.keys(), ...Object.keys(snapshot.files)]);
    const writes: NoteFile[] = [];
    const rebaseConflicts: Conflict[] = [];
    for (const path of paths) {
      const now = live.get(path),
        before = captured.get(path),
        confirmed = snapshot.files[path];
      const base = retainCached(
        confirmed?.value ?? null,
        now?.current,
        now?.base,
        transaction.merged?.[path],
      );
      const unchanged = before
        ? !!now && now.revision === before.revision && equalValue(now.current, before.current)
        : !now;
      let current = unchanged ? base : (now?.current ?? null);
      if (!unchanged) {
        // Later typing was based on L, not on the newly merged B'. Merely changing
        // base to B' would make the next sync interpret missing remote lines as a
        // user deletion. Rebase that later delta explicitly, retaining overlap as B/L/R.
        const rebased = mergeValues(before?.current ?? null, current, base);
        if (rebased.conflict) {
          rebaseConflicts.push({
            id: conflictId(transaction.workspaceId, path),
            workspaceId: transaction.workspaceId,
            path,
            type: rebased.conflict,
            base: before?.current ?? null,
            local: current,
            remote: base,
            revision: now?.revision ?? 0,
            remoteHead: snapshot.head,
            rebase: true,
            relatedPaths: relatedPaths(rebased.conflict, path, additions),
            draft: oldConflicts.get(path)?.draft,
            resolved: false,
          });
        } else current = retainCached(rebased.value, current, base);
      }
      writes.push({
        workspaceId: transaction.workspaceId,
        path,
        base,
        current,
        baseSha: confirmed?.sha ?? null,
        revision: now ? now.revision + (!equalValue(now.current, current) ? 1 : 0) : 0,
        dirty: !equalValue(base, current),
        localModifiedAt: now?.localModifiedAt,
      });
    }
    await db.files.bulkPut(writes);
    for (const selected of transaction.resolutions ?? []) {
      const current = await db.conflicts.get(selected.id);
      // Editing the resolution while a push is in flight must not erase the new draft.
      if (current && sameSelection(current, selected)) await db.conflicts.delete(selected.id);
    }
    if (rebaseConflicts.length) await db.conflicts.bulkPut(rebaseConflicts);
    await db.workspaces.put({
      ...workspace,
      initialized: true,
      head: snapshot.head,
      lastSync: Date.now(),
      downloadProgress: `笔记已全部下载（${Object.values(snapshot.files).filter((file) => file.value.kind === 'text').length} 篇）；附件按需下载`,
    });
    await db.transactions.put({ ...transaction, phase: 'complete', error: undefined });
    // A successful acknowledgment supersedes earlier captures and failed read attempts.
    // Canonical conflict B/L/R and drafts remain in the conflicts table. Keep three recent
    // journal snapshots as evidence, and ALWAYS preserve unconfirmed proposed commits.
    const confirmedTransactions = (
      await db.transactions.where('workspaceId').equals(transaction.workspaceId).toArray()
    )
      .filter((tx) => tx.phase === 'complete' || !tx.proposedCommit)
      .sort((a, b) =>
        a.id === transaction.id ? -1 : b.id === transaction.id ? 1 : b.createdAt - a.createdAt,
      );
    if (confirmedTransactions.length > 3)
      await db.transactions.bulkDelete(confirmedTransactions.slice(3).map((tx) => tx.id));
  });
}

async function confirmAccepted(transaction: SyncTransaction, remote: GitRemote): Promise<void> {
  const snapshot = await remote.readSnapshot(transaction.proposedCommit!);
  validateSnapshot(snapshot, transaction.proposedCommit!);
  verifyAccepted(transaction, snapshot);
  await acknowledge(transaction, snapshot);
}

/** Returns retry only when the proposed commit is proven absent from the current history. */
async function recover(
  transaction: SyncTransaction,
  remote: GitRemote,
): Promise<'accepted' | 'retry'> {
  if (!transaction.proposedCommit || !transaction.remote)
    throw new Error('待恢复事务缺少提交信息，已保留本地副本。');
  let head = await remote.readHead();
  const accepted = async (candidate: string) =>
    candidate === transaction.proposedCommit ||
    (await remote.isAncestor(transaction.proposedCommit!, candidate));
  if (await accepted(head)) {
    await confirmAccepted(transaction, remote);
    return 'accepted';
  }
  if (head !== transaction.remote.head || !(await selectionsStillValid(transaction))) {
    await db.transactions.put({
      ...transaction,
      phase: 'complete',
      error: '远端或冲突选择已变化；未接受的候选提交保留记录，重新计算。',
    });
    return 'retry';
  }
  await db.transactions.put({ ...transaction, phase: 'pushing' });
  try {
    await remote.updateRef(transaction.proposedCommit);
  } catch (error) {
    // A timeout can occur after GitHub accepted the commit. Verify before retrying.
    head = await remote.readHead();
    if (await accepted(head)) {
      await confirmAccepted(transaction, remote);
      return 'accepted';
    }
    if (head !== transaction.remote.head) {
      await db.transactions.put({
        ...transaction,
        phase: 'complete',
        error: '非快进提交被拒绝，重新计算。',
      });
      return 'retry';
    }
    throw error;
  }
  // updateRef success is also verified by immutable commit content before any local ack.
  head = await remote.readHead();
  if (!(await accepted(head)))
    throw new Error('GitHub 尚未确认该提交；已保留待恢复事务，请稍后重试。');
  await confirmAccepted(transaction, remote);
  return 'accepted';
}

export async function syncWorkspace(
  workspaceId: string,
  remote: GitRemote,
  onStatus?: (message: string) => void,
): Promise<void> {
  const report = (message: string) => {
    try {
      onStatus?.(message);
    } catch {
      /* UI observers cannot alter durable synchronization. */
    }
  };
  return withWorkspaceLock(workspaceId, async () => {
    report('正在同步：获取持久化事务');
    const pending = (await db.transactions.where('workspaceId').equals(workspaceId).toArray())
      .filter((tx) => tx.phase !== 'complete' && tx.proposedCommit)
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const transaction of pending) {
      report('正在确认上次提交结果');
      try {
        await recover(transaction, remote);
      } catch (error) {
        await db.transactions.put({ ...transaction, phase: 'recovery', error: errorText(error) });
        throw error;
      }
    }
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const captured = await capture(workspaceId);
      let transaction = captured.transaction;
      const workspace = captured.workspace;
      try {
        if (
          (workspace.initialized && !workspace.head) ||
          (!workspace.initialized && workspace.head)
        )
          throw new Error('共同基准元数据缺失，需要人工恢复；当前本地副本已保留。');
        if (
          !workspace.initialized &&
          transaction.captured.some((file) => file.base !== null || file.baseSha !== null)
        )
          throw new Error('未初始化仓库包含无法定位提交的共同基准，需要人工恢复；本地副本已保留。');
        if (transaction.captured.some((file) => (file.base === null) !== (file.baseSha === null)))
          throw new Error('文件共同基准缺失，需要人工恢复；当前本地副本已保留。');
        report('正在同步：检查 GitHub 最新版本');
        const head = await remote.readHead();
        if (
          workspace.head &&
          workspace.head !== head &&
          !(await remote.isAncestor(workspace.head, head))
        ) {
          throw new Error(
            '远端历史已被重写或共同基准不可验证。已保留本地副本，请先导出备份，再使用人工恢复重新比较。',
          );
        }
        const snapshot = await remote.readSnapshot(head, report);
        validateSnapshot(snapshot, head);
        const computed = await compute(transaction, snapshot);
        transaction = {
          ...transaction,
          remote: snapshot,
          merged: computed.merged,
          resolutions: computed.resolutions,
        };
        if (computed.conflicts.length) {
          await db.transaction('rw', db.transactions, db.conflicts, async () => {
            await db.conflicts.bulkPut(computed.conflicts);
            await db.transactions.put({ ...transaction, phase: 'conflicts' });
          });
          report(`冲突待处理：${computed.conflicts.length} 项`);
          throw new Error(`有 ${computed.conflicts.length} 项冲突待处理；本次尚未提交 GitHub。`);
        }
        await db.transactions.put(transaction);
        const changes: Record<string, FileValue | null> = Object.create(null);
        for (const [path, value] of Object.entries(computed.merged)) {
          if (!equalValue(value, snapshot.files[path]?.value ?? null)) changes[path] = value;
        }
        if (!(await selectionsStillValid(transaction)))
          throw new Error('冲突处理期间本地内容或草稿已变化；请重新同步，草稿已保留。');
        if (!Object.keys(changes).length) {
          await acknowledge(transaction, snapshot);
        } else {
          report('正在同步：创建多文件原子提交');
          const proposedCommit = await remote.prepareCommit(head, changes, 'InkBridge: sync notes');
          transaction = { ...transaction, proposedCommit, phase: 'prepared' };
          // Persist the SHA before the only remote mutation. This closes the crash/timeout window.
          await db.transactions.put(transaction);
          const result = await recover(transaction, remote);
          if (result === 'retry') {
            report('远端已前进，正在重新合并');
            continue;
          }
        }
        const outstanding = (
          await db.conflicts.where('workspaceId').equals(workspaceId).toArray()
        ).filter((conflict) => !conflict.resolved);
        if (outstanding.length) {
          report(`冲突待处理：${outstanding.length} 项`);
          throw new Error(
            `本次快照已确认，但同步期间的新编辑有 ${outstanding.length} 项冲突；当前内容与草稿已保留，请处理后继续同步。`,
          );
        }
        const remaining = (
          await db.files.where('workspaceId').equals(workspaceId).toArray()
        ).filter((file) => file.dirty).length;
        report(remaining ? `本次快照已同步；仍有 ${remaining} 项本地修改待上传` : '已同步');
        return;
      } catch (error) {
        const stored = await db.transactions.get(transaction.id);
        if (stored?.phase !== 'complete' && stored?.phase !== 'conflicts') {
          await db.transactions.put({ ...transaction, phase: 'recovery', error: errorText(error) });
        }
        throw error;
      }
    }
    throw new Error('GitHub 连续发生并发更新，已停止自动重试。所有本地修改已保留，请稍后同步。');
  });
}

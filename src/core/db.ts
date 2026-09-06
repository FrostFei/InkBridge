import Dexie, { type Table } from 'dexie';
import { equalValue, isMarkdown, validatePath } from './types';
import type { Conflict, FileValue, NoteFile, SyncTransaction, Workspace } from './types';

/** Files retain tombstones and revisions, including after a successful deletion. */
export class InkBridgeDatabase extends Dexie {
  workspaces!: Table<Workspace, string>;
  files!: Table<NoteFile, [string, string]>;
  conflicts!: Table<Conflict, string>;
  transactions!: Table<SyncTransaction, string>;
  constructor(name = 'inkbridge-v1') {
    super(name);
    this.version(1).stores({
      workspaces: 'id',
      files: '[workspaceId+path],workspaceId,dirty',
      conflicts: 'id,workspaceId',
      transactions: 'id,workspaceId,phase',
    });
  }
}
export const db = new InkBridgeDatabase();

/** The same lock also protects explicit recovery from racing a running synchronization. */
export async function withWorkspaceLock<T>(
  workspaceId: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks?.request)
    throw new Error(
      '浏览器无法提供跨标签页同步锁。请使用支持 Web Locks 的 HTTPS 浏览器；本地编辑仍可使用。',
    );
  return navigator.locks.request(
    `inkbridge-sync:${workspaceId}`,
    { mode: 'exclusive', ifAvailable: true },
    async (lock) => {
      if (!lock) throw new Error('此仓库正在另一个请求或标签页中同步，请稍候。');
      return operation();
    },
  );
}

export async function createWorkspace(
  owner: string,
  repo: string,
  branch: string,
): Promise<Workspace> {
  const id = [owner.toLowerCase(), repo.toLowerCase(), branch].map(encodeURIComponent).join('/');
  return db.transaction('rw', db.workspaces, async () => {
    const existing = await db.workspaces.get(id);
    if (existing) return existing;
    const workspace: Workspace = {
      id,
      owner,
      repo,
      branch,
      head: null,
      initialized: false,
      downloadProgress: owner === 'local' ? '本机笔记，无需下载' : '尚未下载',
    };
    await db.workspaces.add(workspace);
    return workspace;
  });
}

export async function ensureDemoWorkspace(): Promise<Workspace> {
  const workspace = await createWorkspace('local', '本地笔记', 'offline');
  await db.transaction('rw', db.files, async () => {
    // Seed only an entirely new local workspace. Deleting the welcome file must stay deleted.
    if (await db.files.where('workspaceId').equals(workspace.id).count()) return;
    await db.files.add({
      workspaceId: workspace.id,
      path: '欢迎使用 InkBridge.md',
      base: null,
      baseSha: null,
      current: {
        kind: 'text',
        text: '# 欢迎使用 InkBridge\n\n这里是保存在此浏览器的本地笔记。可以断网编辑，内容会自动保存在本机。\n\n连接 GitHub 仓库后会建立独立的本地副本；这里的笔记仍会保留。\n\n- 使用左侧按钮新建笔记\n- 本地保存和云端同步是两个独立状态\n- 定期导出 ZIP，保留额外备份\n',
      },
      revision: 1,
      dirty: true,
    });
  });
  return workspace;
}

async function saveValue(
  workspaceId: string,
  path: string,
  current: FileValue | null,
  expectedRevision?: number,
): Promise<NoteFile> {
  validatePath(path);
  return db.transaction('rw', db.files, db.workspaces, async () => {
    if (!(await db.workspaces.get(workspaceId))) throw new Error('本地仓库不存在。');
    const previous = await db.files.get([workspaceId, path]);
    if (expectedRevision !== undefined && (previous?.revision ?? 0) !== expectedRevision) {
      throw new Error('此文件已在另一标签页或同步中更新。当前编辑草稿已保留，请先比较最新内容。');
    }
    if (previous && equalValue(previous.current, current)) return previous;
    const file: NoteFile = {
      workspaceId,
      path,
      base: previous?.base ?? null,
      baseSha: previous?.baseSha ?? null,
      current,
      revision: (previous?.revision ?? 0) + 1,
      dirty: !equalValue(previous?.base ?? null, current),
    };
    await db.files.put(file);
    return file;
  });
}

export function saveText(
  workspaceId: string,
  path: string,
  text: string,
  expectedRevision?: number,
): Promise<NoteFile> {
  if (!isMarkdown(path)) return Promise.reject(new Error('文字编辑仅支持 .md 或 .markdown 笔记。'));
  return saveValue(workspaceId, path, { kind: 'text', text }, expectedRevision);
}
export function deleteFile(
  workspaceId: string,
  path: string,
  expectedRevision?: number,
): Promise<NoteFile> {
  return saveValue(workspaceId, path, null, expectedRevision);
}

export async function gitBlobSha(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const payload = new Uint8Array(header.length + bytes.length);
  payload.set(header);
  payload.set(bytes, header.length);
  const digest = await crypto.subtle.digest('SHA-1', payload);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
export async function saveBinary(
  workspaceId: string,
  path: string,
  blob: Blob,
  expectedRevision?: number,
): Promise<NoteFile> {
  if (isMarkdown(path)) throw new Error('Markdown 笔记必须作为文本保存。');
  const sha = await gitBlobSha(blob);
  return saveValue(workspaceId, path, { kind: 'binary', sha, blob }, expectedRevision);
}

export async function renameFile(
  workspaceId: string,
  path: string,
  newPath: string,
): Promise<void> {
  validatePath(path);
  validatePath(newPath);
  if (path === newPath) return;
  if (isMarkdown(path) !== isMarkdown(newPath))
    throw new Error('重命名不能改变笔记与附件的文件类型。');
  await db.transaction('rw', db.files, async () => {
    const source = await db.files.get([workspaceId, path]);
    const target = await db.files.get([workspaceId, newPath]);
    if (!source?.current) throw new Error('要重命名的文件不存在。');
    if (target?.current) throw new Error('目标文件已存在，请选择其他名称。');
    await db.files.put({
      ...source,
      current: null,
      revision: source.revision + 1,
      dirty: source.base !== null,
    });
    await db.files.put({
      workspaceId,
      path: newPath,
      current: source.current,
      base: target?.base ?? null,
      baseSha: target?.baseSha ?? null,
      revision: (target?.revision ?? 0) + 1,
      dirty: !equalValue(target?.base ?? null, source.current),
    });
  });
}

/** Cache an attachment without generating a user edit or acknowledging a newer version. */
export async function cacheAttachment(
  workspaceId: string,
  path: string,
  blob: Blob,
  expectedSha?: string,
): Promise<void> {
  const actualSha = await gitBlobSha(blob);
  await db.transaction('rw', db.files, async () => {
    const file = await db.files.get([workspaceId, path]);
    if (!file || file.current?.kind !== 'binary') throw new Error('附件已移动或删除，请重新选择。');
    if ((expectedSha && file.current.sha !== expectedSha) || file.current.sha !== actualSha)
      throw new Error('附件版本已变化或下载内容不完整，请重试。');
    file.current = { ...file.current, blob };
    if (file.base?.kind === 'binary' && file.base.sha === actualSha)
      file.base = { ...file.base, blob };
    await db.files.put(file);
  });
}

export async function saveConflictDraft(id: string, draft: string): Promise<void> {
  if (!(await db.conflicts.update(id, { draft, resolved: false })))
    throw new Error('冲突记录已变化，请重新打开。');
}
export interface ConflictChoice {
  choice: 'local' | 'remote' | 'manual' | 'both';
  text?: string;
  path?: string;
}
export async function resolveConflict(id: string, choice: ConflictChoice): Promise<void> {
  // Selection is durable but does not discard any B/L/R value or change the working copy.
  const draft = choice.text;
  if (draft !== undefined) await saveConflictDraft(id, draft);
  await db.transaction('rw', db.conflicts, db.files, async () => {
    const conflict = await db.conflicts.get(id);
    if (!conflict) throw new Error('冲突记录不存在，请重新同步。');
    const file = await db.files.get([conflict.workspaceId, conflict.path]);
    if ((file?.revision ?? 0) !== conflict.revision)
      throw new Error('本地文件已再次修改；草稿已保留，请重新同步后确认。');
    let resolution: FileValue | null;
    let keepBothPath: string | undefined;
    if (choice.choice === 'manual') {
      if (conflict.local?.kind === 'binary' || conflict.remote?.kind === 'binary')
        throw new Error('附件不能按文本合并。');
      if (choice.text === undefined) throw new Error('请先填写合并结果。');
      resolution = { kind: 'text', text: choice.text };
    } else if (choice.choice === 'both') {
      if (!conflict.local || !conflict.remote)
        throw new Error('删除冲突请明确选择删除或保留内容。');
      keepBothPath = validatePath(choice.path ?? '');
      if (
        keepBothPath === conflict.path ||
        isMarkdown(keepBothPath) !== (conflict.remote.kind === 'text')
      )
        throw new Error('请为 GitHub 版本选择不同名称，并保留文件类型。');
      if ((await db.files.get([conflict.workspaceId, keepBothPath]))?.current)
        throw new Error('保留副本的路径已存在。');
      resolution = conflict.local;
    } else resolution = choice.choice === 'local' ? conflict.local : conflict.remote;
    await db.conflicts.put({ ...conflict, resolved: true, resolution, keepBothPath });
  });
}

/** Explicit user recovery: retain every current file; unknown history becomes add/add comparison. */
export async function recoverBaseline(workspaceId: string): Promise<void> {
  await withWorkspaceLock(workspaceId, () =>
    db.transaction('rw', db.workspaces, db.files, db.transactions, db.conflicts, async () => {
      const pending = await db.transactions.where('workspaceId').equals(workspaceId).toArray();
      if (pending.some((tx) => tx.phase !== 'complete' && tx.proposedCommit))
        throw new Error('还有结果待确认的提交，请先重试同步确认远端状态。');
      const workspace = await db.workspaces.get(workspaceId);
      if (!workspace) throw new Error('本地仓库不存在。');
      await db.files
        .where('workspaceId')
        .equals(workspaceId)
        .modify((file) => {
          file.base = null;
          file.baseSha = null;
          file.dirty = file.current !== null;
        });
      await db.conflicts
        .where('workspaceId')
        .equals(workspaceId)
        .modify((conflict) => {
          conflict.resolved = false;
          conflict.rebase = false;
        });
      await db.workspaces.put({
        ...workspace,
        head: null,
        initialized: false,
        downloadProgress: '人工恢复：保留本地，等待重新比较',
      });
    }),
  );
}

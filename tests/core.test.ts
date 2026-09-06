import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cacheAttachment,
  createWorkspace,
  db,
  deleteFile,
  gitBlobSha,
  recoverBaseline,
  renameFile,
  resolveConflict,
  saveBinary,
  saveConflictDraft,
  saveText,
} from '../src/core/db';
import { syncWorkspace } from '../src/core/sync';
import { installMockLocks, MockRemote, textValue as t } from './core.mock';
import type { Workspace } from '../src/core/types';

let workspace: Workspace;
const file = (path = '笔记.md') => db.files.get([workspace.id, path]);
const conflicts = () => db.conflicts.where('workspaceId').equals(workspace.id).toArray();
async function connect(remote: MockRemote) {
  await syncWorkspace(workspace.id, remote);
}
beforeEach(async () => {
  installMockLocks();
  await db.delete();
  await db.open();
  workspace = await createWorkspace('owner', 'notes', 'main');
});

describe('durable local storage', () => {
  it('persists exact bytes after reopening and permits offline creation', async () => {
    await saveText(workspace.id, '目录/中文 空格.md', '---\r\na: 1\r\n---\r\n正文\r\n');
    db.close();
    await db.open();
    expect((await file('目录/中文 空格.md'))?.current).toEqual(t('---\r\na: 1\r\n---\r\n正文\r\n'));
    await saveText(workspace.id, 'new.md', 'offline');
    expect((await file('new.md'))?.dirty).toBe(true);
  });
  it('guards concurrent tab saves and preserves monotonic revisions through deletion and rename', async () => {
    const original = await saveText(workspace.id, '笔记.md', 'one', 0);
    await saveText(workspace.id, '笔记.md', 'two', original.revision);
    await expect(saveText(workspace.id, '笔记.md', 'stale', original.revision)).rejects.toThrow(
      '另一标签页',
    );
    await renameFile(workspace.id, '笔记.md', '新的.md');
    expect((await file())?.revision).toBe(3);
    await saveText(workspace.id, '笔记.md', 'recreated');
    expect((await file())?.revision).toBe(4);
    expect((await file('新的.md'))?.current).toEqual(t('two'));
  });
  it('isolates repositories and case-sensitive branches and file paths', async () => {
    const other = await createWorkspace('owner', 'notes', 'Main');
    await saveText(workspace.id, 'A.md', 'upper');
    await saveText(workspace.id, 'a.md', 'lower');
    await saveText(other.id, 'A.md', 'other');
    expect((await file('A.md'))?.current).toEqual(t('upper'));
    expect((await file('a.md'))?.current).toEqual(t('lower'));
    expect((await db.files.get([other.id, 'A.md']))?.current).toEqual(t('other'));
  });
  it('rejects overwriting rename destinations and hidden/unsupported paths atomically', async () => {
    await saveText(workspace.id, 'A.md', 'A');
    await saveText(workspace.id, 'B.md', 'B');
    await expect(renameFile(workspace.id, 'A.md', 'B.md')).rejects.toThrow('已存在');
    await expect(saveText(workspace.id, '../bad.md', 'bad')).rejects.toThrow('路径无效');
    await expect(saveText(workspace.id, '.obsidian/state.md', 'bad')).rejects.toThrow('路径无效');
    expect((await file('A.md'))?.current).toEqual(t('A'));
  });
});

describe('three-way synchronization fixtures (mock established before implementation)', () => {
  it('downloads every note before establishing the first baseline; no empty commit', async () => {
    const remote = new MockRemote({ '笔记.md': t('base'), 'two.md': t('second') });
    await connect(remote);
    expect((await file())?.base).toEqual(t('base'));
    expect((await db.workspaces.get(workspace.id))?.initialized).toBe(true);
    expect(remote.prepared).toHaveLength(0);
  });
  it('handles local-only, remote-only and identical changes without extra commits', async () => {
    const remote = new MockRemote({ '笔记.md': t('base') });
    await connect(remote);
    await saveText(workspace.id, '笔记.md', 'local');
    await connect(remote);
    expect(remote.content('笔记.md')).toEqual(t('local'));
    expect((await file())?.dirty).toBe(false);
    remote.advance({ '笔记.md': t('remote') });
    await connect(remote);
    expect((await file())?.current).toEqual(t('remote'));
    await saveText(workspace.id, '笔记.md', 'same');
    remote.advance({ '笔记.md': t('same') });
    await connect(remote);
    expect((await file())?.dirty).toBe(false);
    expect(remote.prepared).toHaveLength(1);
  });
  it('merges nonoverlapping paragraphs and preserves exact mixed line endings', async () => {
    const remote = new MockRemote({ '笔记.md': t('first\r\n\r\nmiddle\n\nlast\r\n') });
    await connect(remote);
    await saveText(workspace.id, '笔记.md', 'LOCAL\r\n\r\nmiddle\n\nlast\r\n');
    remote.advance({ '笔记.md': t('first\r\n\r\nmiddle\n\nREMOTE\r\n') });
    await connect(remote);
    expect(remote.content('笔记.md')).toEqual(t('LOCAL\r\n\r\nmiddle\n\nREMOTE\r\n'));
  });
  it('persists overlapping conflict B/L/R and a manual draft across refresh, then resolves', async () => {
    const remote = new MockRemote({ '笔记.md': t('base\n') });
    await connect(remote);
    await saveText(workspace.id, '笔记.md', 'local\n');
    remote.advance({ '笔记.md': t('remote\n') });
    await expect(connect(remote)).rejects.toThrow('冲突');
    const [conflict] = await conflicts();
    expect(conflict).toMatchObject({
      base: t('base\n'),
      local: t('local\n'),
      remote: t('remote\n'),
      type: 'text',
    });
    expect(remote.prepared).toHaveLength(0);
    await saveConflictDraft(conflict.id, '草稿\n');
    db.close();
    await db.open();
    expect((await conflicts())[0].draft).toBe('草稿\n');
    await resolveConflict(conflict.id, { choice: 'manual', text: 'merged\n' });
    await connect(remote);
    expect(remote.content('笔记.md')).toEqual(t('merged\n'));
    expect(await conflicts()).toHaveLength(0);
  });
  it('requires explicit same-name add/add and delete/modify choices', async () => {
    const remote = new MockRemote();
    await connect(remote);
    await saveText(workspace.id, '笔记.md', 'local');
    remote.advance({ '笔记.md': t('remote') });
    await expect(connect(remote)).rejects.toThrow('冲突');
    let [conflict] = await conflicts();
    expect(conflict.type).toBe('add-add');
    await resolveConflict(conflict.id, { choice: 'both', path: 'GitHub 副本.md' });
    await connect(remote);
    expect(remote.content('笔记.md')).toEqual(t('local'));
    expect(remote.content('GitHub 副本.md')).toEqual(t('remote'));
    await deleteFile(workspace.id, '笔记.md');
    remote.advance({ '笔记.md': t('changed') });
    await expect(connect(remote)).rejects.toThrow('冲突');
    [conflict] = await conflicts();
    expect(conflict.type).toBe('delete-modify');
    await resolveConflict(conflict.id, { choice: 'local' });
    await connect(remote);
    expect(remote.content('笔记.md')).toBeNull();
  });
  it('never text-merges a binary conflict and supports keeping both', async () => {
    const remote = new MockRemote({ '图片.png': { kind: 'binary', sha: 'base' } });
    await connect(remote);
    await saveBinary(workspace.id, '图片.png', new Blob(['local-image']));
    remote.advance({ '图片.png': { kind: 'binary', sha: 'remote-image' } });
    await expect(connect(remote)).rejects.toThrow('冲突');
    const [conflict] = await conflicts();
    expect(conflict.type).toBe('binary');
    await expect(resolveConflict(conflict.id, { choice: 'manual', text: 'bad' })).rejects.toThrow(
      '附件',
    );
    await resolveConflict(conflict.id, { choice: 'both', path: '远端.png' });
    await connect(remote);
    expect(remote.content('远端.png')).toEqual({ kind: 'binary', sha: 'remote-image' });
  });
  it('atomically commits a rename, deletion and edit, leaving unsupported tree entries intact', async () => {
    const remote = new MockRemote({
      'old.md': t('one'),
      'edit.md': t('old'),
      'gone.md': t('remove'),
    });
    await connect(remote);
    await renameFile(workspace.id, 'old.md', '新名字.md');
    await saveText(workspace.id, 'edit.md', 'new');
    await deleteFile(workspace.id, 'gone.md');
    await connect(remote);
    expect(remote.prepared).toHaveLength(1);
    expect(Object.keys(remote.prepared[0].changes).sort()).toEqual([
      'edit.md',
      'gone.md',
      'old.md',
      '新名字.md',
    ]);
    expect((await remote.readSnapshot(remote.head)).preservedPaths).toEqual([
      '.obsidian/workspace.json',
      'board.canvas',
    ]);
    expect(remote.content('old.md')).toBeNull();
    expect(remote.content('新名字.md')).toEqual(t('one'));
  });
  it('surfaces rename crossing a remote edit as delete/modify rather than silently deleting', async () => {
    const remote = new MockRemote({ '笔记.md': t('base') });
    await connect(remote);
    await renameFile(workspace.id, '笔记.md', 'renamed.md');
    remote.advance({ '笔记.md': t('remote edit') });
    await expect(connect(remote)).rejects.toThrow('冲突');
    expect((await conflicts())[0]).toMatchObject({
      type: 'delete-modify',
      relatedPaths: ['renamed.md'],
    });
    expect(remote.content('笔记.md')).toEqual(t('remote edit'));
  });
  it('retries a rejected non-fast-forward against the new remote head', async () => {
    const remote = new MockRemote({ '笔记.md': t('a\n\nb\n\nc\n') });
    await connect(remote);
    await saveText(workspace.id, '笔记.md', 'L\n\nb\n\nc\n');
    remote.onPrepare = async () => {
      remote.onPrepare = undefined;
      remote.advance({ '笔记.md': t('a\n\nb\n\nR\n') });
    };
    await connect(remote);
    expect(remote.content('笔记.md')).toEqual(t('L\n\nb\n\nR\n'));
    expect(remote.prepared).toHaveLength(2);
  });
  it('preserves edits typed after the captured revision while acknowledging only submitted content', async () => {
    const remote = new MockRemote({ '笔记.md': t('base') });
    await connect(remote);
    await saveText(workspace.id, '笔记.md', 'captured');
    remote.onPrepare = async () => {
      await saveText(workspace.id, '笔记.md', 'newest typed');
    };
    await connect(remote);
    expect(remote.content('笔记.md')).toEqual(t('captured'));
    expect(await file()).toMatchObject({
      base: t('captured'),
      current: t('newest typed'),
      dirty: true,
      revision: 2,
    });
  });
  it('rejects duplicate sync requests across the shared lock and fails safely without Web Locks', async () => {
    const remote = new MockRemote({ '笔记.md': t('base') });
    await connect(remote);
    await saveText(workspace.id, '笔记.md', 'edit');
    let release!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    remote.onPrepare = async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const first = connect(remote);
    await reached;
    await expect(connect(remote)).rejects.toThrow('同步');
    release();
    await first;
    expect(remote.prepared).toHaveLength(1);
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
    await expect(connect(remote)).rejects.toThrow('锁');
  });
  it('confirms a timed-out accepted commit without creating a duplicate', async () => {
    const remote = new MockRemote({ '笔记.md': t('base') });
    await connect(remote);
    await saveText(workspace.id, '笔记.md', 'edit');
    remote.timeoutAfterAccept = true;
    await connect(remote);
    await connect(remote);
    expect(remote.prepared).toHaveLength(1);
    expect((await file())?.dirty).toBe(false);
  });
  it('recovers after remote acceptance and a crash/failure before local acknowledgment', async () => {
    const remote = new MockRemote({ '笔记.md': t('base') });
    await connect(remote);
    await saveText(workspace.id, '笔记.md', 'edit');
    remote.onSnapshot = async (head) => {
      if (head.startsWith('commit')) throw new Error('模拟确认前崩溃');
    };
    await expect(connect(remote)).rejects.toThrow('崩溃');
    expect((await file())?.dirty).toBe(true);
    db.close();
    await db.open();
    remote.onSnapshot = undefined;
    await connect(remote);
    expect(remote.prepared).toHaveLength(1);
    expect((await file())?.dirty).toBe(false);
  });
  it('persists a proposed SHA before updateRef and retries the same commit after permission recovery', async () => {
    const remote = new MockRemote({ '笔记.md': t('base') });
    await connect(remote);
    await saveText(workspace.id, '笔记.md', 'edit');
    remote.onUpdate = async () => {
      const txs = await db.transactions.where('workspaceId').equals(workspace.id).toArray();
      expect(
        txs.some(
          (tx) => tx.proposedCommit === remote.prepared.at(-1)?.commit && tx.phase === 'pushing',
        ),
      ).toBe(true);
    };
    remote.failUpdate = true;
    await expect(connect(remote)).rejects.toThrow('权限');
    expect((await file())?.dirty).toBe(true);
    remote.failUpdate = false;
    await connect(remote);
    expect(remote.prepared).toHaveLength(1);
  });
  it('does not change baseline or treat unread files as deletions on an incomplete snapshot', async () => {
    const remote = new MockRemote({ '笔记.md': t('base') });
    await connect(remote);
    const original = await file();
    remote.failSnapshot = true;
    await expect(connect(remote)).rejects.toThrow('目录树');
    expect(await file()).toEqual(original);
    const initial = await createWorkspace('owner', 'new', 'main');
    await expect(syncWorkspace(initial.id, remote)).rejects.toThrow('目录树');
    expect((await db.workspaces.get(initial.id))?.initialized).toBe(false);
  });
  it('revalidates a selected conflict after remote changes and retains manual draft', async () => {
    const remote = new MockRemote({ '笔记.md': t('base') });
    await connect(remote);
    await saveText(workspace.id, '笔记.md', 'local');
    remote.advance({ '笔记.md': t('remote') });
    await expect(connect(remote)).rejects.toThrow('冲突');
    const [conflict] = await conflicts();
    await resolveConflict(conflict.id, { choice: 'manual', text: 'draft' });
    remote.advance({ 'another.md': t('new head') });
    await expect(connect(remote)).rejects.toThrow('冲突');
    expect((await conflicts())[0]).toMatchObject({
      draft: 'draft',
      resolved: false,
      remoteHead: remote.head,
    });
    expect(remote.prepared).toHaveLength(0);
  });
  it('rejects local changes during conflict editing, keeping the draft for revalidation', async () => {
    const remote = new MockRemote({ '笔记.md': t('base') });
    await connect(remote);
    await saveText(workspace.id, '笔记.md', 'local');
    remote.advance({ '笔记.md': t('remote') });
    await expect(connect(remote)).rejects.toThrow('冲突');
    const [conflict] = await conflicts();
    await saveText(workspace.id, '笔记.md', 'new local');
    await expect(resolveConflict(conflict.id, { choice: 'manual', text: 'draft' })).rejects.toThrow(
      '再次修改',
    );
    await expect(connect(remote)).rejects.toThrow('冲突');
    expect((await conflicts())[0]).toMatchObject({
      local: t('new local'),
      draft: 'draft',
      resolved: false,
    });
  });
  it('refuses rewritten history, preserves local copy and supports explicit safe baseline recovery', async () => {
    const remote = new MockRemote({ '笔记.md': t('base') });
    await connect(remote);
    await saveText(workspace.id, '笔记.md', 'local');
    remote.rewrite({ '笔记.md': t('rewritten') });
    await expect(connect(remote)).rejects.toThrow('历史');
    expect((await file())?.current).toEqual(t('local'));
    expect(remote.prepared).toHaveLength(0);
    await recoverBaseline(workspace.id);
    await expect(connect(remote)).rejects.toThrow('冲突');
    expect((await conflicts())[0].type).toBe('add-add');
  });
  it('keeps attachment cache out of local edits and refuses a corrupt download', async () => {
    const blob = new Blob(['image']);
    const sha = await gitBlobSha(blob);
    const remote = new MockRemote({ 'image.png': { kind: 'binary', sha } });
    await connect(remote);
    const original = await file('image.png');
    await cacheAttachment(workspace.id, 'image.png', blob, sha);
    expect((await file('image.png'))?.revision).toBe(original?.revision);
    expect((await file('image.png'))?.dirty).toBe(false);
    await connect(remote);
    const cached = (await file('image.png'))?.current;
    expect(cached?.kind === 'binary' && (await cached.blob?.text())).toBe('image');
    await expect(
      cacheAttachment(workspace.id, 'image.png', new Blob(['corrupted']), sha),
    ).rejects.toThrow('不完整');
  });
  it('rejects a snapshot which omits an advertised supported blob', async () => {
    const remote = new MockRemote({ '笔记.md': t('base') });
    await connect(remote);
    const original = await file();
    const read = remote.readSnapshot.bind(remote);
    remote.readSnapshot = async (head) => {
      const snapshot = await read(head);
      delete snapshot.files['笔记.md'];
      return snapshot;
    };
    await expect(connect(remote)).rejects.toThrow('快照不完整');
    expect(await file()).toEqual(original);
  });
  it('fails a truly raced ref update, then recomputes instead of forcing', async () => {
    const remote = new MockRemote({ '笔记.md': t('base'), 'other.md': t('old') });
    await connect(remote);
    await saveText(workspace.id, '笔记.md', 'local');
    remote.onUpdate = async () => {
      remote.onUpdate = undefined;
      remote.advance({ 'other.md': t('new') });
    };
    await connect(remote);
    expect(remote.updates).toBe(2);
    expect(remote.content('笔记.md')).toEqual(t('local'));
    expect(remote.content('other.md')).toEqual(t('new'));
  });
  it('bounds concurrent remote retries and keeps unsent local changes', async () => {
    const remote = new MockRemote({ '笔记.md': t('base') });
    await connect(remote);
    await saveText(workspace.id, '笔记.md', 'local');
    let index = 0;
    remote.onPrepare = async () => {
      remote.advance({ 'other.md': t(String(++index)) });
    };
    await expect(connect(remote)).rejects.toThrow('连续');
    expect(remote.prepared).toHaveLength(3);
    expect((await file())?.dirty).toBe(true);
    expect(remote.content('笔记.md')).toEqual(t('base'));
  });
  it('uses ancestry to recover an accepted commit after another device has already advanced', async () => {
    const remote = new MockRemote({ '笔记.md': t('base') });
    await connect(remote);
    await saveText(workspace.id, '笔记.md', 'local');
    remote.onSnapshot = async (head) => {
      if (head.startsWith('commit')) throw new Error('crash');
    };
    await expect(connect(remote)).rejects.toThrow('crash');
    remote.advance({ 'other.md': t('next device') });
    remote.onSnapshot = undefined;
    await connect(remote);
    expect(remote.prepared).toHaveLength(1);
    expect((await file('other.md'))?.current).toEqual(t('next device'));
  });
  it('invalidates a prepared conflict choice if local content changes before upload', async () => {
    const remote = new MockRemote({ '笔记.md': t('base') });
    await connect(remote);
    await saveText(workspace.id, '笔记.md', 'local');
    remote.advance({ '笔记.md': t('remote') });
    await expect(connect(remote)).rejects.toThrow('冲突');
    const [conflict] = await conflicts();
    await resolveConflict(conflict.id, { choice: 'manual', text: 'draft' });
    remote.onPrepare = async () => {
      remote.onPrepare = undefined;
      await saveText(workspace.id, '笔记.md', 'new local');
    };
    await expect(connect(remote)).rejects.toThrow('冲突');
    expect(remote.updates).toBe(0);
    expect((await conflicts())[0]).toMatchObject({
      draft: 'draft',
      local: t('new local'),
      resolved: false,
    });
  });
  it('does not acknowledge data if the local atomic write fails after an accepted commit', async () => {
    const remote = new MockRemote({ '笔记.md': t('base') });
    await connect(remote);
    await saveText(workspace.id, '笔记.md', 'local');
    const write = vi
      .spyOn(db.files, 'bulkPut')
      .mockRejectedValueOnce(new Error('QuotaExceededError'));
    await expect(connect(remote)).rejects.toThrow('QuotaExceededError');
    write.mockRestore();
    expect((await file())?.dirty).toBe(true);
    expect((await file())?.base).toEqual(t('base'));
    await connect(remote);
    expect((await file())?.dirty).toBe(false);
    expect(remote.prepared).toHaveLength(1);
  });
  it('refuses missing common-base metadata instead of guessing', async () => {
    const remote = new MockRemote({ '笔记.md': t('base') });
    await connect(remote);
    await db.files.update([workspace.id, '笔记.md'], { base: null });
    await expect(connect(remote)).rejects.toThrow('基准缺失');
    expect(remote.prepared).toHaveLength(0);
  });
  it('applies remote deletion only when the local file still matches the captured revision', async () => {
    const remote = new MockRemote({ '笔记.md': t('base') });
    await connect(remote);
    remote.advance({ '笔记.md': null });
    remote.onSnapshot = async () => {
      remote.onSnapshot = undefined;
      await saveText(workspace.id, '笔记.md', 'typed during pull');
    };
    await expect(connect(remote)).rejects.toThrow('同步期间的新编辑');
    expect(await file()).toMatchObject({
      base: null,
      current: t('typed during pull'),
      dirty: true,
    });
  });
  it('rebases later edits onto an automatically merged commit so the next sync retains remote lines', async () => {
    const remote = new MockRemote({ '笔记.md': t('first\n\nsecond\n\nthird\n\nfourth\n') });
    await connect(remote);
    await saveText(workspace.id, '笔记.md', 'LOCAL\n\nsecond\n\nthird\n\nfourth\n');
    remote.advance({ '笔记.md': t('first\n\nsecond\n\nthird\n\nREMOTE\n') });
    remote.onPrepare = async () => {
      remote.onPrepare = undefined;
      await saveText(workspace.id, '笔记.md', 'LOCAL\n\nLATER\n\nthird\n\nfourth\n');
    };
    await connect(remote);
    expect(await file()).toMatchObject({
      base: t('LOCAL\n\nsecond\n\nthird\n\nREMOTE\n'),
      current: t('LOCAL\n\nLATER\n\nthird\n\nREMOTE\n'),
      dirty: true,
    });
    await connect(remote);
    expect(remote.content('笔记.md')).toEqual(t('LOCAL\n\nLATER\n\nthird\n\nREMOTE\n'));
  });
  it('persists overlapping post-capture edits as a rebase conflict and resolves without stale-choice loops', async () => {
    const remote = new MockRemote({ '笔记.md': t('first\n\nsecond\n\nthird\n') });
    await connect(remote);
    await saveText(workspace.id, '笔记.md', 'LOCAL\n\nsecond\n\nthird\n');
    remote.advance({ '笔记.md': t('first\n\nsecond\n\nREMOTE\n') });
    remote.onPrepare = async () => {
      remote.onPrepare = undefined;
      await saveText(workspace.id, '笔记.md', 'LOCAL\n\nsecond\n\nLATER\n');
    };
    await expect(connect(remote)).rejects.toThrow('同步期间的新编辑');
    const [conflict] = await conflicts();
    expect(conflict).toMatchObject({
      rebase: true,
      base: t('LOCAL\n\nsecond\n\nthird\n'),
      local: t('LOCAL\n\nsecond\n\nLATER\n'),
      remote: t('LOCAL\n\nsecond\n\nREMOTE\n'),
    });
    expect((await file())?.base).toEqual(conflict.remote);
    db.close();
    await db.open();
    await resolveConflict(conflict.id, {
      choice: 'manual',
      text: 'LOCAL\n\nsecond\n\nLATER + REMOTE\n',
    });
    await connect(remote);
    expect(await conflicts()).toHaveLength(0);
    expect(remote.content('笔记.md')).toEqual(t('LOCAL\n\nsecond\n\nLATER + REMOTE\n'));
  });
  it('allows a keep-both copy name to reuse a deleted local tombstone', async () => {
    const remote = new MockRemote({ '笔记.md': t('base') });
    await connect(remote);
    await saveText(workspace.id, 'copy.md', 'temporary');
    await deleteFile(workspace.id, 'copy.md');
    await saveText(workspace.id, '笔记.md', 'local');
    remote.advance({ '笔记.md': t('remote') });
    await expect(connect(remote)).rejects.toThrow('冲突');
    const [conflict] = await conflicts();
    await resolveConflict(conflict.id, { choice: 'both', path: 'copy.md' });
    await connect(remote);
    expect(remote.content('copy.md')).toEqual(t('remote'));
  });
  it('bounds confirmed full-vault transaction snapshots without pruning unresolved conflict recovery data', async () => {
    const remote = new MockRemote({ '笔记.md': t('base') });
    for (let index = 0; index < 8; index++) await connect(remote);
    expect(await db.transactions.where('workspaceId').equals(workspace.id).count()).toBe(3);
    await saveText(workspace.id, '笔记.md', 'local');
    remote.advance({ '笔记.md': t('remote') });
    await expect(connect(remote)).rejects.toThrow('冲突');
    const saved = (await db.transactions.where('workspaceId').equals(workspace.id).toArray()).find(
      (tx) => tx.phase === 'conflicts',
    );
    expect(saved?.captured[0].current).toEqual(t('local'));
  });
  it('retains late same-name creations as add/add conflicts rather than uploading an overwrite next time', async () => {
    const remote = new MockRemote();
    await connect(remote);
    remote.advance({ 'new.md': t('remote created') });
    remote.onSnapshot = async () => {
      remote.onSnapshot = undefined;
      await saveText(workspace.id, 'new.md', 'local created');
    };
    await expect(connect(remote)).rejects.toThrow('同步期间的新编辑');
    expect((await conflicts())[0]).toMatchObject({
      type: 'add-add',
      rebase: true,
      base: null,
      local: t('local created'),
      remote: t('remote created'),
    });
    await expect(connect(remote)).rejects.toThrow('冲突');
    expect(remote.prepared).toHaveLength(0);
  });
  it('retains a deletion made during a remote merge as delete/modify until explicitly selected', async () => {
    const remote = new MockRemote({ '笔记.md': t('first\n\nsecond\n\nthird\n') });
    await connect(remote);
    await saveText(workspace.id, '笔记.md', 'LOCAL\n\nsecond\n\nthird\n');
    remote.advance({ '笔记.md': t('first\n\nsecond\n\nREMOTE\n') });
    remote.onPrepare = async () => {
      remote.onPrepare = undefined;
      await deleteFile(workspace.id, '笔记.md');
    };
    await expect(connect(remote)).rejects.toThrow('同步期间的新编辑');
    const [conflict] = await conflicts();
    expect(conflict).toMatchObject({ type: 'delete-modify', rebase: true, local: null });
    await resolveConflict(conflict.id, { choice: 'remote' });
    await connect(remote);
    expect((await file())?.current).toEqual(t('LOCAL\n\nsecond\n\nREMOTE\n'));
  });
  it('rejects an uninitialized workspace that already contains an unlocatable baseline', async () => {
    const remote = new MockRemote({ '笔记.md': t('base') });
    await connect(remote);
    await db.workspaces.update(workspace.id, { head: null, initialized: false });
    await expect(connect(remote)).rejects.toThrow('无法定位提交');
    expect(remote.prepared).toHaveLength(0);
  });
  it('lists candidate additions for remote rename versus local edit without claiming a pairing', async () => {
    const remote = new MockRemote({ '笔记.md': t('base') });
    await connect(remote);
    await saveText(workspace.id, '笔记.md', 'local edit');
    remote.advance({ '笔记.md': null, 'new-a.md': t('base'), 'new-b.md': t('unrelated addition') });
    await expect(connect(remote)).rejects.toThrow('冲突');
    expect((await conflicts())[0]).toMatchObject({
      type: 'delete-modify',
      remote: null,
      relatedPaths: ['new-a.md', 'new-b.md'],
    });
    expect(remote.prepared).toHaveLength(0);
    expect((await file())?.current).toEqual(t('local edit'));
  });
  it('includes a filename created by a late rename in the post-capture deletion conflict', async () => {
    const remote = new MockRemote({ '笔记.md': t('base') });
    await connect(remote);
    remote.advance({ '笔记.md': t('remote edit') });
    remote.onSnapshot = async () => {
      remote.onSnapshot = undefined;
      await renameFile(workspace.id, '笔记.md', 'late-rename.md');
    };
    await expect(connect(remote)).rejects.toThrow('同步期间的新编辑');
    expect((await conflicts())[0]).toMatchObject({
      type: 'delete-modify',
      rebase: true,
      relatedPaths: ['late-rename.md'],
    });
    expect((await file('late-rename.md'))?.current).toEqual(t('base'));
  });
  it('prunes superseded failed-read journals after recovery succeeds', async () => {
    const remote = new MockRemote({ '笔记.md': t('base') });
    await connect(remote);
    await saveText(workspace.id, '笔记.md', 'local edit');
    remote.failSnapshot = true;
    for (let index = 0; index < 8; index++) await expect(connect(remote)).rejects.toThrow('目录树');
    expect(await db.transactions.where('workspaceId').equals(workspace.id).count()).toBeGreaterThan(
      3,
    );
    remote.failSnapshot = false;
    await connect(remote);
    expect(await db.transactions.where('workspaceId').equals(workspace.id).count()).toBe(3);
    expect(remote.content('笔记.md')).toEqual(t('local edit'));
  });
  it('prunes resolved old conflict journals while preserving an updated in-flight draft and proposed commits', async () => {
    const remote = new MockRemote({ '笔记.md': t('base') });
    await connect(remote);
    await saveText(workspace.id, '笔记.md', 'local');
    remote.advance({ '笔记.md': t('remote') });
    for (let index = 0; index < 5; index++) await expect(connect(remote)).rejects.toThrow('冲突');
    const [conflict] = await conflicts();
    await resolveConflict(conflict.id, { choice: 'manual', text: 'selected merge' });
    remote.onUpdate = async () => {
      remote.onUpdate = undefined;
      await saveConflictDraft(conflict.id, 'new in-flight draft');
      // Simulate a separately durable, unconfirmed candidate discovered after the initial
      // pending-journal scan; compaction must never decide its remote result for us.
      await db.transactions.put({
        id: 'unconfirmed-candidate',
        workspaceId: workspace.id,
        phase: 'recovery',
        captured: [],
        proposedCommit: 'unconfirmed-sha',
        createdAt: 1,
      });
    };
    await expect(connect(remote)).rejects.toThrow('冲突');
    expect((await conflicts())[0].draft).toBe('new in-flight draft');
    const journals = await db.transactions.where('workspaceId').equals(workspace.id).toArray();
    expect(journals.filter((tx) => !tx.proposedCommit || tx.phase === 'complete')).toHaveLength(3);
    expect(await db.transactions.get('unconfirmed-candidate')).toMatchObject({
      phase: 'recovery',
      proposedCommit: 'unconfirmed-sha',
    });
  });
});

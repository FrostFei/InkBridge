import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { expect, it } from 'vitest';
import { InkBridgeDatabase } from '../src/core/db';

it('upgrades a version-one database without losing offline notes or recovery state', async () => {
  const name = 'inkbridge-credential-upgrade-test';
  await Dexie.delete(name);
  const legacy = new Dexie(name);
  legacy.version(1).stores({
    workspaces: 'id',
    files: '[workspaceId+path],workspaceId,dirty',
    conflicts: 'id,workspaceId',
    transactions: 'id,workspaceId,phase',
  });
  await legacy.open();
  const records = {
    workspaces: { id: 'test', owner: 'owner', repo: 'notes', branch: 'main' },
    files: {
      workspaceId: 'test',
      path: '笔记.md',
      current: { kind: 'text', text: '未同步内容' },
      revision: 3,
      dirty: true,
    },
    conflicts: { id: 'conflict', workspaceId: 'test', draft: '未提交的合并草稿' },
    transactions: {
      id: 'transaction',
      workspaceId: 'test',
      phase: 'recovery',
      proposedCommit: 'pending-commit',
    },
  };
  for (const [table, record] of Object.entries(records)) await legacy.table(table).put(record);
  legacy.close();
  const upgraded = new InkBridgeDatabase(name);
  try {
    await upgraded.open();
    for (const [table, record] of Object.entries(records))
      expect(await upgraded.table(table).toArray()).toEqual([record]);
    expect(await upgraded.credentials.count()).toBe(0);
    await upgraded.credentials.put({ workspaceId: 'test', token: 'simulated-credential-only' });
    upgraded.close();
    await upgraded.open();
    expect(await upgraded.credentials.count()).toBe(1);
    await upgraded.credentials.delete('test');
    expect(await upgraded.files.count()).toBe(1);
    expect(await upgraded.conflicts.count()).toBe(1);
  } finally {
    await upgraded.delete();
  }
});

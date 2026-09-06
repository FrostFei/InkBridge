import { createHash } from 'node:crypto';
import type { FileValue, GitRemote, RemoteSnapshot } from '../src/core/types';

export const textValue = (text: string): FileValue => ({ kind: 'text', text });
export function valueSha(value: FileValue): string {
  if (value.kind === 'binary') return value.sha;
  const bytes = Buffer.from(value.text);
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** Immutable commits + non-force compare-and-update, with controllable failures/races. */
export class MockRemote implements GitRemote {
  head = 'initial';
  commits = new Map<string, { parent: string | null; files: Record<string, FileValue> }>();
  prepared: { parent: string; changes: Record<string, FileValue | null>; commit: string }[] = [];
  updates = 0;
  preservedPaths = ['.obsidian/workspace.json', 'board.canvas'];
  onPrepare?: () => Promise<void>;
  onUpdate?: () => Promise<void>;
  onSnapshot?: (head: string) => Promise<void>;
  failSnapshot = false;
  failUpdate = false;
  timeoutAfterAccept = false;
  constructor(files: Record<string, FileValue> = {}) {
    this.commits.set(this.head, { parent: null, files: structuredClone(files) });
  }
  async readHead() {
    return this.head;
  }
  async readSnapshot(head: string): Promise<RemoteSnapshot> {
    await this.onSnapshot?.(head);
    if (this.failSnapshot) throw new Error('完整目录树读取失败');
    const commit = this.commits.get(head);
    if (!commit) throw new Error('找不到提交');
    const files = Object.fromEntries(
      Object.entries(commit.files).map(([path, value]) => [
        path,
        { value: structuredClone(value), sha: valueSha(value) },
      ]),
    );
    return {
      head,
      treeSha: `tree-${head}`,
      files,
      entries: [
        ...Object.entries(files).map(([path, f]) => ({
          path,
          sha: f.sha,
          mode: '100644',
          type: 'blob' as const,
        })),
        ...this.preservedPaths.map((path) => ({
          path,
          sha: `preserved-${path}`,
          mode: '100644',
          type: 'blob' as const,
        })),
      ],
      preservedPaths: this.preservedPaths,
    };
  }
  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    let current: string | null = descendant;
    while (current) {
      if (current === ancestor) return true;
      current = this.commits.get(current)?.parent ?? null;
    }
    return false;
  }
  async prepareCommit(head: string, changes: Record<string, FileValue | null>): Promise<string> {
    const original = this.commits.get(head);
    if (!original) throw new Error('找不到父提交');
    const files = structuredClone(original.files);
    for (const [path, value] of Object.entries(changes)) {
      if (value === null) delete files[path];
      else files[path] = structuredClone(value);
    }
    const commit = `commit-${this.commits.size}`;
    this.commits.set(commit, { parent: head, files });
    this.prepared.push({ parent: head, changes: structuredClone(changes), commit });
    await this.onPrepare?.();
    return commit;
  }
  async updateRef(commit: string): Promise<void> {
    this.updates++;
    await this.onUpdate?.();
    if (this.failUpdate) throw new Error('403 权限不足');
    if (this.commits.get(commit)?.parent !== this.head) throw new Error('422 非快进更新');
    this.head = commit;
    if (this.timeoutAfterAccept) throw new Error('网络超时');
  }
  async downloadBlob(sha: string) {
    return new Blob([sha]);
  }
  advance(changes: Record<string, FileValue | null>): string {
    const files = structuredClone(this.commits.get(this.head)!.files);
    for (const [path, value] of Object.entries(changes))
      if (value === null) delete files[path];
      else files[path] = value;
    const commit = `external-${this.commits.size}`;
    this.commits.set(commit, { parent: this.head, files });
    this.head = commit;
    return commit;
  }
  rewrite(files: Record<string, FileValue>) {
    const commit = `rewrite-${this.commits.size}`;
    this.commits.set(commit, { parent: null, files });
    this.head = commit;
  }
  content(path: string) {
    return this.commits.get(this.head)!.files[path] ?? null;
  }
}

export function installMockLocks() {
  const held = new Set<string>();
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      locks: {
        request: async (
          name: string,
          _options: unknown,
          callback: (lock: { name: string } | null) => Promise<void>,
        ) => {
          if (held.has(name)) return callback(null);
          held.add(name);
          try {
            return await callback({ name });
          } finally {
            held.delete(name);
          }
        },
      },
    },
  });
}

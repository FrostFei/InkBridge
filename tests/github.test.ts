import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { GitHubClient, GitHubError } from '../src/github/client';
import type { GitHubBlobCache } from '../src/github/client';
import type { TreeEntry } from '../src/core/types';

const TOKEN = 'github_pat_test_fixture_only_not_a_real_credential';
const H = '1'.repeat(40),
  H2 = '2'.repeat(40),
  T = 'a'.repeat(40),
  T2 = 'b'.repeat(40),
  SUB = 'c'.repeat(40);
const prefix = '/repos/test-owner/notes';
const gitSha = (content: string | Uint8Array): string => {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
};
const entry = (path: string, content = '', mode = '100644'): TreeEntry => ({
  path,
  sha: gitSha(content),
  mode,
  type: 'blob',
  size: Buffer.byteLength(content),
});
const directory = (path: string, treeSha = SUB): TreeEntry => ({
  path,
  sha: treeSha,
  mode: '040000',
  type: 'tree',
});
const treeResponse = (tree: TreeEntry[], treeSha = T, truncated = false) => ({
  sha: treeSha,
  truncated,
  tree,
});
const blobResponse = (content: string | Uint8Array, declaredSha = gitSha(content)) => {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
  return {
    sha: declaredSha,
    encoding: 'base64',
    content: bytes.toString('base64'),
    size: bytes.length,
  };
};
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers });
type Request = {
  url: URL;
  path: string;
  init: RequestInit;
  body: Record<string, unknown> | undefined;
};
function mockFetch(route: (request: Request) => Response | Promise<Response>) {
  const calls: Request[] = [];
  const mock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const request = {
      url: parsed,
      path: parsed.pathname.replace(prefix, '') + parsed.search,
      init: init ?? {},
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    };
    calls.push(request);
    return route(request);
  });
  vi.stubGlobal('fetch', mock);
  return { calls, mock };
}
const client = (options: { branch?: string; cache?: GitHubBlobCache; timeoutMs?: number } = {}) =>
  new GitHubClient({
    owner: 'test-owner',
    repo: 'notes',
    branch: 'main',
    token: TOKEN,
    ...options,
  });
function snapshotRoutes(entries: TreeEntry[], contents: Record<string, string | Uint8Array> = {}) {
  return (request: Request) => {
    if (request.path === `/git/commits/${H}`) return json({ sha: H, tree: { sha: T } });
    if (request.path === `/git/trees/${T}?recursive=1`) return json(treeResponse(entries));
    const content = contents[request.path.replace('/git/blobs/', '')];
    if (content !== undefined) return json(blobResponse(content));
    throw new Error(`Unexpected request ${request.path}`);
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('GitHub connection and session-only credentials', () => {
  it('validates fine-grained token shape and repository input before any network request', () => {
    expect(
      () =>
        new GitHubClient({ owner: 'owner', repo: 'repo', branch: 'main', token: 'ghp_classic' }),
    ).toThrow('细粒度');
    expect(
      () =>
        new GitHubClient({ owner: 'owner/another', repo: 'repo', branch: 'main', token: TOKEN }),
    ).toThrow('格式无效');
    expect(() => client({ branch: 'bad..branch' })).toThrow('格式无效');
    expect(() => client({ branch: 'feature/中文#test' })).not.toThrow();
  });

  it('puts token only in Authorization and never in serialization, URL, cookies or caches', async () => {
    const { calls } = mockFetch(() =>
      json({ full_name: 'test-owner/notes', permissions: { push: true } }),
    );
    const api = client();
    await api.validateRepository();
    expect(JSON.stringify(api)).not.toContain(TOKEN);
    expect(calls[0].url.href).not.toContain(TOKEN);
    expect(calls[0].init).toMatchObject({
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    expect(new Headers(calls[0].init.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(new Headers(calls[0].init.headers).get('X-GitHub-Api-Version')).toBe('2026-03-10');
  });

  it.each([{ archived: true }, { disabled: true }, { permissions: { push: false } }])(
    'rejects an unwritable repository %j',
    async (extra) => {
      mockFetch(() => json({ full_name: 'test-owner/notes', ...extra }));
      await expect(client().validateRepository()).rejects.toMatchObject({ code: 'permission' });
    },
  );

  it('lists every page without following an untrusted next link with credentials', async () => {
    const first = Array.from({ length: 100 }, (_, i) => ({ name: `branch-${i}` }));
    const { calls } = mockFetch(({ path }) =>
      path.endsWith('page=1')
        ? json(first, 200, { Link: '<https://evil.example/steal>; rel="next"' })
        : json([{ name: 'feature/中文' }]),
    );
    expect(await client().listBranches()).toEqual([
      ...first.map((item) => item.name),
      'feature/中文',
    ]);
    expect(calls.map((item) => item.url.host)).toEqual(['api.github.com', 'api.github.com']);
    expect(calls[1].path).toBe('/branches?per_page=100&page=2');
  });

  it('fails closed when branch pages overlap and rejects empty repositories', async () => {
    let { mock } = mockFetch(() => json([]));
    await expect(client().listBranches()).rejects.toMatchObject({ code: 'not-found' });
    expect(mock).toHaveBeenCalledTimes(1);
    ({ mock } = mockFetch(() =>
      json([{ name: 'main' }], 200, { Link: '<https://api.github.com/next>; rel="next"' }),
    ));
    await expect(client().listBranches()).rejects.toMatchObject({ code: 'invalid-response' });
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('encodes Chinese/special branch components and matches the exact ref', async () => {
    const branch = 'feature/中文#iPad';
    const { calls } = mockFetch(() =>
      json({ ref: `refs/heads/${branch}`, object: { type: 'commit', sha: H } }),
    );
    expect(await client({ branch }).readHead()).toBe(H);
    expect(calls[0].path).toBe(`/git/ref/heads/feature/${encodeURIComponent('中文#iPad')}`);
    mockFetch(() => json({ ref: 'refs/heads/feature-other', object: { type: 'commit', sha: H } }));
    await expect(client({ branch }).readHead()).rejects.toMatchObject({ code: 'invalid-response' });
  });
});

describe('complete immutable snapshots', () => {
  it('downloads all supported Markdown exactly, including BOM, CRLF, Unicode and case', async () => {
    const text = '\ufeff---\r\n标题: 墨桥\r\n---\r\n中文 😀\r\n';
    const path = '中文 空格/笔记 #100%.MD';
    const plain = 'different case\n';
    const entries = [
      directory('中文 空格'),
      entry(path, text),
      entry('note.md', plain),
      entry('Note.md', ''),
    ];
    const { calls } = mockFetch(
      snapshotRoutes(entries, { [gitSha(text)]: text, [gitSha(plain)]: plain, [gitSha('')]: '' }),
    );
    const progress = vi.fn();
    const snapshot = await client().readSnapshot(H, progress);
    expect(snapshot.files[path].value).toEqual({ kind: 'text', text });
    expect(Object.keys(snapshot.files)).toEqual([path, 'note.md', 'Note.md']);
    expect(snapshot.entries).toEqual(entries);
    expect(snapshot.preservedPaths).toEqual([]);
    expect(calls.filter((item) => item.path.startsWith('/git/blobs/'))).toHaveLength(3);
    expect(progress).toHaveBeenLastCalledWith('全部 3 篇笔记已下载；0 项附件按需下载。');
  });

  it('keeps binary attachments by SHA and preserves unsupported/hidden/symlink/submodule entries', async () => {
    const entries = [
      entry('附件 图.png', 'binary'),
      directory('.obsidian'),
      entry('.obsidian/workspace.json', '{}'),
      entry('board.canvas', '{}'),
      entry('alias.md', 'real.md', '120000'),
      { path: 'plugins.md', sha: H2, type: 'commit' as const, mode: '160000' },
      entry(' trailing.md', 'private'),
    ];
    const { calls } = mockFetch(snapshotRoutes(entries));
    const snapshot = await client().readSnapshot(H);
    expect(snapshot.files).toEqual({
      '附件 图.png': { value: { kind: 'binary', sha: gitSha('binary') }, sha: gitSha('binary') },
    });
    expect(snapshot.preservedPaths).toEqual([
      '.obsidian/workspace.json',
      'board.canvas',
      'alias.md',
      'plugins.md',
      ' trailing.md',
    ]);
    expect(snapshot.entries).toEqual(entries);
    expect(calls.some((item) => item.path.startsWith('/git/blobs/'))).toBe(false);
  });

  it('discards a truncated recursive listing and traverses every nonrecursive subtree', async () => {
    const text = 'found in fallback';
    const { calls } = mockFetch(({ path }) => {
      if (path === `/git/commits/${H}`) return json({ sha: H, tree: { sha: T } });
      if (path === `/git/trees/${T}?recursive=1`)
        return json(treeResponse([entry('phantom.md')], T, true));
      if (path === `/git/trees/${T}`)
        return json(treeResponse([directory('目录'), directory('.obsidian', T2)]));
      if (path === `/git/trees/${SUB}`) return json(treeResponse([entry('笔记.md', text)], SUB));
      if (path === `/git/trees/${T2}`) return json(treeResponse([entry('config.json', '{}')], T2));
      if (path === `/git/blobs/${gitSha(text)}`) return json(blobResponse(text));
      throw new Error(`Unexpected ${path}`);
    });
    const snapshot = await client().readSnapshot(H);
    expect(Object.keys(snapshot.files)).toEqual(['目录/笔记.md']);
    expect(snapshot.preservedPaths).toEqual(['.obsidian/config.json']);
    expect(calls.some((item) => item.path.includes('recursive=0'))).toBe(false);
    expect(snapshot.entries.some((item) => item.path === 'phantom.md')).toBe(false);
  });

  it('never returns a partial snapshot when even a nonrecursive tree is truncated', async () => {
    mockFetch(({ path }) =>
      path.startsWith('/git/commits/')
        ? json({ sha: H, tree: { sha: T } })
        : json(treeResponse([], T, true)),
    );
    await expect(client().readSnapshot(H)).rejects.toMatchObject({
      code: 'invalid-response',
      message: expect.stringContaining('仍被截断'),
    });
  });

  it.each([
    { sha: T, tree: [] },
    treeResponse([entry('same.md'), entry('same.md')]),
    treeResponse([entry('missing-parent/note.md')]),
    treeResponse([{ ...entry('note.md'), mode: '100000' }]),
    treeResponse([{ ...entry('../note.md') }]),
  ])(
    'rejects malformed trees instead of interpreting missing paths as deletion: %j',
    async (response) => {
      mockFetch(({ path }) =>
        path.startsWith('/git/commits/') ? json({ sha: H, tree: { sha: T } }) : json(response),
      );
      await expect(client().readSnapshot(H)).rejects.toMatchObject({ code: 'invalid-response' });
    },
  );

  it('does not return earlier successful files if a later blob fails', async () => {
    const first = entry('first.md', 'ok'),
      second = entry('second.md', 'later');
    const good = snapshotRoutes([first, second], { [first.sha]: 'ok' });
    mockFetch((request) =>
      request.path === `/git/blobs/${second.sha}`
        ? json({ message: 'not found' }, 404)
        : good(request),
    );
    await expect(client().readSnapshot(H)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects invalid UTF-8 Markdown without replacement characters', async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x61, 0x00]);
    mockFetch(
      snapshotRoutes([{ ...entry('utf16.md'), sha: gitSha(bytes), size: bytes.length }], {
        [gitSha(bytes)]: bytes,
      }),
    );
    await expect(client().readSnapshot(H)).rejects.toMatchObject({
      message: expect.stringContaining('非 UTF-8'),
    });
  });

  it('uses verified SHA cache to resume interrupted downloads with a new client', async () => {
    const stored = new Map<string, Blob>();
    const cache: GitHubBlobCache = {
      get: async (key) => stored.get(key),
      put: async (key, blob) => {
        stored.set(key, blob);
      },
    };
    const entries = [entry('a.md', 'first'), entry('b.md', 'second')];
    let failSecond = true;
    const read = snapshotRoutes(entries, {
      [gitSha('first')]: 'first',
      [gitSha('second')]: 'second',
    });
    const { calls } = mockFetch((request) =>
      request.path === `/git/blobs/${gitSha('second')}` && failSecond
        ? json({}, 503)
        : read(request),
    );
    await expect(client({ cache }).readSnapshot(H)).rejects.toMatchObject({ code: 'network' });
    expect(stored.has(gitSha('first'))).toBe(true);
    failSecond = false;
    const snapshot = await client({ cache }).readSnapshot(H);
    expect(Object.keys(snapshot.files)).toHaveLength(2);
    expect(calls.filter((item) => item.path === `/git/blobs/${gitSha('first')}`)).toHaveLength(1);
  });

  it('fails closed on corrupt cache or cache persistence failure', async () => {
    const cache: GitHubBlobCache = { get: async () => new Blob(['wrong']), put: vi.fn() };
    const { mock } = mockFetch(() => json(blobResponse('correct')));
    await expect(client({ cache }).downloadBlob(gitSha('correct'))).rejects.toMatchObject({
      message: expect.stringContaining('SHA 不符'),
    });
    expect(mock).not.toHaveBeenCalled();
    const broken: GitHubBlobCache = {
      get: async () => undefined,
      put: async () => {
        throw new Error(TOKEN);
      },
    };
    await expect(client({ cache: broken }).downloadBlob(gitSha('correct'))).rejects.toMatchObject({
      message: expect.stringContaining('存储空间'),
    });
  });
});

describe('atomic commit preparation', () => {
  it('uses one complete base tree, preserves modes and submits multiple changes in a single commit', async () => {
    const original = [
      entry('old.md', 'old'),
      entry('script.md', 'before', '100755'),
      directory('.obsidian'),
      entry('.obsidian/workspace.json', '{}'),
      entry('board.canvas', '{}'),
      entry('link.md', 'old.md', '120000'),
    ];
    const read = snapshotRoutes(original);
    const newText = '\ufeff中文\r\nno final newline';
    const bytes = new Uint8Array([0, 255, 128, 10]);
    const { calls } = mockFetch((request) => {
      if (request.init.method === 'POST' && request.path === '/git/blobs') {
        return json({ sha: gitSha(Buffer.from(request.body!.content as string, 'base64')) }, 201);
      }
      if (request.path === '/git/trees') return json({ sha: T2 }, 201);
      if (request.path === '/git/commits') return json({ sha: H2 }, 201);
      return read(request);
    });
    const prepared = await client().prepareCommit(
      H,
      {
        'old.md': null,
        '中文 空格/new #%.md': { kind: 'text', text: newText },
        'script.md': { kind: 'text', text: 'after' },
        '图片.png': { kind: 'binary', sha: 'local', blob: new Blob([bytes]) },
      },
      'InkBridge sync',
    );
    expect(prepared).toBe(H2);
    const postedTree = calls.find((item) => item.path === '/git/trees')!.body!;
    expect(postedTree.base_tree).toBe(T);
    expect(postedTree.tree).toEqual([
      { path: 'old.md', mode: '100644', type: 'blob', sha: null },
      { path: '中文 空格/new #%.md', mode: '100644', type: 'blob', sha: gitSha(newText) },
      { path: 'script.md', mode: '100755', type: 'blob', sha: gitSha('after') },
      { path: '图片.png', mode: '100644', type: 'blob', sha: gitSha(bytes) },
    ]);
    expect(calls.filter((item) => item.path === '/git/commits')).toHaveLength(1);
    expect(calls.find((item) => item.path === '/git/commits')!.body).toEqual({
      message: 'InkBridge sync',
      tree: T2,
      parents: [H],
    });
    expect(calls.some((item) => item.init.method === 'PATCH')).toBe(false);
  });

  it('reuses existing remote binary blobs without downloading or uploading bytes', async () => {
    const read = snapshotRoutes([entry('old.png', 'bytes')]);
    const { calls } = mockFetch((request) =>
      request.path === '/git/trees'
        ? json({ sha: T2 })
        : request.path === '/git/commits'
          ? json({ sha: H2 })
          : read(request),
    );
    expect(
      await client().prepareCommit(
        H,
        { 'old.png': null, 'new.png': { kind: 'binary', sha: gitSha('bytes') } },
        'rename',
      ),
    ).toBe(H2);
    expect(calls.some((item) => item.path.startsWith('/git/blobs'))).toBe(false);
  });

  it('encodes an attachment across multiple Safari-safe chunks without changing bytes', async () => {
    const bytes = Uint8Array.from({ length: 3 * 0x8000 + 7 }, (_, index) => index % 256);
    const read = snapshotRoutes([]);
    const { calls } = mockFetch((request) => {
      if (request.path === '/git/blobs') return json({ sha: gitSha(bytes) });
      if (request.path === '/git/trees') return json({ sha: T2 });
      if (request.path === '/git/commits') return json({ sha: H2 });
      return read(request);
    });
    await client().prepareCommit(
      H,
      { 'large.pdf': { kind: 'binary', sha: 'local', blob: new Blob([bytes]) } },
      'attachment',
    );
    const body = calls.find((item) => item.path === '/git/blobs')!.body!;
    expect(body.encoding).toBe('base64');
    expect(new Uint8Array(Buffer.from(body.content as string, 'base64'))).toEqual(bytes);
  });

  it('rejects an unpaired Unicode surrogate instead of silently changing text bytes', async () => {
    const { calls } = mockFetch(snapshotRoutes([]));
    await expect(
      client().prepareCommit(H, { 'note.md': { kind: 'text', text: '\ud800' } }, 'sync'),
    ).rejects.toMatchObject({ code: 'invalid-input', message: expect.stringContaining('Unicode') });
    expect(calls.every((item) => item.init.method === 'GET')).toBe(true);
  });

  it.each(['link.md', 'module.md', 'folder.md'])(
    'refuses to overwrite preserved object %s',
    async (path) => {
      const entries: TreeEntry[] = [
        entry('link.md', 'target.md', '120000'),
        { path: 'module.md', sha: H2, mode: '160000', type: 'commit' },
        directory('folder.md'),
      ];
      const { calls } = mockFetch(snapshotRoutes(entries));
      await expect(
        client().prepareCommit(H, { [path]: { kind: 'text', text: 'danger' } }, 'sync'),
      ).rejects.toMatchObject({ code: 'invalid-input' });
      expect(calls.every((item) => item.init.method === 'GET')).toBe(true);
    },
  );

  it('refuses path/type collisions before any mutation', async () => {
    const { calls } = mockFetch(snapshotRoutes([entry('parent.md', 'file')]));
    await expect(
      client().prepareCommit(H, { 'parent.md/note.md': { kind: 'text', text: 'text' } }, 'sync'),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(
      client().prepareCommit(H, { 'note.md': { kind: 'binary', sha: H } }, 'sync'),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    expect(calls.every((item) => item.init.method === 'GET')).toBe(true);
  });

  it('does not create an empty commit when contents match or deleted path is already absent', async () => {
    const read = snapshotRoutes([entry('same.md', 'unchanged')]);
    const { calls } = mockFetch((request) =>
      request.path === '/git/blobs' ? json({ sha: gitSha('unchanged') }) : read(request),
    );
    expect(
      await client().prepareCommit(
        H,
        { 'same.md': { kind: 'text', text: 'unchanged' }, 'absent.md': null },
        'empty',
      ),
    ).toBe(H);
    expect(calls.some((item) => ['/git/trees', '/git/commits'].includes(item.path))).toBe(false);
  });

  it('uses explicit force:false for slash branches', async () => {
    const { calls } = mockFetch(() =>
      json({ ref: 'refs/heads/feature/ipad', object: { type: 'commit', sha: H2 } }),
    );
    await client({ branch: 'feature/ipad' }).updateRef(H2);
    expect(calls[0].path).toBe('/git/refs/heads/feature/ipad');
    expect(calls[0].init.method).toBe('PATCH');
    expect(calls[0].body).toEqual({ sha: H2, force: false });
  });
});

describe('Git DAG ancestry and exact binary blobs', () => {
  it('uses compare merge-base evidence, independent of returned commit-list truncation', async () => {
    const { calls } = mockFetch(() =>
      json({
        status: 'ahead',
        base_commit: { sha: H },
        merge_base_commit: { sha: H },
        commits: [],
      }),
    );
    expect(await client().isAncestor(H, H2)).toBe(true);
    expect(calls[0].path).toBe(`/compare/${H}...${H2}?per_page=1`);
    expect(await client().isAncestor(H, H)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it.each(['behind', 'diverged'])('does not claim ancestry for %s history', async (status) => {
    mockFetch(() => json({ status, base_commit: { sha: H } }));
    expect(await client().isAncestor(H, H2)).toBe(false);
  });

  it('does not turn missing ancestry evidence or a network error into a safe-to-push answer', async () => {
    mockFetch(() =>
      json({ status: 'ahead', base_commit: { sha: H }, merge_base_commit: { sha: H2 } }),
    );
    await expect(client().isAncestor(H, H2)).rejects.toMatchObject({ code: 'invalid-response' });
    mockFetch(() => json({ message: 'missing commit' }, 404));
    await expect(client().isAncestor(H, H2)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('proves unrelated rewritten history only after visiting all descendant parents', async () => {
    const merge = '3'.repeat(40),
      left = '4'.repeat(40),
      right = '5'.repeat(40),
      root = '6'.repeat(40);
    const graph: Record<string, string[]> = {
      [merge]: [left, right],
      [left]: [root],
      [right]: [root],
      [root]: [],
    };
    const { calls } = mockFetch(({ path }) => {
      if (path.startsWith('/compare/')) return json({ message: 'No common ancestor' }, 404);
      const key = path.replace('/git/commits/', '');
      return json({ sha: key, parents: graph[key].map((parent) => ({ sha: parent })) });
    });
    expect(await client().isAncestor(H, merge)).toBe(false);
    expect(calls.filter((request) => request.path.startsWith('/git/commits/'))).toHaveLength(4);
    expect(calls.filter((request) => request.path === `/git/commits/${root}`)).toHaveLength(1);
    expect(calls.every((request) => request.init.method === 'GET')).toBe(true);
  });

  it('finds an ancestor on a non-first parent during 404 fallback', async () => {
    mockFetch(({ path }) =>
      path.startsWith('/compare/')
        ? json({}, 404)
        : json({ sha: H2, parents: [{ sha: '3'.repeat(40) }, { sha: H }] }),
    );
    expect(await client().isAncestor(H, H2)).toBe(true);
  });

  it.each([
    { sha: H2 },
    { sha: H, parents: [] },
    { sha: H2, parents: [{ sha: 'invalid' }] },
    { sha: H2, parents: [{ sha: H2 }] },
  ])('rejects incomplete, mismatched or cyclic fallback history %j', async (response) => {
    mockFetch(({ path }) => (path.startsWith('/compare/') ? json({}, 404) : json(response)));
    await expect(client().isAncestor(H, H2)).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('cannot report absent ancestry when any reachable parent is inaccessible', async () => {
    mockFetch(({ path }) =>
      path === `/git/commits/${H2}` ? json({ sha: H2, parents: [{ sha: T }] }) : json({}, 404),
    );
    await expect(client().isAncestor(H, H2)).rejects.toMatchObject({
      code: 'not-found',
      message: expect.stringContaining('未能完整核对'),
    });
  });

  it('bounds 404 fallback to 2000 immutable commit reads and never silently assumes absence', async () => {
    const key = (index: number) => index.toString(16).padStart(40, '0');
    const { calls } = mockFetch(({ path }) => {
      if (path.startsWith('/compare/')) return json({}, 404);
      const current = path.replace('/git/commits/', '');
      return json({ sha: current, parents: [{ sha: key(Number.parseInt(current, 16) + 1) }] });
    });
    await expect(client().isAncestor(H, key(1))).rejects.toMatchObject({
      code: 'invalid-response',
      message: expect.stringContaining('2000'),
    });
    expect(calls.filter((request) => request.path.startsWith('/git/commits/'))).toHaveLength(2000);
  });

  it('decodes line-wrapped base64 binary with exact byte preservation', async () => {
    const bytes = new Uint8Array([0, 255, 13, 10, 128, 1, 3]);
    const data = blobResponse(bytes);
    mockFetch(() =>
      json({ ...data, content: data.content.slice(0, 4) + '\n' + data.content.slice(4) + '\n' }),
    );
    const result = await client().downloadBlob(gitSha(bytes));
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(bytes);
  });

  it.each([
    { ...blobResponse('hello'), size: 900 },
    { ...blobResponse('hello'), content: 'not base64 !!!' },
    { ...blobResponse('hello'), sha: H },
    { ...blobResponse('HELLO'), sha: gitSha('hello') },
  ])('rejects corrupt/mismatched blobs %j', async (response) => {
    mockFetch(() => json(response));
    await expect(client().downloadBlob(gitSha('hello'))).rejects.toMatchObject({
      code: 'invalid-response',
    });
  });
});

describe('safe actionable API errors', () => {
  it.each([
    [401, 'bad credentials', {}, 'authentication'],
    [403, 'resource not accessible by personal access token', {}, 'permission'],
    [
      403,
      'rate limit exceeded',
      { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '2000000000' },
      'rate-limit',
    ],
    [429, 'too many requests', { 'Retry-After': '12' }, 'rate-limit'],
    [404, 'not found', {}, 'not-found'],
    [422, 'protected branch update failed GH006', {}, 'protected-branch'],
    [403, 'commits must have verified signatures; signed commits required', {}, 'protected-branch'],
    [422, 'update is not a fast forward', {}, 'concurrent-update'],
    [409, 'conflict', {}, 'concurrent-update'],
    [500, 'server error', {}, 'network'],
  ] as const)(
    'classifies HTTP %i (%s) and never leaks response details',
    async (status, message, headers, code) => {
      mockFetch(() => json({ message: `${message} ${TOKEN}` }, status, headers));
      const error = await client()
        .updateRef(H2)
        .catch((value) => value as GitHubError);
      expect(error).toBeInstanceOf(GitHubError);
      expect(error).toMatchObject({ code, status });
      expect(String(error)).not.toContain(TOKEN);
      expect(JSON.stringify(error)).not.toContain(TOKEN);
      expect((error as GitHubError).stack).not.toContain(TOKEN);
      if (code === 'rate-limit') expect((error as GitHubError).retryAt).toBeGreaterThan(0);
    },
  );

  it('sanitizes thrown network errors and malformed JSON', async () => {
    mockFetch(() => {
      throw new Error(`Failed request Authorization: ${TOKEN}`);
    });
    const error = await client()
      .readHead()
      .catch((value) => value as GitHubError);
    expect(error).toMatchObject({ code: 'network' });
    expect(String(error)).not.toContain(TOKEN);
    mockFetch(() => new Response(`malformed ${TOKEN}`, { status: 200 }));
    await expect(client().readHead()).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('aborts timed-out requests without retrying a potentially accepted push', async () => {
    vi.useFakeTimers();
    const { mock } = mockFetch(
      ({ init }) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error(TOKEN)));
        }),
    );
    const result = client({ timeoutMs: 20 })
      .updateRef(H2)
      .catch((error) => error as GitHubError);
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toMatchObject({ code: 'network' });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('treats an interrupted response body as an uncertain network failure', async () => {
    const broken = json({});
    broken.json = async () => {
      throw new TypeError(`Body stream failed ${TOKEN}`);
    };
    mockFetch(() => broken);
    const result = await client()
      .updateRef(H2)
      .catch((error) => error as GitHubError);
    expect(result).toMatchObject({ code: 'network' });
    expect(String(result)).not.toContain(TOKEN);
  });
});

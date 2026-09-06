import { createHash } from 'node:crypto';
import type { BrowserContext, Route } from '@playwright/test';

type Entry = { path: string; sha: string; type: 'tree' | 'blob'; mode: string; size?: number };
type Commit = { parent: string | null; tree: string; files: Record<string, string> };
const hash = (text: string | Buffer) => createHash('sha1').update(text).digest('hex');

/** Local protocol simulation. Never performs a request to an actual GitHub account. */
export class MockGitHub {
  blobs = new Map<string, Buffer>();
  trees = new Map<string, Entry[]>();
  commits = new Map<string, Commit>();
  head = '';
  pushes: { sha: string; force: boolean }[] = [];
  failStatus = 0;
  pushRace?: () => void;
  beforeRef?: () => Promise<void>;
  unexpected: string[] = [];
  constructor(
    initial: Record<string, string | Buffer> = {
      '日记/开始.md': '# 我的笔记\n\n原始内容\n',
      '参考/同名.md': '# 参考\n',
      '归档/同名.md': '# 归档\n',
      '.obsidian/workspace.json': '{"preserve":true}',
      '画布.canvas': '{"nodes":[]}',
      '附件/test.pdf': '%PDF-1.7\nmock-binary\n',
    },
  ) {
    this.advance(initial);
  }
  blob(content: string | Buffer) {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const sha = hash(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]));
    this.blobs.set(sha, bytes);
    return sha;
  }
  tree(files: Record<string, string>) {
    const entries: Entry[] = Object.entries(files).map(([path, sha]) => ({
      path,
      sha,
      type: 'blob',
      mode: '100644',
      size: this.blobs.get(sha)!.length,
    }));
    const dirs = new Set<string>();
    for (const path of Object.keys(files)) {
      const parts = path.split('/');
      for (let n = 1; n < parts.length; n++) dirs.add(parts.slice(0, n).join('/'));
    }
    for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
      const children = entries
        .filter((e) => e.path.startsWith(dir + '/') && !e.path.slice(dir.length + 1).includes('/'))
        .map((e) => ({ ...e, path: e.path.slice(dir.length + 1) }));
      const sha = hash(JSON.stringify(children));
      this.trees.set(sha, children);
      entries.push({ path: dir, sha, type: 'tree', mode: '040000' });
    }
    const sha = hash(JSON.stringify(entries));
    this.trees.set(sha, entries);
    return sha;
  }
  advance(changes: Record<string, string | Buffer | null>) {
    const files = { ...(this.commits.get(this.head)?.files ?? {}) };
    for (const [path, value] of Object.entries(changes)) {
      if (value === null) delete files[path];
      else files[path] = this.blob(value);
    }
    const tree = this.tree(files),
      parent = this.head || null;
    this.head = hash(tree + parent + this.commits.size);
    this.commits.set(this.head, { parent, tree, files });
    return this.head;
  }
  text(path: string) {
    const sha = this.commits.get(this.head)!.files[path];
    return sha ? this.blobs.get(sha)!.toString('utf8') : undefined;
  }
  ancestor(base: string, head: string): boolean {
    for (let cur: string | null = head; cur; cur = this.commits.get(cur)?.parent ?? null)
      if (cur === base) return true;
    return false;
  }
  async install(context: BrowserContext) {
    await context.route('https://api.github.com/**', (route) => this.handle(route));
  }
  async handle(route: Route) {
    const request = route.request(),
      url = new URL(request.url());
    const path = decodeURIComponent(url.pathname.replace('/repos/test/notes', ''));
    const method = request.method();
    const respond = (data: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(data),
      });
    if (this.failStatus) return respond({ message: 'simulated service failure' }, this.failStatus);
    if (method === 'GET' && path === '')
      return respond({ full_name: 'test/notes', permissions: { push: true }, archived: false });
    if (method === 'GET' && path === '/branches') return respond([{ name: 'main' }]);
    if (method === 'GET' && path === '/git/ref/heads/main')
      return respond({ ref: 'refs/heads/main', object: { type: 'commit', sha: this.head } });
    if (method === 'GET' && path.startsWith('/git/commits/')) {
      const sha = path.split('/').pop()!,
        commit = this.commits.get(sha);
      return commit
        ? respond({
            sha,
            tree: { sha: commit.tree },
            parents: commit.parent ? [{ sha: commit.parent }] : [],
          })
        : respond({}, 404);
    }
    if (method === 'GET' && path.startsWith('/git/trees/')) {
      const sha = path.split('/').pop()!;
      return respond({ sha, tree: this.trees.get(sha), truncated: false });
    }
    if (method === 'GET' && path.startsWith('/git/blobs/')) {
      const sha = path.split('/').pop()!,
        bytes = this.blobs.get(sha);
      return bytes
        ? respond({
            sha,
            encoding: 'base64',
            content: bytes.toString('base64'),
            size: bytes.length,
          })
        : respond({}, 404);
    }
    if (method === 'GET' && path.startsWith('/compare/')) {
      const [base, head] = path.split('/').pop()!.split('...');
      return respond({
        status:
          base === head
            ? 'identical'
            : this.ancestor(base, head)
              ? 'ahead'
              : this.ancestor(head, base)
                ? 'behind'
                : 'diverged',
        base_commit: { sha: base },
        merge_base_commit: { sha: this.ancestor(base, head) ? base : head },
      });
    }
    const body = request.postDataJSON();
    if (method === 'POST' && path === '/git/blobs')
      return respond(
        {
          sha: this.blob(Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8')),
        },
        201,
      );
    if (method === 'POST' && path === '/git/trees') {
      const entries = this.trees.get(body.base_tree)!;
      const files: Record<string, string> = Object.fromEntries(
        entries.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]),
      );
      for (const item of body.tree) {
        if (item.sha === null) delete files[item.path];
        else files[item.path] = item.sha;
      }
      return respond({ sha: this.tree(files) }, 201);
    }
    if (method === 'POST' && path === '/git/commits') {
      const sha = hash(JSON.stringify(body) + this.commits.size),
        files = Object.fromEntries(
          this.trees
            .get(body.tree)!
            .filter((e) => e.type === 'blob')
            .map((e) => [e.path, e.sha]),
        );
      this.commits.set(sha, { parent: body.parents[0], tree: body.tree, files });
      return respond({ sha }, 201);
    }
    if (method === 'PATCH' && path === '/git/refs/heads/main') {
      if (this.beforeRef) {
        const hook = this.beforeRef;
        this.beforeRef = undefined;
        await hook();
      }
      this.pushRace?.();
      this.pushRace = undefined;
      if (body.force !== false || !this.ancestor(this.head, body.sha))
        return respond({ message: 'Update is not a fast forward' }, 422);
      this.head = body.sha;
      this.pushes.push(body);
      return respond({ ref: 'refs/heads/main', object: { type: 'commit', sha: this.head } });
    }
    this.unexpected.push(`${method} ${path}`);
    return respond({ message: 'Mock route not implemented' }, 500);
  }
}

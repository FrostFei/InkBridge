import { isMarkdown, isSupported, validatePath } from '../core/types';
import type { FileValue, GitRemote, RemoteSnapshot, TreeEntry } from '../core/types';

export type GitHubErrorCode =
  | 'authentication'
  | 'permission'
  | 'not-found'
  | 'rate-limit'
  | 'protected-branch'
  | 'concurrent-update'
  | 'network'
  | 'invalid-response'
  | 'invalid-input';

/** Contains only application-owned messages; GitHub response bodies may contain secrets. */
export class GitHubError extends Error {
  constructor(
    message: string,
    public readonly code: GitHubErrorCode,
    public readonly status?: number,
    public readonly retryAt?: number,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export interface GitHubBlobCache {
  get(sha: string): Promise<Blob | undefined>;
  put(sha: string, blob: Blob): Promise<void>;
}
interface ClientOptions {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  cache?: GitHubBlobCache;
  timeoutMs?: number;
}
type JsonObject = Record<string, unknown>;
type TreeSnapshot = { treeSha: string; entries: TreeEntry[] };
const API = 'https://api.github.com';
const API_VERSION = '2026-03-10';
const SHA = /^[0-9a-f]{40}$/;

function invalid(message = 'GitHub 返回的数据不完整，已停止同步以保护本地文件。'): never {
  throw new GitHubError(message, 'invalid-response');
}
function object(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  return value as JsonObject;
}
function sha(value: unknown): string {
  if (typeof value !== 'string' || !SHA.test(value)) invalid();
  return value;
}
function inputSha(value: string): string {
  if (!SHA.test(value)) throw new GitHubError('Git 对象标识无效，已停止操作。', 'invalid-input');
  return value;
}
function editable(entry: TreeEntry): boolean {
  if (
    entry.type !== 'blob' ||
    !['100644', '100755'].includes(entry.mode) ||
    !isSupported(entry.path)
  )
    return false;
  try {
    validatePath(entry.path);
    return true;
  } catch {
    return false;
  }
}
function encodeBytes(bytes: Uint8Array): string {
  // Bounded chunks avoid argument limits on iPad Safari for large attachments.
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

/** Git Database API only: every push is one commit based on a complete immutable tree. */
export class GitHubClient implements GitRemote {
  #token: string;
  #repoPath: string;
  #branch: string;
  #cache?: GitHubBlobCache;
  #timeoutMs: number;
  #trees = new Map<string, TreeSnapshot>();
  // Successful immutable blob downloads survive a retry within the session.
  #textCache = new Map<string, string>();

  constructor({ owner, repo, branch, token, cache, timeoutMs = 30_000 }: ClientOptions) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(owner) ||
      !/^[A-Za-z0-9_.-]+$/.test(repo) ||
      repo === '.' ||
      repo === '..' ||
      !branch ||
      /[\x00-\x20~^:?*\[\\]/.test(branch) ||
      branch.startsWith('/') ||
      branch.endsWith('/') ||
      branch.includes('..') ||
      branch.includes('@{') ||
      branch
        .split('/')
        .some(
          (part) => !part || part.startsWith('.') || part.endsWith('.lock') || part.endsWith('.'),
        )
    ) {
      throw new GitHubError(
        '仓库或分支格式无效，请填写 owner、仓库名称和已有分支。',
        'invalid-input',
      );
    }
    if (!/^github_pat_[A-Za-z0-9_]+$/.test(token.trim())) {
      throw new GitHubError(
        '请输入细粒度 Personal Access Token，并只授权选定仓库的 Contents 读写权限。',
        'authentication',
      );
    }
    this.#token = token.trim();
    this.#repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    this.#branch = branch;
    this.#cache = cache;
    this.#timeoutMs = Math.min(
      30_000,
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30_000,
    );
  }

  /** Read-only validation cannot conclusively prove a token has Contents write permission. */
  async validateRepository(): Promise<void> {
    const data = object(await this.#json(''));
    if (typeof data.full_name !== 'string') invalid();
    if (data.archived === true || data.disabled === true) {
      throw new GitHubError('仓库已归档或禁用，不能接收同步提交。', 'permission');
    }
    if (data.permissions && object(data.permissions).push === false) {
      throw new GitHubError(
        '当前账号没有仓库写入权限；请检查仓库访问权限和 Token 的 Contents 读写授权。',
        'permission',
      );
    }
  }

  async listBranches(): Promise<string[]> {
    const names: string[] = [];
    const seen = new Set<string>();
    for (let page = 1; ; page++) {
      const { data, headers } = await this.#request(`/branches?per_page=100&page=${page}`);
      if (!Array.isArray(data)) invalid();
      for (const raw of data) {
        const name = object(raw).name;
        if (typeof name !== 'string' || !name || seen.has(name))
          invalid('读取分支列表期间发生变化，请重试。');
        seen.add(name);
        names.push(name);
      }
      // Generate the next URL ourselves. Never send the token to a Link header URL.
      const next = /<[^>]+>;\s*rel="next"/.test(headers.get('link') ?? '');
      if (!next && data.length < 100) break;
      if (!data.length || page >= 10_000) invalid('分支列表未能完整读取，请重试。');
    }
    if (!names.length)
      throw new GitHubError('仓库没有已有分支，请先在 GitHub 创建初始提交。', 'not-found');
    return names;
  }

  async readHead(): Promise<string> {
    const data = object(await this.#json(`/git/ref/heads/${this.#encodedBranch()}`));
    if (data.ref !== `refs/heads/${this.#branch}`) invalid();
    const target = object(data.object);
    if (target.type !== 'commit') invalid();
    return sha(target.sha);
  }

  async readSnapshot(
    head: string,
    onProgress?: (message: string) => void,
  ): Promise<RemoteSnapshot> {
    onProgress?.('正在完整读取远端文件目录…');
    const { treeSha, entries } = await this.#readTreeAt(head);
    const files: RemoteSnapshot['files'] = Object.create(null);
    const preservedPaths = entries
      .filter((entry) => entry.type !== 'tree' && !editable(entry))
      .map((entry) => entry.path);
    const supported = entries.filter(editable);
    const notes = supported.filter((entry) => isMarkdown(entry.path));
    let downloaded = 0;
    onProgress?.(`正在下载全部笔记 0/${notes.length}`);
    for (const entry of supported) {
      if (!isMarkdown(entry.path)) {
        files[entry.path] = { value: { kind: 'binary', sha: entry.sha }, sha: entry.sha };
        continue;
      }
      let text = this.#textCache.get(entry.sha);
      if (text === undefined) {
        const bytes = await this.#blobBytes(entry.sha);
        if (entry.size !== undefined && bytes.byteLength !== entry.size) invalid();
        try {
          // fatal rejects invalid UTF-8 instead of replacing data; ignoreBOM preserves the BOM character.
          text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        } catch {
          invalid(
            '存在非 UTF-8 编码的 Markdown 笔记。请在电脑确认编码后重试；尚未建立不完整的同步基准。',
          );
        }
        this.#textCache.set(entry.sha, text);
      }
      files[entry.path] = { value: { kind: 'text', text }, sha: entry.sha };
      downloaded++;
      onProgress?.(`正在下载全部笔记 ${downloaded}/${notes.length}`);
    }
    // No partial snapshot ever escapes: a failed blob or tree rejects the entire read.
    onProgress?.(
      `全部 ${notes.length} 篇笔记已下载；${supported.length - notes.length} 项附件按需下载。`,
    );
    return {
      head,
      treeSha,
      entries: entries.map((entry) => ({ ...entry })),
      files,
      preservedPaths,
    };
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    inputSha(ancestor);
    inputSha(descendant);
    if (ancestor === descendant) return true;
    // Status and merge_base_commit describe the whole DAG, even if the commit list is paginated.
    let response: unknown;
    try {
      response = await this.#json(`/compare/${ancestor}...${descendant}?per_page=1`);
    } catch (error) {
      // GitHub can return 404 when histories have no common ancestor. A 404 alone
      // proves nothing: walk the entire descendant DAG before reporting absence.
      if (error instanceof GitHubError && error.status === 404)
        return this.#walkAncestry(ancestor, descendant);
      throw error;
    }
    const data = object(response);
    if (sha(object(data.base_commit).sha) !== ancestor) invalid();
    if (data.status === 'behind' || data.status === 'diverged') return false;
    if (data.status !== 'ahead' || sha(object(data.merge_base_commit).sha) !== ancestor) invalid();
    return true;
  }

  async #walkAncestry(ancestor: string, descendant: string): Promise<boolean> {
    const completed = new Set<string>(),
      visiting = new Set<string>();
    const pending = [{ sha: descendant, exit: false }];
    let reads = 0;
    while (pending.length) {
      const item = pending.pop()!;
      if (item.exit) {
        visiting.delete(item.sha);
        completed.add(item.sha);
        continue;
      }
      if (item.sha === ancestor) return true;
      if (completed.has(item.sha)) continue;
      if (visiting.has(item.sha))
        invalid('远端提交历史包含循环，无法安全确认共同基准；请先导出备份并在电脑核对历史。');
      if (reads >= 2_000)
        invalid(
          '远端历史核对已达到 2000 个提交的上限，尚未确认共同基准；请先导出备份并在电脑核对历史，本地内容已保留。',
        );
      reads++;
      let data: JsonObject;
      try {
        data = object(await this.#json(`/git/commits/${item.sha}`));
      } catch (error) {
        if (error instanceof GitHubError)
          throw new GitHubError(
            `${error.message} 未能完整核对远端历史；请先导出备份，恢复访问后重试。`,
            error.code,
            error.status,
            error.retryAt,
          );
        throw error;
      }
      if (sha(data.sha) !== item.sha || !Array.isArray(data.parents))
        invalid('远端历史数据不完整，无法确认共同基准；请先导出备份并在电脑核对历史。');
      const parents = data.parents.map((parent) => sha(object(parent).sha));
      visiting.add(item.sha);
      pending.push({ sha: item.sha, exit: true });
      for (const parent of parents) pending.push({ sha: parent, exit: false });
    }
    // Every reachable commit was read, all parent links were checked, and no link reached ancestor.
    return false;
  }

  async prepareCommit(
    head: string,
    changes: Record<string, FileValue | null>,
    message: string,
  ): Promise<string> {
    const { treeSha, entries } = await this.#readTreeAt(head);
    const existing = new Map(entries.map((entry) => [entry.path, entry]));
    const changedPaths = Object.keys(changes);
    // Validate every path before uploading any blob. Preserve symlinks, submodules and unsupported objects.
    for (const path of changedPaths) {
      validatePath(path);
      const previous = existing.get(path);
      if (previous && !editable(previous)) {
        throw new GitHubError(
          '修改路径与远端保留文件、目录、符号链接或子模块冲突，请改用新路径。',
          'invalid-input',
        );
      }
      const parts = path.split('/');
      for (let n = 1; n < parts.length; n++) {
        const parentPath = parts.slice(0, n).join('/');
        const parent = existing.get(parentPath);
        if (
          (parent && parent.type !== 'tree') ||
          (Object.hasOwn(changes, parentPath) && changes[parentPath] !== null)
        ) {
          throw new GitHubError(
            '文件路径与已有文件或本次提交路径冲突，请调整文件名。',
            'invalid-input',
          );
        }
      }
      const value = changes[path];
      if (
        value &&
        ((isMarkdown(path) && value.kind !== 'text') ||
          (!isMarkdown(path) && value.kind !== 'binary'))
      ) {
        throw new GitHubError('文件扩展名与内容类型不符，已停止提交。', 'invalid-input');
      }
    }
    const tree: { path: string; mode: string; type: 'blob'; sha: string | null }[] = [];
    for (const path of changedPaths) {
      const value = changes[path];
      const previous = existing.get(path);
      if (value === null) {
        if (previous) tree.push({ path, mode: previous.mode, type: 'blob', sha: null });
        continue;
      }
      let blobSha: string;
      if (value.kind === 'binary' && !value.blob) blobSha = inputSha(value.sha);
      else {
        let content: string;
        if (value.kind === 'text') {
          const bytes = new TextEncoder().encode(value.text);
          // A dangling surrogate cannot round-trip as UTF-8. Do not silently substitute it.
          if (new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) !== value.text) {
            throw new GitHubError('笔记含无效的 Unicode 字符，请修正后重试。', 'invalid-input');
          }
          content = encodeBytes(bytes);
        } else content = encodeBytes(new Uint8Array(await value.blob!.arrayBuffer()));
        blobSha = sha(
          object(await this.#json('/git/blobs', 'POST', { content, encoding: 'base64' })).sha,
        );
      }
      if (previous?.sha !== blobSha)
        tree.push({ path, mode: previous?.mode ?? '100644', type: 'blob', sha: blobSha });
    }
    if (!tree.length) return head;
    // base_tree retains every untouched path and its exact mode, including .obsidian, Canvas and plugins.
    const newTree = sha(
      object(await this.#json('/git/trees', 'POST', { base_tree: treeSha, tree })).sha,
    );
    if (newTree === treeSha) return head;
    const commit = object(
      await this.#json('/git/commits', 'POST', { message, tree: newTree, parents: [head] }),
    );
    return sha(commit.sha);
  }

  async updateRef(commit: string): Promise<void> {
    inputSha(commit);
    const data = object(
      await this.#json(`/git/refs/heads/${this.#encodedBranch()}`, 'PATCH', {
        sha: commit,
        force: false,
      }),
    );
    if (data.ref !== `refs/heads/${this.#branch}` || sha(object(data.object).sha) !== commit)
      invalid();
  }

  async downloadBlob(blobSha: string): Promise<Blob> {
    const bytes = await this.#blobBytes(blobSha);
    return new Blob([bytes.buffer as ArrayBuffer], { type: 'application/octet-stream' });
  }

  #encodedBranch(): string {
    return this.#branch.split('/').map(encodeURIComponent).join('/');
  }

  async #blobBytes(blobSha: string): Promise<Uint8Array> {
    inputSha(blobSha);
    if (this.#cache) {
      let cached: Blob | undefined;
      try {
        cached = await this.#cache.get(blobSha);
      } catch {
        invalid('读取离线文件缓存失败，已停止下载；请检查浏览器存储。');
      }
      if (cached) {
        let bytes: Uint8Array;
        try {
          bytes = new Uint8Array(await cached.arrayBuffer());
        } catch {
          invalid('离线文件缓存无法读取，已停止操作。');
        }
        await this.#verifyBlob(blobSha, bytes);
        return bytes;
      }
    }
    const data = object(await this.#json(`/git/blobs/${blobSha}`));
    if (
      sha(data.sha) !== blobSha ||
      data.encoding !== 'base64' ||
      typeof data.content !== 'string' ||
      !Number.isSafeInteger(data.size) ||
      (data.size as number) < 0
    )
      invalid();
    let bytes: Uint8Array;
    try {
      const content = data.content.replace(/\s/g, '');
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content))
        invalid();
      bytes = Uint8Array.from(atob(content), (character) => character.charCodeAt(0));
    } catch {
      invalid('GitHub 文件内容损坏或不完整，已停止下载。');
    }
    if (bytes.byteLength !== data.size) invalid('GitHub 文件长度不符，已停止下载。');
    await this.#verifyBlob(blobSha, bytes);
    if (this.#cache) {
      try {
        await this.#cache.put(blobSha, new Blob([bytes.buffer as ArrayBuffer]));
      } catch {
        invalid('保存离线文件缓存失败，下载未完成；请检查存储空间后重试。');
      }
    }
    return bytes;
  }

  async #verifyBlob(blobSha: string, bytes: Uint8Array): Promise<void> {
    const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
    const input = new Uint8Array(header.byteLength + bytes.byteLength);
    input.set(header);
    input.set(bytes, header.byteLength);
    let digest: ArrayBuffer;
    try {
      digest = await crypto.subtle.digest('SHA-1', input);
    } catch {
      invalid('浏览器无法校验 Git 文件完整性，请通过 HTTPS 或 localhost 打开应用。');
    }
    const actual = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    if (actual !== blobSha) invalid('文件内容与 Git SHA 不符，已停止操作以保护本地数据。');
  }

  async #readTreeAt(head: string): Promise<TreeSnapshot> {
    inputSha(head);
    const cached = this.#trees.get(head);
    if (cached) return cached;
    const commit = object(await this.#json(`/git/commits/${head}`));
    if (sha(commit.sha) !== head) invalid();
    const treeSha = sha(object(commit.tree).sha);
    const recursive = await this.#getTree(treeSha, true);
    let entries = recursive.entries;
    if (recursive.truncated) {
      entries = [];
      const pending = [{ sha: treeSha, prefix: '', ancestors: new Set<string>() }];
      while (pending.length) {
        const item = pending.pop()!;
        if (item.ancestors.has(item.sha)) invalid();
        const subtree = await this.#getTree(item.sha, false);
        if (subtree.truncated)
          invalid('GitHub 单个目录仍被截断，无法确认完整快照；已停止同步，本地文件不会被删除。');
        const ancestors = new Set(item.ancestors).add(item.sha);
        for (const entry of subtree.entries) {
          if (entry.path.includes('/')) invalid();
          const full = { ...entry, path: item.prefix + entry.path };
          entries.push(full);
          if (entry.type === 'tree')
            pending.push({ sha: entry.sha, prefix: `${full.path}/`, ancestors });
        }
      }
    }
    const paths = new Map<string, TreeEntry>();
    for (const entry of entries) {
      if (paths.has(entry.path)) invalid();
      paths.set(entry.path, entry);
    }
    for (const entry of entries) {
      const slash = entry.path.lastIndexOf('/');
      if (slash >= 0 && paths.get(entry.path.slice(0, slash))?.type !== 'tree') invalid();
    }
    const snapshot = { treeSha, entries };
    this.#trees.set(head, snapshot);
    if (this.#trees.size > 4) this.#trees.delete(this.#trees.keys().next().value!);
    return snapshot;
  }

  async #getTree(
    treeSha: string,
    recursive: boolean,
  ): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
    const data = object(
      await this.#json(`/git/trees/${treeSha}${recursive ? '?recursive=1' : ''}`),
    );
    if (
      sha(data.sha) !== treeSha ||
      typeof data.truncated !== 'boolean' ||
      !Array.isArray(data.tree)
    )
      invalid();
    const entries = data.tree.map((raw) => {
      const entry = object(raw);
      if (
        typeof entry.path !== 'string' ||
        !entry.path ||
        entry.path.startsWith('/') ||
        entry.path.includes('\0') ||
        entry.path.split('/').some((part) => !part || part === '.' || part === '..')
      )
        invalid();
      const validMode =
        (entry.type === 'blob' && ['100644', '100755', '120000'].includes(entry.mode as string)) ||
        (entry.type === 'tree' && entry.mode === '040000') ||
        (entry.type === 'commit' && entry.mode === '160000');
      if (!validMode) invalid();
      if (
        entry.size !== undefined &&
        (!Number.isSafeInteger(entry.size) || (entry.size as number) < 0)
      )
        invalid();
      return {
        path: entry.path,
        sha: sha(entry.sha),
        type: entry.type,
        mode: entry.mode,
        ...(entry.size === undefined ? {} : { size: entry.size }),
      } as TreeEntry;
    });
    return { entries, truncated: data.truncated };
  }

  async #json(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    return (await this.#request(path, method, body)).data;
  }

  async #request(
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<{ data: unknown; headers: Headers }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await fetch(`${API}${this.#repoPath}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.#token}`,
          'X-GitHub-Api-Version': API_VERSION,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      });
      if (!response.ok) {
        // Use remote text only for classification. Never put it, URLs, headers or causes into errors/logs.
        let detail = '';
        try {
          detail = (await response.text()).toLowerCase();
        } catch {
          /* Classify by HTTP status. */
        }
        throw this.#httpError(response.status, response.headers, detail, method);
      }
      let data: unknown;
      try {
        data = await response.json();
      } catch (error) {
        if (error instanceof SyntaxError) invalid();
        // A response body can fail after headers arrived; this is still an uncertain network result.
        throw error;
      }
      return { data, headers: response.headers };
    } catch (error) {
      if (error instanceof GitHubError) throw error;
      throw new GitHubError(
        '网络连接失败或请求超时。请恢复连接后重试；若正在推送，将先确认远端提交结果。',
        'network',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  #httpError(status: number, headers: Headers, detail: string, method: string): GitHubError {
    if (status === 401)
      return new GitHubError(
        'GitHub 凭据无效或已过期，请重新输入 Token。',
        'authentication',
        status,
      );
    if (
      status === 429 ||
      (status === 403 &&
        (headers.get('x-ratelimit-remaining') === '0' ||
          headers.has('retry-after') ||
          /rate limit|secondary rate|abuse detection/.test(detail)))
    ) {
      const wait = Number(headers.get('retry-after'));
      const reset = Number(headers.get('x-ratelimit-reset'));
      const retryAt = wait > 0 ? Date.now() + wait * 1000 : reset > 0 ? reset * 1000 : undefined;
      return new GitHubError(
        'GitHub API 已限流，请稍后重试，本地修改已保留。',
        'rate-limit',
        status,
        retryAt,
      );
    }
    if (
      (status === 403 || status === 409 || status === 422) &&
      /protect|signed|signing|ruleset|rule violation|repository rule|gh006|gh013/.test(detail)
    ) {
      return new GitHubError(
        '分支保护、签名要求或仓库规则阻止提交。请使用允许提交的分支；本地修改已保留。',
        'protected-branch',
        status,
      );
    }
    if (status === 403)
      return new GitHubError(
        'Token 权限不足或尚未获组织批准。请确认已选中该仓库并授予 Contents 读写权限。',
        'permission',
        status,
      );
    if (status === 404)
      return new GitHubError(
        '仓库、分支或 Git 对象不存在，或 Token 无权访问。私有仓库权限不足也可能返回 404。',
        'not-found',
        status,
      );
    if ((status === 409 || status === 422) && method === 'PATCH') {
      return new GitHubError(
        '远端分支已变化或拒绝更新，需要重新读取并合并；不会强制推送。',
        'concurrent-update',
        status,
      );
    }
    if (status === 422 || status === 409 || status === 400)
      return new GitHubError(
        'GitHub 拒绝该 Git 操作，请检查分支、路径和仓库规则；本地修改已保留。',
        'invalid-input',
        status,
      );
    return new GitHubError(
      'GitHub 服务暂时不可用，请稍后重试；本地修改已保留。',
      'network',
      status,
    );
  }
}

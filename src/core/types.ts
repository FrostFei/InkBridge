export type FileValue =
  { kind: 'text'; text: string } | { kind: 'binary'; sha: string; blob?: Blob };
export interface Workspace {
  id: string;
  owner: string;
  repo: string;
  branch: string;
  head: string | null;
  initialized: boolean;
  downloadProgress: string;
  lastSync?: number;
}
export interface NoteFile {
  workspaceId: string;
  path: string;
  base: FileValue | null;
  current: FileValue | null;
  baseSha: string | null;
  revision: number;
  dirty: boolean;
}
export interface TreeEntry {
  path: string;
  sha: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  size?: number;
}
export interface RemoteSnapshot {
  head: string;
  treeSha: string;
  entries: TreeEntry[];
  files: Record<string, { value: FileValue; sha: string }>;
  preservedPaths: string[];
}
export interface Conflict {
  id: string;
  workspaceId: string;
  path: string;
  type: 'text' | 'add-add' | 'delete-modify' | 'binary' | 'rename';
  base: FileValue | null;
  local: FileValue | null;
  remote: FileValue | null;
  revision: number;
  remoteHead: string;
  draft?: string;
  resolved?: boolean;
  resolution?: FileValue | null;
  keepBothPath?: string;
  /** Edits made after capture must be rebased against the confirmed commit. */
  rebase?: boolean;
  /** Candidate additions near a deletion conflict; never a claimed rename pairing. */
  relatedPaths?: string[];
}
export interface SyncTransaction {
  id: string;
  workspaceId: string;
  phase: 'captured' | 'conflicts' | 'prepared' | 'pushing' | 'recovery' | 'complete';
  captured: NoteFile[];
  remote?: RemoteSnapshot;
  merged?: Record<string, FileValue | null>;
  baseHead?: string | null;
  resolutions?: Conflict[];
  proposedCommit?: string;
  createdAt: number;
  error?: string;
}
export interface GitRemote {
  readHead(): Promise<string>;
  readSnapshot(head: string, onProgress?: (message: string) => void): Promise<RemoteSnapshot>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  prepareCommit(
    head: string,
    changes: Record<string, FileValue | null>,
    message: string,
  ): Promise<string>;
  updateRef(commit: string): Promise<void>;
  downloadBlob(sha: string): Promise<Blob>;
}
export function equalValue(a: FileValue | null, b: FileValue | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.kind === b.kind &&
    (a.kind === 'text'
      ? a.text === (b as { text: string }).text
      : a.sha === (b as { sha: string }).sha)
  );
}
export function isMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}
export function isSupported(path: string): boolean {
  return (
    !path.split('/').some((p) => p.startsWith('.')) &&
    (isMarkdown(path) ||
      /\.(png|jpe?g|gif|webp|svg|avif|bmp|pdf|mp3|mp4|wav|ogg|m4a|mov|webm|zip)$/i.test(path))
  );
}
export function validatePath(path: string): string {
  if (
    !path ||
    path !== path.trim() ||
    path.startsWith('/') ||
    /[\\\x00-\x1f]/.test(path) ||
    path.split('/').some((p) => !p || p === '.' || p === '..' || p.startsWith('.'))
  )
    throw new Error('路径无效：请使用相对路径，不能含隐藏目录、空目录或 ..。');
  if (!isSupported(path)) throw new Error('仅支持 Markdown 笔记及常用附件格式。');
  return path;
}

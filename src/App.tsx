import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  Cloud,
  CloudOff,
  FileText,
  Folder,
  GitBranch,
  Menu,
  MoreHorizontal,
  PanelRight,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import {
  db,
  createWorkspace,
  ensureDemoWorkspace,
  saveText,
  deleteFile,
  renameFile,
  saveBinary,
  cacheAttachment,
  recoverBaseline,
} from './core/db';
import type { NoteFile, Workspace } from './core/types';
import { syncWorkspace } from './core/sync';
import { exportWorkspaceZip } from './core/export';
import { blobCacheFor } from './core/blobCache';
import { GitHubClient } from './github/client';
import { useAppUpdate } from './useAppUpdate';
import { ConnectDialog } from './components/ConnectDialog';
import { ConflictDialog } from './components/ConflictDialog';
import { MarkdownPreview } from './components/MarkdownPreview';
import { headingId } from './markdown/render';
import './styles.css';

type Draft = { text: string; revision: number; dirty: boolean; pending?: Promise<boolean> };
type PathDialog = { kind: 'create' | 'rename' | 'draft'; path: string };
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const basename = (path: string) => path.split('/').pop() || path;
const noteTitle = (path: string) => basename(path).replace(/\.(md|markdown)$/i, '');
const safeRead = (key: string) => {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
};
const safeStore = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* IDB handles note persistence independently. */
  }
};
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export default function App() {
  const workspaces = useLiveQuery(() => db.workspaces.toArray(), [], []);
  const [workspaceId, setWorkspaceId] = useState(() => safeRead('inkbridge.workspace'));
  const workspace = workspaces.find((item) => item.id === workspaceId);
  const queriedFiles = useLiveQuery(
    () => (workspaceId ? db.files.where('workspaceId').equals(workspaceId).toArray() : []),
    [workspaceId],
    [],
  );
  const queriedConflicts = useLiveQuery(
    () => (workspaceId ? db.conflicts.where('workspaceId').equals(workspaceId).toArray() : []),
    [workspaceId],
    [],
  );
  // Live queries can retain the previous result while their new key is loading.
  const files = useMemo(
    () => queriedFiles.filter((file) => file.workspaceId === workspaceId),
    [queriedFiles, workspaceId],
  );
  const conflicts = useMemo(
    () => queriedConflicts.filter((conflict) => conflict.workspaceId === workspaceId),
    [queriedConflicts, workspaceId],
  );
  const [path, setPath] = useState(() => safeRead('inkbridge.path'));
  const selected = files.find((file) => file.path === path && file.current?.kind === 'text');
  const [editorBuffer, setEditorBuffer] = useState({ key: '', text: '' });
  const [saveStatus, setSaveStatus] = useState('本地已保存');
  const [saveError, setSaveError] = useState('');
  const [message, setMessage] = useState('');
  const [syncStatus, setSyncStatus] = useState('');
  const [syncError, setSyncError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [connect, setConnect] = useState(false);
  const [settings, setSettings] = useState(false);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [pathDialog, setPathDialog] = useState<PathDialog | null>(null);
  const [pathError, setPathError] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [recoveryConfirm, setRecoveryConfirm] = useState(false);
  const [query, setQuery] = useState('');
  const [panel, setPanel] = useState<'notes' | 'attachments'>('notes');
  const [preview, setPreview] = useState(true);
  const [mobileView, setMobileView] = useState<'edit' | 'preview'>('edit');
  const [sidebar, setSidebar] = useState(false);
  const [theme, setTheme] = useState(() => safeRead('inkbridge.theme') || 'light');
  const [externalImages, setExternalImages] = useState(false);
  const [attachmentBusy, setAttachmentBusy] = useState('');
  const [storage, setStorage] = useState<{ usage?: number; quota?: number; persisted?: boolean }>(
    {},
  );
  const [exportMissing, setExportMissing] = useState<string[]>([]);
  const drafts = useRef(new Map<string, Draft>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const active = useRef({ workspaceId, path });
  active.current = { workspaceId, path };
  const syncLock = useRef(false);
  const { offlineReady, needRefresh, update } = useAppUpdate();
  const activeFiles = files.filter((file) => file.current !== null);
  const notes = activeFiles.filter((file) => file.current?.kind === 'text');
  const attachments = activeFiles.filter((file) => file.current?.kind === 'binary');
  const pending = files.filter((file) => file.dirty).length;
  const missing = attachments.filter(
    (file) => file.current?.kind === 'binary' && !file.current.blob,
  );
  const unresolved = conflicts.filter((conflict) => !conflict.resolved).length;
  const searchResults = notes.filter(
    (file) =>
      !query ||
      `${file.path}\n${file.current?.kind === 'text' ? file.current.text : ''}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  );
  const key = `${workspaceId}\u0000${path}`;
  // Mount a newly selected editor from that file immediately. The previous
  // editor's React buffer may still be waiting for its hydration effect.
  const editorText =
    editorBuffer.key === key
      ? editorBuffer.text
      : selected?.current?.kind === 'text'
        ? selected.current.text
        : '';
  const setEditorText = (text: string) => setEditorBuffer({ key, text });
  const extensions = useMemo(
    () => [
      markdown(),
      EditorState.lineSeparator.of(editorText.includes('\r\n') ? '\r\n' : '\n'),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ 'aria-label': '编辑笔记', spellcheck: 'false' }),
    ],
    [path, workspaceId, editorText.includes('\r\n')],
  );

  useEffect(() => {
    void ensureDemoWorkspace()
      .then((item) => setWorkspaceId((current) => current || item.id))
      .catch((error) => setSaveError('本地数据库无法打开：' + errorText(error)));
  }, []);
  useEffect(() => {
    if (!workspaces.length || workspace) return;
    let cancelled = false;
    void db.workspaces
      .get(workspaceId)
      .then((found) => {
        if (!cancelled && !found) setWorkspaceId(workspaces[0].id);
      })
      .catch((error) => setSaveError(errorText(error)));
    return () => {
      cancelled = true;
    };
  }, [workspaces, workspace, workspaceId]);
  useEffect(() => {
    safeStore('inkbridge.workspace', workspaceId);
  }, [workspaceId]);
  useEffect(() => {
    safeStore('inkbridge.path', path);
  }, [path]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    safeStore('inkbridge.theme', theme);
  }, [theme]);
  useEffect(() => {
    if (!selected && notes.length && !drafts.current.get(key)?.dirty) {
      let cancelled = false;
      void db.files
        .get([workspaceId, path])
        .then((found) => {
          if (!cancelled && found?.current?.kind !== 'text') setPath(notes[0].path);
        })
        .catch((error) => setSaveError(errorText(error)));
      return () => {
        cancelled = true;
      };
    }
    if (selected?.current?.kind !== 'text') return;
    const draft = drafts.current.get(key);
    if (!draft?.dirty) {
      drafts.current.set(key, {
        text: selected.current.text,
        revision: selected.revision,
        dirty: false,
      });
      setEditorText(selected.current.text);
      setSaveStatus('本地已保存');
    } else setEditorText(draft.text);
  }, [selected, key, notes.length, workspaceId, path]);

  const flush = useCallback(
    async (id = active.current.workspaceId, filePath = active.current.path): Promise<boolean> => {
      const draftKey = `${id}\u0000${filePath}`;
      const draft = drafts.current.get(draftKey);
      if (!draft?.dirty) return true;
      if (draft.pending) return draft.pending;
      const operation = (async () => {
        try {
          while (draft.dirty) {
            const snapshot = draft.text;
            const saved = await saveText(id, filePath, snapshot, draft.revision);
            draft.revision = saved.revision;
            draft.dirty = draft.text !== snapshot;
          }
          if (active.current.workspaceId === id && active.current.path === filePath) {
            setSaveStatus('本地已保存');
            setSaveError('');
          }
          return true;
        } catch (error) {
          setSaveStatus('本地保存失败');
          setSaveError(
            errorText(error) + ' 当前输入仍保留在编辑器中。请下载草稿备份，勿刷新页面。',
          );
          return false;
        } finally {
          draft.pending = undefined;
        }
      })();
      draft.pending = operation;
      return operation;
    },
    [],
  );
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if ([...drafts.current.values()].some((draft) => draft.dirty)) {
        event.preventDefault();
        event.returnValue = '';
        void flush();
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [flush]);
  const runSync = useCallback(
    async (chosen?: Workspace, credential?: string) => {
      const target = chosen || workspace;
      if (!target || syncLock.current) return;
      const token = credential || tokens[target.id];
      if (!token) {
        setConnect(true);
        return;
      }
      if (!navigator.onLine) {
        setMessage('当前离线，笔记可以继续编辑。联网后会尝试同步。');
        return;
      }
      syncLock.current = true;
      if (!(await flush())) {
        syncLock.current = false;
        return;
      }
      setSyncing(true);
      setSyncError('');
      setSyncStatus('正在同步');
      try {
        const remote = new GitHubClient({ ...target, token, cache: blobCacheFor(target.id) });
        await syncWorkspace(target.id, remote, setSyncStatus);
        const remaining = await db.conflicts.where('workspaceId').equals(target.id).toArray();
        setSyncStatus(remaining.some((item) => !item.resolved) ? '冲突待处理' : '已同步');
        if (remaining.some((item) => !item.resolved)) setConflictOpen(true);
      } catch (error) {
        const remaining = await db.conflicts
          .where('workspaceId')
          .equals(target.id)
          .toArray()
          .catch(() => []);
        if (remaining.some((item) => !item.resolved)) {
          setSyncStatus('冲突待处理');
          setConflictOpen(true);
        } else {
          setSyncError(errorText(error));
          setSyncStatus('同步失败');
        }
      } finally {
        syncLock.current = false;
        setSyncing(false);
      }
    },
    [workspace, tokens, flush],
  );
  useEffect(() => {
    const network = () => {
      setOnline(navigator.onLine);
      if (navigator.onLine && workspace && tokens[workspace.id]) void runSync();
    };
    const foreground = () => {
      if (document.visibilityState === 'visible' && workspace && tokens[workspace.id])
        void runSync();
      else if (document.visibilityState === 'hidden') void flush();
    };
    window.addEventListener('online', network);
    window.addEventListener('offline', network);
    document.addEventListener('visibilitychange', foreground);
    return () => {
      window.removeEventListener('online', network);
      window.removeEventListener('offline', network);
      document.removeEventListener('visibilitychange', foreground);
    };
  }, [workspace, tokens, runSync, flush]);
  useEffect(() => {
    const save = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 's') {
        event.preventDefault();
        void flush();
      }
    };
    window.addEventListener('keydown', save);
    return () => window.removeEventListener('keydown', save);
  }, [flush]);

  async function navigate(nextPath: string, heading?: string) {
    if (!(await flush())) return;
    setPath(nextPath);
    setPanel('notes');
    setSidebar(false);
    setSaveError('');
    if (heading) {
      setPreview(true);
      setMobileView('preview');
      setTimeout(() => document.getElementById(headingId(heading))?.scrollIntoView(), 100);
    }
  }
  async function changeWorkspace(id: string) {
    if (!(await flush())) return;
    setWorkspaceId(id);
    setPath('');
    setSyncError('');
    setSyncStatus('');
    setSidebar(false);
    setMessage('已切换工作区。其他仓库或分支未同步的修改仍保留在本机。');
    const target = workspaces.find((item) => item.id === id);
    if (target && tokens[id]) void runSync(target, tokens[id]);
  }
  function edit(text: string) {
    if (!selected) return;
    let draft = drafts.current.get(key);
    if (!draft) {
      draft = { text, revision: selected.revision, dirty: true };
      drafts.current.set(key, draft);
    }
    draft.text = text;
    draft.dirty = true;
    setEditorText(text);
    setSaveStatus('正在本地保存');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(workspaceId, path), 350);
  }
  async function exportZip() {
    if (!workspace || !(await flush())) return;
    try {
      const result = await exportWorkspaceZip(workspaceId);
      download(
        result.blob,
        `${workspace.repo || 'InkBridge'}-${new Date().toISOString().slice(0, 10)}.zip`,
      );
      setExportMissing(result.missingPaths);
      setMessage(
        result.missingPaths.length
          ? `ZIP 已导出；未包含 ${result.missingPaths.length} 个尚未下载附件。详情见设置。`
          : 'ZIP 已导出，包含全部本地笔记与已下载附件。',
      );
    } catch (error) {
      setMessage('导出失败：' + errorText(error));
    }
  }
  async function downloadAttachment(file: NoteFile) {
    if (file.current?.kind !== 'binary') return;
    if (file.current.blob) {
      download(file.current.blob, basename(file.path));
      return;
    }
    if (!workspace || !tokens[workspaceId]) {
      setConnect(true);
      return;
    }
    setAttachmentBusy(file.path);
    try {
      const blob = await new GitHubClient({
        ...workspace,
        token: tokens[workspaceId],
        cache: blobCacheFor(workspaceId),
      }).downloadBlob(file.current.sha);
      await cacheAttachment(workspaceId, file.path, blob, file.current.sha);
      setMessage('附件已下载到本机，可离线使用。');
    } catch (error) {
      setMessage('附件下载失败：' + errorText(error));
    } finally {
      setAttachmentBusy('');
    }
  }
  async function downloadAll() {
    if (!workspace || !tokens[workspaceId]) {
      setConnect(true);
      return;
    }
    const remote = new GitHubClient({
      ...workspace,
      token: tokens[workspaceId],
      cache: blobCacheFor(workspaceId),
    });
    let completed = 0;
    try {
      for (const file of missing) {
        if (file.current?.kind !== 'binary') continue;
        setAttachmentBusy(`全量下载 ${completed + 1}/${missing.length}`);
        const blob = await remote.downloadBlob(file.current.sha);
        await cacheAttachment(workspaceId, file.path, blob, file.current.sha);
        completed++;
      }
      setMessage('全部附件已下载，可以离线使用。');
    } catch (error) {
      setMessage(
        `已下载 ${completed} 项，后续下载失败：${errorText(error)}。已完成的附件仍保留，可重试。`,
      );
    } finally {
      setAttachmentBusy('');
    }
  }
  async function refreshStorage(request = false) {
    try {
      const persisted = request
        ? await navigator.storage?.persist?.()
        : await navigator.storage?.persisted?.();
      const estimate = await navigator.storage?.estimate?.();
      setStorage({ ...estimate, persisted });
    } catch (error) {
      setMessage('无法获取存储信息：' + errorText(error));
    }
  }
  const cloudLabel = !online
    ? '离线可编辑'
    : syncing
      ? '正在同步'
      : unresolved
        ? '冲突待处理'
        : syncError
          ? '同步失败'
          : pending
            ? `待上传 ${pending} 项`
            : workspace?.lastSync
              ? '已同步'
              : '尚未连接云端';
  const wordCount = editorText.replace(/\s/g, '').length;
  const backlinks = selected
    ? notes.filter(
        (file) =>
          file.path !== path &&
          file.current?.kind === 'text' &&
          (file.current.text.includes(noteTitle(path)) || file.current.text.includes(path)),
      )
    : [];

  return (
    <div className="app-shell">
      {sidebar && (
        <button
          className="sidebar-shade"
          aria-label="关闭文件导航"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside className={`sidebar ${sidebar ? 'is-open' : ''}`}>
        <a className="brand" href="#" onClick={(event) => event.preventDefault()}>
          <span className="brand-mark">
            <BookOpen size={22} strokeWidth={1.6} />
          </span>
          <span>
            InkBridge<small>墨桥 · 让思绪自在流动</small>
          </span>
        </a>
        <div className="workspace-card">
          <div className="workspace-caption">
            <span className="workspace-dot" /> 当前笔记库{' '}
            <button
              className="icon-button"
              aria-label="连接其他仓库"
              title="连接其他仓库"
              onClick={() => setConnect(true)}
            >
              <Plus size={16} />
            </button>
          </div>
          <label className="workspace-select">
            <span className="sr-only">选择工作区</span>
            <select
              value={workspaceId}
              onChange={(event) => void changeWorkspace(event.target.value)}
            >
              {workspaces.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.owner === 'local' ? '我的离线笔记库' : `${item.owner}/${item.repo}`} ·{' '}
                  {item.branch}
                </option>
              ))}
            </select>
            <ChevronDown size={15} />
          </label>
          <div className="branch-caption">
            <GitBranch size={13} />
            {workspace?.branch || 'local'}
            <span>
              {workspace?.owner === 'local'
                ? '本机工作区'
                : tokens[workspaceId]
                  ? '会话已连接'
                  : '需重新授权'}
            </span>
          </div>
        </div>
        <div className="sidebar-navigation">
          <button
            className={panel === 'notes' ? 'active' : ''}
            onClick={() => {
              setPanel('notes');
              setSidebar(false);
            }}
          >
            <BookOpen size={17} />
            全部笔记<span>{notes.length}</span>
          </button>
          <button
            className={panel === 'attachments' ? 'active' : ''}
            onClick={() => {
              setPanel('attachments');
              setSidebar(false);
            }}
          >
            <Folder size={17} />
            附件<span>{attachments.length}</span>
          </button>
        </div>
        <label className="search-field">
          <Search size={16} />
          <input
            aria-label="搜索笔记"
            placeholder="搜索笔记内容…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPanel('notes');
            }}
          />
          {query && (
            <button className="icon-button" aria-label="清除搜索" onClick={() => setQuery('')}>
              <X size={13} />
            </button>
          )}
        </label>
        <div className="tree-heading">
          <span>{query ? `${searchResults.length} 个搜索结果` : '笔记文件'}</span>
          <button
            className="icon-button"
            aria-label="新建笔记"
            title="新建笔记"
            onClick={() => {
              setPathError('');
              setPathDialog({ kind: 'create', path: '' });
            }}
          >
            <Plus size={18} />
          </button>
        </div>
        <nav className="file-tree" aria-label="笔记文件树">
          {searchResults.length ? (
            query ? (
              searchResults.map((file) => (
                <button
                  key={file.path}
                  className={`file-row ${path === file.path ? 'selected' : ''}`}
                  onClick={() => void navigate(file.path)}
                >
                  <FileText size={15} />
                  <span>
                    {noteTitle(file.path)}
                    <small>{file.path}</small>
                  </span>
                  {file.dirty && <i className="dirty-dot" />}
                </button>
              ))
            ) : (
              <FileTree
                files={searchResults}
                selected={path}
                onSelect={(next) => void navigate(next)}
              />
            )
          ) : (
            <p className="tree-empty">{query ? '没有匹配的笔记' : '从第一份笔记开始。'}</p>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className={`local-ready ${offlineReady ? 'ready' : ''}`}>
            <ShieldCheck size={18} />
            <span>
              {offlineReady ? '应用已准备好离线使用' : '正在准备离线应用'}
              <small>
                {workspace?.downloadProgress ||
                  `${notes.length} 篇笔记在本机 · ${missing.length} 个附件未下载`}
              </small>
            </span>
          </div>
          <button
            className="settings-button"
            onClick={() => {
              setSettings(true);
              void refreshStorage();
            }}
          >
            <Settings2 size={17} />
            设置与本地数据
            <MoreHorizontal size={19} />
          </button>
        </div>
      </aside>
      <main className="main-panel">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="打开文件导航"
              onClick={() => setSidebar(true)}
            >
              <Menu size={21} />
            </button>
            <span>
              {workspace?.owner === 'local' ? '我的笔记' : workspace?.repo || 'InkBridge'}
            </span>
            <span className="breadcrumb-slash">/</span>
            <strong>
              {panel === 'attachments'
                ? '附件'
                : path.includes('/')
                  ? path.slice(0, path.lastIndexOf('/'))
                  : '书写空间'}
            </strong>
          </div>
          <div className="topbar-actions">
            <span className={`cloud-status ${syncError || unresolved ? 'attention' : ''}`}>
              {online ? <Cloud size={16} /> : <CloudOff size={16} />}
              <span>{cloudLabel}</span>
            </span>
            <button className="sync-button" disabled={syncing} onClick={() => void runSync()}>
              <RefreshCw className={syncing ? 'spin' : ''} size={16} />
              {syncing ? '正在同步' : '同步'}
            </button>
          </div>
        </header>
        {syncing && (
          <div className="sync-progress" role="status">
            <RefreshCw size={13} className="spin" />
            <span>{syncStatus || '正在同步'}</span>
            <small>本地编辑可以继续</small>
          </div>
        )}
        {message && (
          <div className="message-banner" role="status">
            <span>{message}</span>
            <button className="icon-button" aria-label="关闭提示" onClick={() => setMessage('')}>
              <X size={16} />
            </button>
          </div>
        )}
        {saveError && (
          <div className="error-banner" role="alert">
            <span>{saveError}</span>
            <button
              onClick={() =>
                download(
                  new Blob([editorText], { type: 'text/markdown;charset=utf-8' }),
                  `${noteTitle(path)}-未保存草稿.md`,
                )
              }
            >
              下载当前草稿
            </button>
            <button
              onClick={() => {
                setPathError('');
                setPathDialog({
                  kind: 'draft',
                  path: path.replace(/(\.[^/.]+)$/, ' (保留草稿)$1'),
                });
              }}
            >
              另存当前草稿
            </button>
            <button onClick={() => void flush()}>重试保存</button>
          </div>
        )}
        {syncError && (
          <div className="error-banner" role="alert">
            <span>{syncError} 本地修改仍保留。</span>
            {/基准|历史|恢复|ancestor/i.test(syncError) && (
              <button onClick={() => setRecoveryConfirm(true)}>人工恢复基准</button>
            )}
            <button onClick={() => void runSync()}>重试同步</button>
          </div>
        )}
        {!!conflicts.length && (
          <div className="conflict-banner">
            <span>
              {unresolved ? `${unresolved} 个冲突需要你的选择` : '冲突解决方式已保存，等待同步校验'}
              <small>本地和远端版本都已保留。</small>
            </span>
            <button onClick={() => setConflictOpen(true)}>
              查看并处理 <ArrowUpRight size={15} />
            </button>
          </div>
        )}
        {needRefresh && (
          <div className="message-banner">
            <span>有新版本可用，完成本地保存后即可更新。</span>
            <button
              onClick={async () => {
                if (await flush()) await update();
              }}
            >
              保存并更新
            </button>
          </div>
        )}
        {panel === 'attachments' ? (
          <section className="attachments-page">
            <div className="page-heading">
              <div>
                <span className="eyebrow">A PLACE FOR THE DETAILS</span>
                <h1>笔记里的附件</h1>
                <p>图片、PDF 与其他材料，都在原来的路径里。</p>
              </div>
              <label className="primary upload-button">
                <Plus size={17} />
                上传附件
                <input
                  type="file"
                  multiple
                  aria-label="上传附件"
                  onChange={async (event) => {
                    const uploads = Array.from(event.target.files || []);
                    event.target.value = '';
                    try {
                      for (const file of uploads) {
                        const filePath = `附件/${file.name}`;
                        const existing = await db.files.get([workspaceId, filePath]);
                        if (existing?.current)
                          throw new Error(`路径已存在：${filePath}。请先重命名文件，避免覆盖。`);
                        await saveBinary(workspaceId, filePath, file, existing?.revision ?? 0);
                      }
                      setMessage(`已保存 ${uploads.length} 个附件到本机，等待同步。`);
                    } catch (error) {
                      setMessage('附件上传中断：' + errorText(error));
                    }
                  }}
                />
              </label>
            </div>
            <div className="attachment-summary">
              <ShieldCheck size={23} />
              <div>
                <strong>
                  {attachments.length - missing.length} / {attachments.length} 个附件可离线使用
                </strong>
                <p>未下载附件离线不可用。笔记正文会在同步时完整下载。</p>
              </div>
              <button
                className="secondary"
                disabled={!!attachmentBusy || !missing.length || !online}
                onClick={() => void downloadAll()}
              >
                {attachmentBusy.startsWith('全量') ? attachmentBusy : '下载全部附件'}
              </button>
            </div>
            {attachments.length ? (
              <div className="attachment-list">
                {attachments.map((file) => (
                  <div className="attachment-row" key={file.path}>
                    <span className="attachment-icon">
                      <FileText size={23} />
                    </span>
                    <div>
                      <strong>{basename(file.path)}</strong>
                      <small>{file.path}</small>
                    </div>
                    <span
                      className={`attachment-status ${file.current?.kind === 'binary' && file.current.blob ? 'cached' : ''}`}
                    >
                      {file.current?.kind === 'binary' && file.current.blob
                        ? '可离线使用'
                        : '尚未下载 · 离线不可用'}
                    </span>
                    <button
                      className="secondary"
                      disabled={
                        !!attachmentBusy ||
                        (!online && file.current?.kind === 'binary' && !file.current.blob)
                      }
                      onClick={() => void downloadAttachment(file)}
                    >
                      <ArrowDownToLine size={16} />
                      {attachmentBusy === file.path
                        ? '下载中…'
                        : file.current?.kind === 'binary' && file.current.blob
                          ? '导出附件'
                          : '下载到本机'}
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`删除附件 ${file.path}`}
                      onClick={() => setDeleteConfirm(file.path)}
                    >
                      <X size={17} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <Folder size={36} />
                <h2>给灵感留一点附件空间</h2>
                <p>连接笔记库，或上传图片、PDF 等支持的文件。</p>
              </div>
            )}
          </section>
        ) : selected ? (
          <>
            <section className="note-heading">
              <div className="note-heading-main">
                <span className="eyebrow">A LITTLE SPACE TO THINK</span>
                <h1>{noteTitle(path)}</h1>
                <div className="note-meta">
                  <span>
                    <FileText size={13} />
                    {path}
                  </span>
                  <span className={saveError ? 'save-failed' : 'saved-status'}>
                    {saveStatus === '本地已保存' && <Check size={13} />}
                    {saveStatus}
                  </span>
                </div>
              </div>
              <div className="note-actions">
                <button
                  className="icon-button"
                  title="重命名笔记"
                  aria-label="重命名笔记"
                  onClick={() => {
                    setPathError('');
                    setPathDialog({ kind: 'rename', path });
                  }}
                >
                  <MoreHorizontal size={20} />
                </button>
                <button
                  className="icon-button"
                  title="删除笔记"
                  aria-label="删除笔记"
                  onClick={() => setDeleteConfirm(path)}
                >
                  <X size={17} />
                </button>
                <button
                  className={`icon-button preview-toggle ${preview ? 'active' : ''}`}
                  title="切换预览"
                  aria-label="切换预览"
                  onClick={() => setPreview(!preview)}
                >
                  <PanelRight size={20} />
                </button>
              </div>
            </section>
            <div className="editor-toolbar">
              <div className="mode-tabs">
                <button
                  className={mobileView === 'edit' ? 'active' : ''}
                  onClick={() => setMobileView('edit')}
                >
                  Markdown
                </button>
                <button
                  className={mobileView === 'preview' ? 'active' : ''}
                  onClick={() => {
                    setMobileView('preview');
                    setPreview(true);
                  }}
                >
                  阅读预览
                </button>
              </div>
              <span className="toolbar-tip">每个想法，都值得被留下</span>
              <button
                className="icon-button"
                title="导出 ZIP"
                aria-label="导出 ZIP"
                onClick={() => void exportZip()}
              >
                <ArrowDownToLine size={17} />
              </button>
            </div>
            <div className={`writing-area ${preview ? 'with-preview' : ''} mobile-${mobileView}`}>
              <div className="editor-pane">
                <CodeMirror
                  key={key}
                  value={editorText}
                  extensions={extensions}
                  onChange={edit}
                  theme={theme === 'dark' ? 'dark' : 'light'}
                  height="100%"
                  basicSetup={{
                    lineNumbers: false,
                    foldGutter: false,
                    highlightActiveLine: false,
                    highlightActiveLineGutter: false,
                    autocompletion: false,
                  }}
                />
              </div>
              {preview && (
                <div className="preview-pane">
                  <div className="preview-label">
                    <BookOpen size={13} />
                    预览 <span>按你的原文呈现</span>
                  </div>
                  <MarkdownPreview
                    text={editorText}
                    path={path}
                    files={files}
                    externalImages={externalImages}
                    onNavigate={(target, heading) => void navigate(target, heading)}
                    onMessage={setMessage}
                  />
                </div>
              )}
            </div>
            <footer className="editor-footer">
              <span>
                {wordCount.toLocaleString()} 字符<span className="footer-separator">·</span>
                {editorText.split('\n').length} 行<span className="footer-separator">·</span>UTF-8
              </span>
              <span>
                {online ? <span className="connection-dot" /> : <CloudOff size={12} />}
                {syncing
                  ? syncStatus
                  : pending
                    ? `待上传 ${pending} 项`
                    : workspace?.lastSync
                      ? `上次同步 ${new Date(workspace.lastSync).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
                      : '仅保存在本机'}
              </span>
            </footer>
          </>
        ) : (
          <div className="empty-state">
            <BookOpen size={40} />
            <span className="eyebrow">WELCOME TO INKBRIDGE</span>
            <h1>把今天的想法，写下来。</h1>
            <p>笔记先安全保存在本机，再由你同步到 GitHub。</p>
            <div className="empty-actions">
              <button
                className="primary"
                onClick={() => {
                  setPathError('');
                  setPathDialog({ kind: 'create', path: '' });
                }}
              >
                <Plus size={17} />
                新建笔记
              </button>
              <button className="secondary" onClick={() => setConnect(true)}>
                连接 GitHub
              </button>
            </div>
          </div>
        )}
      </main>
      {connect && (
        <ConnectDialog
          workspace={workspace}
          onClose={() => setConnect(false)}
          onConnect={async (owner, repo, branch, token) => {
            if (!(await flush())) throw new Error('请先处理本地保存失败并备份草稿。');
            const target = await createWorkspace(owner, repo, branch);
            setTokens((current) => ({ ...current, [target.id]: token }));
            setWorkspaceId(target.id);
            setPath('');
            setConnect(false);
            setMessage('已连接笔记库。原工作区的本地修改仍保留。');
            void runSync(target, token);
          }}
        />
      )}
      {conflictOpen && (
        <ConflictDialog
          conflicts={conflicts}
          onClose={() => setConflictOpen(false)}
          onContinue={() => {
            setConflictOpen(false);
            void runSync();
          }}
          onResolved={() =>
            setMessage('解决方式已保存。处理完全部冲突后，点击同步重新校验并提交。')
          }
        />
      )}
      {pathDialog && (
        <div className="modal-backdrop">
          <form
            className="dialog compact"
            role="dialog"
            aria-modal="true"
            aria-label={
              pathDialog.kind === 'rename'
                ? '重命名笔记'
                : pathDialog.kind === 'draft'
                  ? '另存当前草稿'
                  : '新建笔记'
            }
            onSubmit={async (event) => {
              event.preventDefault();
              setPathError('');
              if (pathDialog.kind !== 'draft' && !(await flush())) return;
              try {
                const nextPath = /\.(md|markdown)$/i.test(pathDialog.path.trim())
                  ? pathDialog.path.trim()
                  : pathDialog.path.trim() + '.md';
                if (!pathDialog.path.trim()) throw new Error('请输入笔记路径。');
                if (pathDialog.kind !== 'rename') {
                  if (await db.files.get([workspaceId, nextPath]))
                    throw new Error('此路径已存在或有待同步删除记录，请使用其他名称。');
                  await saveText(
                    workspaceId,
                    nextPath,
                    pathDialog.kind === 'draft' ? editorText : `# ${noteTitle(nextPath)}\n\n`,
                    0,
                  );
                  if (pathDialog.kind === 'draft') {
                    drafts.current.delete(key);
                    setSaveError('');
                    setMessage(
                      '当前草稿已保存为新笔记。原路径保留数据库中的最新版本，可打开比较。',
                    );
                  }
                } else await renameFile(workspaceId, path, nextPath);
                setPath(nextPath);
                setPanel('notes');
                setPathDialog(null);
                setSidebar(false);
              } catch (error) {
                setPathError(errorText(error));
              }
            }}
          >
            <h2>
              {pathDialog.kind === 'rename'
                ? '重命名笔记'
                : pathDialog.kind === 'draft'
                  ? '为当前草稿保留一份副本'
                  : '留下一份新笔记'}
            </h2>
            <p>使用原有目录结构，也可以输入新的文件夹路径。</p>
            <label>
              笔记路径
              <input
                autoFocus
                required
                aria-label="笔记路径"
                placeholder="随记/一个新想法.md"
                value={pathDialog.path}
                onChange={(event) => setPathDialog({ ...pathDialog, path: event.target.value })}
              />
            </label>
            {pathDialog.kind === 'rename' && (
              <div className="notice">
                检测到 {backlinks.length}{' '}
                篇笔记可能引用此名称。重命名会作为删除与新增一起同步；请检查并手动更新链接。
                {backlinks.length > 0 && (
                  <ul>
                    {backlinks.map((file) => (
                      <li key={file.path}>{file.path}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {pathError && (
              <p className="error-text" role="alert">
                {pathError}
              </p>
            )}
            <div className="dialog-actions">
              <button className="secondary" type="button" onClick={() => setPathDialog(null)}>
                取消
              </button>
              <button className="primary" type="submit">
                {pathDialog.kind === 'rename'
                  ? '确认重命名'
                  : pathDialog.kind === 'draft'
                    ? '保存草稿副本'
                    : '创建'}
              </button>
            </div>
          </form>
        </div>
      )}
      {deleteConfirm && (
        <div className="modal-backdrop">
          <section className="dialog compact" role="dialog" aria-modal="true" aria-label="确认删除">
            <h2>删除这份文件？</h2>
            <p className="break-path">{deleteConfirm}</p>
            <p>
              删除会保存在本机，并在下次同步时应用到 GitHub。若另一端修改了文件，会交由你处理冲突。
            </p>
            <div className="dialog-actions">
              <button className="secondary" onClick={() => setDeleteConfirm(null)}>
                取消
              </button>
              <button
                className="danger"
                onClick={async () => {
                  if (!(await flush())) return;
                  try {
                    await deleteFile(workspaceId, deleteConfirm);
                    drafts.current.delete(`${workspaceId}\u0000${deleteConfirm}`);
                    setDeleteConfirm(null);
                  } catch (error) {
                    setMessage(errorText(error));
                  }
                }}
              >
                确认删除
              </button>
            </div>
          </section>
        </div>
      )}
      {recoveryConfirm && (
        <div className="modal-backdrop">
          <section
            className="dialog compact"
            role="dialog"
            aria-modal="true"
            aria-label="人工恢复基准"
          >
            <h2>保留本地，重新建立基准</h2>
            <p>
              适用于无法证明共同历史的工作区。本地文件不会被覆盖，下次同步会把同名差异交给你逐项选择。此操作不能自动推断远端删除。
            </p>
            <p>建议先导出 ZIP 备份。若存在未确认提交，请先重试同步恢复事务。</p>
            <div className="dialog-actions">
              <button className="secondary" onClick={() => void exportZip()}>
                导出 ZIP 备份
              </button>
              <button className="secondary" onClick={() => setRecoveryConfirm(false)}>
                取消
              </button>
              <button
                className="primary"
                onClick={async () => {
                  if (!(await flush())) return;
                  try {
                    await recoverBaseline(workspaceId);
                    setRecoveryConfirm(false);
                    setSyncError('');
                    setMessage('恢复模式已启用。请同步并逐项检查同名冲突。');
                  } catch (error) {
                    setMessage(errorText(error));
                  }
                }}
              >
                保留本地并重建基准
              </button>
            </div>
          </section>
        </div>
      )}
      {settings && (
        <div className="modal-backdrop">
          <section
            className="dialog settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="设置与本地数据"
          >
            <div className="settings-heading">
              <div>
                <span className="eyebrow">YOUR OWN LITTLE CORNER</span>
                <h2>设置与本地数据</h2>
              </div>
              <button
                className="icon-button"
                aria-label="关闭设置"
                onClick={() => setSettings(false)}
              >
                <X size={21} />
              </button>
            </div>
            <div className="setting-row">
              <div>
                <strong>外观</strong>
                <p>给书写选一个舒服的底色。</p>
              </div>
              <select
                aria-label="外观主题"
                value={theme}
                onChange={(event) => setTheme(event.target.value)}
              >
                <option value="light">纸白</option>
                <option value="dark">墨夜</option>
              </select>
            </div>
            <div className="setting-row">
              <div>
                <strong>允许外部图片</strong>
                <p>开启后，预览中的外部图片会连接其服务器。</p>
              </div>
              <input
                type="checkbox"
                aria-label="允许外部图片"
                checked={externalImages}
                onChange={(event) => setExternalImages(event.target.checked)}
              />
            </div>
            <div className="setting-block">
              <h3>
                <ShieldCheck size={18} />
                离线与存储
              </h3>
              <div className="storage-stats">
                <span>
                  <strong>{notes.length}</strong>篇本地笔记
                </span>
                <span>
                  <strong>{missing.length}</strong>个附件未下载
                </span>
                <span>
                  <strong>{pending}</strong>项待同步
                </span>
              </div>
              <p>
                {workspace?.downloadProgress ||
                  '本地笔记可离线编辑。连接仓库后，同步会下载所有支持的 Markdown 正文。'}
              </p>
              <p>
                {offlineReady
                  ? '应用资源已缓存，可以离线启动。'
                  : '应用资源尚未确认缓存完成，请保持联网直到准备完成。'}
              </p>
              <p>
                存储使用：
                {storage.usage == null
                  ? '当前浏览器未提供'
                  : `${(storage.usage / 1024 / 1024).toFixed(1)} MB`}
                {storage.quota != null && ` / ${(storage.quota / 1024 / 1024).toFixed(0)} MB`} ·{' '}
                {storage.persisted ? '已获持久化存储许可' : '尚未获持久化存储许可'}
              </p>
              <button className="secondary" onClick={() => void refreshStorage(true)}>
                申请持久化存储
              </button>
              <p className="hint">
                浏览器仍可能清理数据，删除网站数据会删除本地副本。请定期同步或导出备份。
              </p>
            </div>
            <div className="setting-block">
              <h3>
                <ArrowDownToLine size={18} />
                备份与连接
              </h3>
              <p>ZIP 包含当前本地笔记与已下载附件，保留原始路径；不含 Token。</p>
              <div className="setting-actions">
                <button className="secondary" onClick={() => void exportZip()}>
                  导出 ZIP
                </button>
                <button
                  className="secondary"
                  onClick={() => {
                    setSettings(false);
                    setConnect(true);
                  }}
                >
                  连接 GitHub
                </button>
                {tokens[workspaceId] && (
                  <button
                    className="secondary"
                    onClick={() => {
                      setTokens((current) => {
                        const next = { ...current };
                        delete next[workspaceId];
                        return next;
                      });
                      setMessage('会话 Token 已移除，本地文件仍可离线编辑。');
                    }}
                  >
                    移除会话 Token
                  </button>
                )}
              </div>
              {missing.length > 0 && (
                <details>
                  <summary>未下载、不包含在导出中的附件（{missing.length}）</summary>
                  <ul>
                    {missing.map((file) => (
                      <li key={file.path}>{file.path}</li>
                    ))}
                  </ul>
                </details>
              )}
              {exportMissing.length > 0 && (
                <details>
                  <summary>上次导出遗漏清单（{exportMissing.length}）</summary>
                  <ul>
                    {exportMissing.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
            <p className="hint">
              支持 Markdown 与常用附件。.obsidian 配置、Canvas
              和插件数据保留在远端，不在此编辑。InkBridge 不运行 Obsidian 插件，不承诺后台持续同步。
            </p>
          </section>
        </div>
      )}
    </div>
  );
}

function FileTree({
  files,
  selected,
  onSelect,
  prefix = '',
}: {
  files: NoteFile[];
  selected: string;
  onSelect: (path: string) => void;
  prefix?: string;
}) {
  const folders = [
    ...new Set(
      files
        .map((file) => file.path.slice(prefix.length))
        .filter((path) => path.includes('/'))
        .map((path) => path.split('/')[0]),
    ),
  ].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const direct = files
    .filter((file) => !file.path.slice(prefix.length).includes('/'))
    .sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
  return (
    <>
      {folders.map((folder) => (
        <details className="tree-folder" open key={folder}>
          <summary>
            <ChevronDown size={13} />
            <Folder size={15} />
            <span>{folder}</span>
            <small>
              {files.filter((file) => file.path.startsWith(prefix + folder + '/')).length}
            </small>
          </summary>
          <div className="folder-children">
            <FileTree
              files={files.filter((file) => file.path.startsWith(prefix + folder + '/'))}
              prefix={prefix + folder + '/'}
              selected={selected}
              onSelect={onSelect}
            />
          </div>
        </details>
      ))}
      {direct.map((file) => (
        <button
          key={file.path}
          title={file.path}
          className={`file-row ${selected === file.path ? 'selected' : ''}`}
          onClick={() => onSelect(file.path)}
        >
          <FileText size={15} />
          <span>{noteTitle(file.path)}</span>
          {file.dirty && <i className="dirty-dot" />}
        </button>
      ))}
    </>
  );
}

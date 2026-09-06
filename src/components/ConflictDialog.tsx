import { useEffect, useRef, useState } from 'react';
import type { Conflict, FileValue } from '../core/types';
import { resolveConflict, saveConflictDraft } from '../core/db';

const describe = (value: FileValue | null) =>
  value === null
    ? '此版本已删除文件'
    : value.kind === 'text'
      ? value.text
      : `二进制附件\n${value.sha}\n${value.blob ? '已缓存在本机' : '尚未下载'}`;
const names: Record<Conflict['type'], string> = {
  text: '同段文字修改',
  'add-add': '双方新增同名文件',
  'delete-modify': '删除与修改',
  binary: '附件版本不同',
  rename: '可能涉及重命名',
};
export function ConflictDialog({
  conflicts,
  onClose,
  onResolved,
  onContinue,
}: {
  conflicts: Conflict[];
  onClose: () => void;
  onResolved: () => void;
  onContinue: () => void;
}) {
  const [index, setIndex] = useState(0);
  const flushDraft = useRef<() => Promise<boolean>>(async () => true);
  const active = conflicts[Math.min(index, conflicts.length - 1)];
  return (
    <div className="modal-backdrop">
      <section
        className="dialog conflict-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="处理同步冲突"
      >
        <div className="conflict-heading">
          <div>
            <span className="eyebrow">MAKE ROOM FOR BOTH IDEAS</span>
            <h2>把两个版本，妥善放在一起</h2>
            <p>本次远端提交已暂停。你的共同基准、本地和远端版本都已保留。</p>
          </div>
          <button
            className="secondary"
            onClick={async () => {
              if (await flushDraft.current()) onClose();
            }}
          >
            稍后处理
          </button>
        </div>
        <div className="conflict-layout">
          <nav aria-label="冲突文件">
            {conflicts.map((conflict, i) => (
              <button
                className={i === index ? 'active' : ''}
                key={conflict.id}
                onClick={async () => {
                  if (await flushDraft.current()) setIndex(i);
                }}
              >
                <strong>{conflict.path}</strong>
                <small>
                  {names[conflict.type]}
                  {conflict.resolved ? ' · 已选择' : ''}
                </small>
              </button>
            ))}
          </nav>
          {active ? (
            <ConflictEditor
              key={active.id}
              conflict={active}
              onResolved={onResolved}
              registerFlush={(handler) => {
                flushDraft.current = handler;
              }}
            />
          ) : (
            <p>所有冲突均已处理，可以继续同步。</p>
          )}
        </div>
        {conflicts.length > 0 && conflicts.every((conflict) => conflict.resolved) && (
          <div className="dialog-actions">
            <p className="hint">所有解决方式已保存。继续同步会重新校验版本，再提交到 GitHub。</p>
            <button
              className="primary"
              onClick={async () => {
                if (await flushDraft.current()) onContinue();
              }}
            >
              继续同步
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function ConflictEditor({
  conflict,
  onResolved,
  registerFlush,
}: {
  conflict: Conflict;
  onResolved: () => void;
  registerFlush: (handler: () => Promise<boolean>) => void;
}) {
  const [draft, setDraft] = useState(
    conflict.draft ??
      (conflict.local?.kind === 'text'
        ? conflict.local.text
        : conflict.remote?.kind === 'text'
          ? conflict.remote.text
          : ''),
  );
  const [bothPath, setBothPath] = useState(
    conflict.path.replace(/(\.[^/.]+)$/, ' (GitHub 版本)$1'),
  );
  const [tab, setTab] = useState<'local' | 'remote' | 'base'>('local');
  const [status, setStatus] = useState(
    conflict.draft ? '合并草稿已保存在本机' : '尚未选择解决方式',
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const edited = useRef(false);
  const queue = useRef<Promise<boolean>>(Promise.resolve(true));
  const latest = useRef(draft);
  const isText =
    [conflict.local, conflict.remote].some((value) => value?.kind === 'text') &&
    ![conflict.local, conflict.remote].some((value) => value?.kind === 'binary');
  const relatedPaths = (conflict as Conflict & { relatedPaths?: string[] }).relatedPaths;
  useEffect(() => {
    registerFlush(() => queue.current);
  }, [registerFlush]);
  function persistDraft(text: string) {
    edited.current = true;
    latest.current = text;
    setDraft(text);
    setStatus('正在保存合并草稿…');
    // Serialize each change, so switching files or closing the dialog can await
    // the actual IDB write without depending on an unmount/close event.
    queue.current = queue.current.then(async () => {
      try {
        await saveConflictDraft(conflict.id, text);
        if (latest.current === text) {
          setStatus('合并草稿已保存在本机');
          setError('');
        }
        return true;
      } catch (cause) {
        setError('草稿保存失败：' + (cause instanceof Error ? cause.message : String(cause)));
        return false;
      }
    });
  }
  async function choose(choice: 'local' | 'remote' | 'manual' | 'both') {
    setBusy(true);
    setError('');
    try {
      if (!(await queue.current))
        throw new Error('合并草稿保存失败。请保留当前内容，重试编辑保存。');
      if (isText && edited.current) await saveConflictDraft(conflict.id, draft);
      await resolveConflict(conflict.id, {
        choice,
        text: draft,
        path: choice === 'both' ? bothPath : undefined,
      });
      setStatus('解决方式已保存；下次同步会重新校验双方版本');
      onResolved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存解决方式失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="conflict-editor">
      <h3>{conflict.path}</h3>
      <p className="hint">
        {names[conflict.type]} ·{' '}
        {conflict.type === 'delete-modify'
          ? '请选择保留删除，或恢复另一端的修改内容。'
          : '选择前请检查完整内容。解决后仍需重新同步。'}
      </p>
      {!!relatedPaths?.length && (
        <div className="notice">
          以下新增路径可能与此删除有关，请检查是否涉及重命名。Git 未提供明确重命名记录，需要你确认。
          <ul>
            {relatedPaths.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="conflict-tabs">
        {(['local', 'remote', 'base'] as const).map((value) => (
          <button
            key={value}
            className={tab === value ? 'active' : ''}
            onClick={() => setTab(value)}
          >
            {value === 'local' ? 'iPad 本地' : value === 'remote' ? 'GitHub 远端' : '共同基准'}
          </button>
        ))}
      </div>
      <div className="conflict-versions">
        {(['local', 'remote', 'base'] as const).map((value) => (
          <div key={value} className={`conflict-version ${tab === value ? 'visible' : ''}`}>
            <h4>
              {value === 'local' ? 'iPad 本地' : value === 'remote' ? 'GitHub 远端' : '共同基准'}
            </h4>
            <pre>{describe(conflict[value])}</pre>
          </div>
        ))}
      </div>
      {isText && (
        <label>
          手动合并结果
          <textarea
            aria-label="手动合并结果"
            className="merge-draft"
            value={draft}
            onChange={(event) => persistDraft(event.target.value)}
          />
        </label>
      )}
      <p className="hint" role="status">
        {status}
      </p>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      <div className="resolution-actions">
        <button className="secondary" disabled={busy} onClick={() => void choose('local')}>
          {conflict.local === null ? '使用 iPad 版本（删除）' : '使用 iPad 版本'}
        </button>
        <button className="secondary" disabled={busy} onClick={() => void choose('remote')}>
          {conflict.remote === null ? '使用 GitHub 版本（删除）' : '使用 GitHub 版本'}
        </button>
        {isText && (
          <button className="primary" disabled={busy} onClick={() => void choose('manual')}>
            采用手动合并结果
          </button>
        )}
      </div>
      {conflict.local && conflict.remote && (
        <div className="keep-both">
          <label>
            为 GitHub 版本指定新路径
            <input
              aria-label="保留两份的新路径"
              value={bothPath}
              onChange={(event) => setBothPath(event.target.value)}
            />
          </label>
          <button className="secondary" disabled={busy} onClick={() => void choose('both')}>
            保留两份
          </button>
          <p className="hint">iPad 版本保留原路径。GitHub 版本另存为上面的新路径。</p>
        </div>
      )}
    </div>
  );
}

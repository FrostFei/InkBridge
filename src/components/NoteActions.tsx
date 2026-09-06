import { useEffect, useRef } from 'react';
import { MoreHorizontal } from 'lucide-react';

export function NoteActions({
  path,
  characters,
  lines,
  onRename,
  onDelete,
  onExport,
}: {
  path: string;
  characters: number;
  lines: number;
  onRename: () => void;
  onDelete: () => void;
  onExport: () => void;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (details.current && !details.current.contains(event.target as Node))
        details.current.open = false;
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, []);
  const run = (action: () => void) => {
    if (details.current) {
      details.current.open = false;
      details.current.querySelector('summary')?.focus();
    }
    action();
  };
  return (
    <details
      className="note-menu"
      ref={details}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && details.current?.open) {
          event.preventDefault();
          event.stopPropagation();
          details.current.open = false;
          details.current.querySelector('summary')?.focus();
        }
      }}
    >
      <summary className="icon-button" role="button" aria-label="更多笔记操作" title="更多笔记操作">
        <MoreHorizontal size={22} />
      </summary>
      <div className="note-menu-panel" role="group" aria-label="笔记操作">
        <button onClick={() => run(onRename)}>重命名笔记</button>
        <button onClick={() => run(onExport)}>导出 ZIP</button>
        <button className="delete-note-action" onClick={() => run(onDelete)}>
          删除笔记
        </button>
        <details className="note-information">
          <summary>笔记信息</summary>
          <p>{path}</p>
          <p>
            {characters.toLocaleString()} 字符 · {lines} 行 · UTF-8
          </p>
          <p>导出 ZIP 包含当前笔记库。</p>
        </details>
      </div>
    </details>
  );
}

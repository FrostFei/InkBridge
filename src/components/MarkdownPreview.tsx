import { useEffect, useMemo, useState } from 'react';
import type { NoteFile } from '../core/types';
import { headingId, renderMarkdown, resolveNoteTargets } from '../markdown/render';

export function MarkdownPreview({
  text,
  path,
  files,
  externalImages,
  onNavigate,
  onMessage,
}: {
  text: string;
  path: string;
  files: NoteFile[];
  externalImages: boolean;
  onNavigate: (path: string, heading?: string) => void;
  onMessage: (text: string) => void;
}) {
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  const [choices, setChoices] = useState<{ paths: string[]; heading?: string } | null>(null);
  useEffect(() => {
    const next = new Map<string, string>();
    for (const file of files)
      if (file.current?.kind === 'binary' && file.current.blob) {
        const extension = file.path.split('.').pop()?.toLowerCase() || '';
        const mime = (
          {
            png: 'image/png',
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            gif: 'image/gif',
            webp: 'image/webp',
            avif: 'image/avif',
            svg: 'image/svg+xml',
            bmp: 'image/bmp',
          } as Record<string, string>
        )[extension];
        // GitHub's blob endpoint has no file MIME. Give image decoders the MIME
        // implied by this existing attachment path, without changing saved bytes.
        const blob = mime ? new Blob([file.current.blob], { type: mime }) : file.current.blob;
        next.set(file.path, URL.createObjectURL(blob));
      }
    setUrls(next);
    return () => next.forEach((url) => URL.revokeObjectURL(url));
  }, [files]);
  const html = useMemo(
    () => renderMarkdown(text, path, files, urls, externalImages),
    [text, path, files, urls, externalImages],
  );
  return (
    <>
      <article
        className="markdown-body"
        aria-label="Markdown 预览"
        onClick={(event) => {
          const anchor = (event.target as HTMLElement).closest('a');
          const href = anchor?.getAttribute('href');
          if (!href?.startsWith('#note:')) return;
          event.preventDefault();
          const target = decodeURIComponent(href.slice(6));
          const heading = target.includes('#') ? target.slice(target.indexOf('#') + 1) : undefined;
          const candidates = resolveNoteTargets(target, path, files);
          if (candidates.length > 1) {
            setChoices({ paths: candidates, heading });
            return;
          }
          if (!candidates.length) {
            onMessage('未找到链接目标：' + target);
            return;
          }
          if (candidates[0] === path && heading) {
            document.getElementById(headingId(heading))?.scrollIntoView({ behavior: 'smooth' });
            return;
          }
          const linked = files.find((file) => file.path === candidates[0]);
          if (linked?.current?.kind === 'binary') {
            const url = urls.get(linked.path);
            if (url) {
              const a = document.createElement('a');
              a.href = url;
              a.download = linked.path.split('/').pop()!;
              a.click();
            } else onMessage('此附件尚未下载。请前往附件面板下载后查看。');
          } else onNavigate(candidates[0], heading);
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {choices && (
        <div className="modal-backdrop" onClick={() => setChoices(null)}>
          <section
            className="dialog compact"
            role="dialog"
            aria-modal="true"
            aria-label="选择链接目标"
            onClick={(event) => event.stopPropagation()}
          >
            <h2>这个名字有多份笔记</h2>
            <p>请选择要打开的完整路径。</p>
            <div className="choice-list">
              {choices.paths.map((target) => (
                <button
                  key={target}
                  onClick={() => {
                    onNavigate(target, choices.heading);
                    setChoices(null);
                  }}
                >
                  {target}
                </button>
              ))}
            </div>
            <button className="secondary" onClick={() => setChoices(null)}>
              取消
            </button>
          </section>
        </div>
      )}
    </>
  );
}

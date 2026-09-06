import { Marked, type Tokens } from 'marked';
import DOMPurify from 'dompurify';
import type { NoteFile } from '../core/types';

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export const headingId = (text: string) =>
  text
    .replace(/<[^>]+>/g, '')
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/g, '-');

export function resolveNoteTargets(
  target: string,
  from: string,
  files: Pick<NoteFile, 'path' | 'current'>[],
): string[] {
  const raw = target.split('#')[0];
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    value = raw;
  }
  if (!value) return [from];
  if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//')) return [];
  const normalize = (path: string): string => {
    const parts: string[] = [];
    for (const part of path.split('/')) {
      if (part === '..') {
        if (!parts.length) return '';
        parts.pop();
      } else if (part && part !== '.') parts.push(part);
    }
    return parts.join('/');
  };
  const directory = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
  const relative = normalize(directory + value);
  const root = normalize(value.replace(/^\//, ''));
  const active = files.filter((file) => file.current !== null).map((file) => file.path);
  const candidates = [relative, relative + '.md', root, root + '.md'];
  // A path containing a directory is explicit. Bare wiki names must expose ambiguity.
  if (value.includes('/'))
    return [...new Set(candidates.filter((path) => active.includes(path)))].slice(0, 1);
  const byName = active.filter((path) => {
    const basename = path.split('/').pop()!;
    return basename === value || basename === value + '.md';
  });
  return [...new Set(byName.length ? byName : candidates.filter((path) => active.includes(path)))];
}

export function renderMarkdown(
  source: string,
  from: string,
  files: NoteFile[],
  blobUrls: Map<string, string>,
  allowExternalImages = false,
  embedDepth = 0,
): string {
  const parser = new Marked({ breaks: false, gfm: true });
  const noteLink = (target: string, label: string) =>
    `<a class="note-link" href="#note:${encodeURIComponent(target)}">${label}</a>`;
  const renderImage = (target: string, label: string): string => {
    if (/^https?:\/\//i.test(target))
      return allowExternalImages
        ? `<img loading="lazy" referrerpolicy="no-referrer" src="${escape(target)}" alt="${escape(label)}">`
        : '<span class="image-unavailable">外部图片已阻止 · 可在预览设置中开启</span>';
    const candidates = resolveNoteTargets(target, from, files);
    if (candidates.length !== 1)
      return noteLink(
        target,
        escape(candidates.length ? '选择嵌入目标：' + label : '嵌入不可用：' + label),
      );
    const path = candidates[0];
    const file = files.find((item) => item.path === path);
    if (file?.current?.kind === 'text' && embedDepth < 2)
      return `<aside class="note-embed">${noteLink(path, escape(label))}${renderMarkdown(file.current.text, path, files, blobUrls, allowExternalImages, embedDepth + 1)}</aside>`;
    const url = blobUrls.get(path);
    if (url && /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(path))
      return `<img loading="lazy" src="${escape(url)}" alt="${escape(label)}">`;
    return noteLink(target, escape(url ? '打开附件：' + label : '未下载附件或嵌入笔记：' + label));
  };
  parser.use({
    extensions: [
      {
        name: 'wikilink',
        level: 'inline',
        start: (src) => src.search(/!?\[\[/),
        tokenizer(src) {
          const match = /^(!?)\[\[([^\]\n]+)\]\]/.exec(src);
          if (!match) return;
          const [target, ...aliases] = match[2].split('|');
          return {
            type: 'wikilink',
            raw: match[0],
            target,
            label: aliases.join('|') || target,
            embed: !!match[1],
          };
        },
        renderer(token) {
          return token.embed
            ? renderImage(token.target, token.label)
            : noteLink(token.target, escape(token.label));
        },
      },
      {
        name: 'notetag',
        level: 'inline',
        start: (src) => src.search(/#[\p{L}\p{N}_]/u),
        tokenizer(src) {
          const match = /^#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/u.exec(src);
          return match ? { type: 'notetag', raw: match[0], text: match[0] } : undefined;
        },
        renderer(token) {
          return `<span class="note-tag">${escape(token.text)}</span>`;
        },
      },
    ],
    renderer: {
      // Raw HTML is displayed as source. It never enters an HTML parser with
      // active attributes such as external image URLs or event handlers.
      html(token: Tokens.HTML | Tokens.Tag) {
        return escape(token.text);
      },
      heading(token: Tokens.Heading) {
        return `<h${token.depth} id="${escape(headingId(token.text))}">${this.parser.parseInline(token.tokens)}</h${token.depth}>`;
      },
      link(token: Tokens.Link) {
        const label = this.parser.parseInline(token.tokens);
        const target = token.href.trim();
        if (/^https?:\/\//i.test(target) || /^mailto:/i.test(target))
          return `<a href="${escape(target)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
        if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('//')) return label;
        return noteLink(target, label);
      },
      image(token: Tokens.Image) {
        return renderImage(token.href, token.text);
      },
    },
  });
  let frontmatter = '';
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (match) {
    frontmatter = `<details class="frontmatter"><summary>笔记属性 · YAML</summary><pre>${escape(match[1])}</pre></details>`;
    source = source.slice(match[0].length);
  }
  const clean = DOMPurify.sanitize(frontmatter + parser.parse(source, { async: false }), {
    FORBID_TAGS: [
      'script',
      'style',
      'iframe',
      'object',
      'embed',
      'form',
      'input',
      'button',
      'video',
      'audio',
      'svg',
      'math',
    ],
    FORBID_ATTR: ['style', 'srcset'],
    ADD_ATTR: ['target'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|blob):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
  });
  const doc = new DOMParser().parseFromString(clean, 'text/html');
  const allowedBlobs = new Set(blobUrls.values());
  doc.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (!allowedBlobs.has(src) && !(allowExternalImages && /^https?:\/\//i.test(src))) {
      const placeholder = doc.createElement('span');
      placeholder.className = 'image-unavailable';
      placeholder.textContent = '图片未下载或外部图片已阻止';
      img.replaceWith(placeholder);
    } else {
      img.setAttribute('referrerpolicy', 'no-referrer');
    }
  });
  doc.querySelectorAll('a').forEach((anchor) => {
    const href = anchor.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
    } else if (!href.startsWith('#')) {
      anchor.removeAttribute('href');
    }
  });
  return doc.body.innerHTML;
}

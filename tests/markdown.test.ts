// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdown, resolveNoteTargets } from '../src/markdown/render';
import type { NoteFile } from '../src/core/types';

const note = (path: string, text = '# 正文'): NoteFile => ({
  workspaceId: 'test',
  path,
  current: { kind: 'text', text },
  base: null,
  baseSha: null,
  revision: 1,
  dirty: true,
});
function documentFor(html: string) {
  return new DOMParser().parseFromString(html, 'text/html');
}
describe('safe Obsidian Markdown rendering', () => {
  it('resolves Chinese relative paths and exposes same-name wiki ambiguity without case folding', () => {
    const files = [
      note('随记/索引.md'),
      note('随记/灵感.md'),
      note('项目/灵感.md'),
      note('Idea.md'),
      note('idea.md'),
    ];
    expect(resolveNoteTargets('灵感', '随记/索引.md', files)).toEqual([
      '随记/灵感.md',
      '项目/灵感.md',
    ]);
    expect(resolveNoteTargets('../项目/灵感.md#标题', '随记/索引.md', files)).toEqual([
      '项目/灵感.md',
    ]);
    expect(resolveNoteTargets('Idea', '随记/索引.md', files)).toEqual(['Idea.md']);
    expect(resolveNoteTargets('javascript:evil', '随记/索引.md', files)).toEqual([]);
  });
  it('supports aliases, anchors, tags and frontmatter without modifying the source', () => {
    const source =
      '---\r\ntags: [随记]\r\n---\r\n# 一个 标题\r\n\r\n[[灵感#第二节|看看灵感]] #随记\r\n';
    const original = source;
    const doc = documentFor(renderMarkdown(source, '索引.md', [note('灵感.md')], new Map()));
    expect(source).toBe(original);
    expect(doc.querySelector('.frontmatter')?.textContent).toContain('tags: [随记]');
    expect(doc.querySelector('h1')?.id).toBe('一个-标题');
    expect(doc.querySelector('a')?.textContent).toBe('看看灵感');
    expect(doc.querySelector('a')?.getAttribute('href')).toBe(
      '#note:' + encodeURIComponent('灵感#第二节'),
    );
    expect(doc.querySelector('.note-tag')?.textContent).toBe('#随记');
  });
  it('never renders active HTML or dangerous links from untrusted notes', () => {
    const source =
      '<img src="https://tracker.invalid/pixel" onerror="alert(1)"><script>alert(1)</script>\n\n[bad](javascript:alert%281%29) [data](data:text/html,evil)\n\n<iframe srcdoc="evil"></iframe>';
    const doc = documentFor(renderMarkdown(source, 'a.md', [], new Map()));
    expect(doc.querySelector('img,script,iframe,object,svg')).toBeNull();
    expect(doc.querySelector('[onerror],[onclick]')).toBeNull();
    expect(
      [...doc.querySelectorAll('a')].some((anchor) =>
        /javascript:|data:/i.test(anchor.getAttribute('href') || ''),
      ),
    ).toBe(false);
  });
  it('blocks external images by default and adds no-referrer only after explicit opt-in', () => {
    const source = '![外部](https://example.com/pic.png)';
    expect(
      documentFor(renderMarkdown(source, 'a.md', [], new Map())).querySelector('img'),
    ).toBeNull();
    const allowed = documentFor(renderMarkdown(source, 'a.md', [], new Map(), true)).querySelector(
      'img',
    );
    expect(allowed?.getAttribute('src')).toBe('https://example.com/pic.png');
    expect(allowed?.getAttribute('referrerpolicy')).toBe('no-referrer');
  });
  it('renders cached wiki images and bounded note embeds while retaining code literally', () => {
    const files: NoteFile[] = [
      note('a.md', 'A ![[b]]'),
      note('b.md', 'B ![[a]]'),
      { ...note('图片/花.png'), current: { kind: 'binary', sha: 'one' } },
    ];
    const doc = documentFor(
      renderMarkdown(
        '![[图片/花.png]]\n\n![[b]]\n\n`[[literal]]`',
        'a.md',
        files,
        new Map([['图片/花.png', 'blob:https://app.invalid/image']]),
      ),
    );
    expect(doc.querySelector('img')?.getAttribute('src')).toBe('blob:https://app.invalid/image');
    expect(doc.querySelectorAll('.note-embed').length).toBeLessThanOrEqual(2);
    expect(doc.querySelector('code')?.textContent).toBe('[[literal]]');
  });
  it('external links do not retain an opener', () => {
    const anchor = documentFor(
      renderMarkdown('[文档](https://example.com/docs)', 'a.md', [], new Map()),
    ).querySelector('a');
    expect(anchor?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(anchor?.getAttribute('target')).toBe('_blank');
  });
});

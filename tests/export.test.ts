import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { makeWorkspaceZip } from '../src/core/export';
import type { FileValue, NoteFile } from '../src/core/types';
const file = (path: string, current: FileValue | null): NoteFile => ({
  workspaceId: 'test',
  path,
  current,
  base: null,
  baseSha: null,
  revision: 1,
  dirty: true,
});
describe('ZIP local snapshot', () => {
  it('round-trips Chinese paths, CRLF and bytes; reports missing attachments and omits internal state', async () => {
    const { blob, missingPaths } = await makeWorkspaceZip([
      file('随笔/中文 空格.md', { kind: 'text', text: '---\r\ntags: [笔记]\r\n---\r\n你好\r\n' }),
      file('Images/a.png', {
        kind: 'binary',
        sha: 'sha',
        blob: new Blob([new Uint8Array([0, 1, 128, 255])]),
      }),
      file('Images/未下载.pdf', { kind: 'binary', sha: 'remote' }),
      file('deleted.md', null),
    ]);
    const zip = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(strFromU8(zip['随笔/中文 空格.md'])).toBe('---\r\ntags: [笔记]\r\n---\r\n你好\r\n');
    expect([...zip['Images/a.png']]).toEqual([0, 1, 128, 255]);
    expect(missingPaths).toEqual(['Images/未下载.pdf']);
    expect(Object.keys(zip)).not.toContain('deleted.md');
    const report = JSON.parse(strFromU8(zip['_InkBridge-export-report.json']));
    expect(report.missingAttachments).toEqual(missingPaths);
    expect(JSON.stringify(report)).not.toMatch(/token|baseSha|revision|workspaceId/i);
  });
  it('rejects unsafe paths', async () => {
    await expect(
      makeWorkspaceZip([file('../escape.md', { kind: 'text', text: 'bad' })]),
    ).rejects.toThrow('不安全');
  });
});

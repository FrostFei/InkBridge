import { strToU8, zipSync } from 'fflate';
import { db } from './db';
import type { NoteFile } from './types';

export async function makeWorkspaceZip(
  files: NoteFile[],
): Promise<{ blob: Blob; missingPaths: string[] }> {
  const entries: Record<string, Uint8Array> = Object.create(null);
  const missingPaths: string[] = [];
  for (const file of files) {
    if (!file.current) continue;
    // Never produce an archive capable of escaping its extraction directory.
    if (
      file.path.startsWith('/') ||
      file.path.includes('\\') ||
      file.path.split('/').some((p) => !p || p === '..' || p === '.')
    )
      throw new Error('无法导出不安全的文件路径。');
    if (file.current.kind === 'text') entries[file.path] = strToU8(file.current.text);
    else if (file.current.blob)
      entries[file.path] = new Uint8Array(await file.current.blob.arrayBuffer());
    else missingPaths.push(file.path);
  }
  let reportPath = '_InkBridge-export-report.json';
  while (reportPath in entries) reportPath = '_' + reportPath;
  entries[reportPath] = strToU8(
    JSON.stringify(
      {
        application: 'InkBridge',
        exportedAt: new Date().toISOString(),
        includedPaths: Object.keys(entries),
        missingAttachments: missingPaths,
        scope: '当前本地笔记及已下载附件。未支持的远端文件、Git 历史与未下载附件不在本 ZIP 内。',
      },
      null,
      2,
    ),
  );
  return {
    blob: new Blob([zipSync(entries, { level: 6 }).slice().buffer as ArrayBuffer], {
      type: 'application/zip',
    }),
    missingPaths,
  };
}

export async function exportWorkspaceZip(workspaceId: string) {
  const files = await db.transaction('r', db.files, () =>
    db.files.where('workspaceId').equals(workspaceId).toArray(),
  );
  return makeWorkspaceZip(files);
}

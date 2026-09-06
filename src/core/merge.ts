import { diff3Merge } from 'node-diff3';
import { equalValue } from './types';
import type { Conflict, FileValue } from './types';

export type MergeResult =
  { value: FileValue | null; conflict?: never } | { conflict: Conflict['type']; value?: never };
// Keep each original newline attached to its line. Splitting on whitespace or rejoining
// with \n would silently rewrite unedited frontmatter, CRLF and final-newline state.
const lines = (text: string): string[] => text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];

export function mergeValues(
  base: FileValue | null,
  local: FileValue | null,
  remote: FileValue | null,
): MergeResult {
  if (equalValue(local, remote)) return { value: local };
  if (equalValue(local, base)) return { value: remote };
  if (equalValue(remote, base)) return { value: local };
  if (!base) return { conflict: 'add-add' };
  if (!local || !remote) return { conflict: 'delete-modify' };
  if (base.kind !== 'text' || local.kind !== 'text' || remote.kind !== 'text')
    return { conflict: 'binary' };
  const chunks = diff3Merge(lines(local.text), lines(base.text), lines(remote.text), {
    excludeFalseConflicts: true,
  });
  if (chunks.some((chunk) => 'conflict' in chunk)) return { conflict: 'text' };
  return { value: { kind: 'text', text: chunks.flatMap((chunk) => chunk.ok ?? []).join('') } };
}

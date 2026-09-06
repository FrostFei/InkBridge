import Dexie, { type Table } from 'dexie';

// Content-addressed download checkpoints are separate from confirmed note baselines.
// A partial download can never turn into a remote deletion or an empty note.
class DownloadCache extends Dexie {
  blobs!: Table<{ scope: string; sha: string; blob: Blob }, [string, string]>;
  constructor() {
    super('inkbridge-downloads');
    this.version(1).stores({ blobs: '[scope+sha],scope' });
  }
}
const downloads = new DownloadCache();
export function blobCacheFor(scope: string) {
  return {
    async get(sha: string) {
      return (await downloads.blobs.get([scope, sha]))?.blob;
    },
    async put(sha: string, blob: Blob) {
      await downloads.blobs.put({ scope, sha, blob });
    },
  };
}

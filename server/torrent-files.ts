import type { TorrentFile } from "./types.js";

const MAX_FILES = 5_000;
const MAX_PATH_LENGTH = 1_024;
const MAX_CHANGES_PER_GROUP = 50;
const FILE_LIST_TIMEOUT_MS = 8_000;

export function fileListSignal(parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(FILE_LIST_TIMEOUT_MS);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

export function fileSize(value: string): TorrentFile["size"] | undefined {
  const size = value.trim();
  const bytes = /\(([\d\s]+)(?:\s*bytes?)?\)$/iu.exec(size)?.[1] ?? /^(\d+)(?:\s*bytes?)?$/iu.exec(size)?.[1];
  if (bytes !== undefined) {
    const count = Number(bytes.replace(/\s/g, ""));
    return Number.isSafeInteger(count) ? count : undefined;
  }
  // Some file trees only expose rounded sizes. Preserve the tracker's precision.
  if (/^\d+(?:[.,]\d+)?\s*(?:[kmgtp]i?b|b|byte[s]?|[кмгтп]?б|байт[аов]*)$/iu.test(size)) {
    return size.replace(/\s+/g, " ");
  }
}

export function fileManifest(rows: { path: string; size: TorrentFile["size"] | undefined }[]): TorrentFile[] | undefined {
  if (!rows.length || rows.length > MAX_FILES) return;
  const files = new Map<string, TorrentFile>();
  for (const { path, size } of rows) {
    if (!path || path.length > MAX_PATH_LENGTH || size === undefined || files.has(path)) return;
    files.set(path, { path, size });
  }
  return [...files.values()];
}

interface FileDelta {
  path: string;
  before?: TorrentFile["size"];
  after?: TorrentFile["size"];
}

export function diffTorrentFiles(previous: TorrentFile[] | undefined, current: TorrentFile[] | undefined) {
  if (!previous || !current) return;
  const group = () => ({ count: 0, files: [] as FileDelta[] });
  const added = group(), removed = group(), resized = group();
  const record = (changes: ReturnType<typeof group>, file: FileDelta) => {
    changes.count++;
    if (changes.files.length < MAX_CHANGES_PER_GROUP) changes.files.push(file);
  };
  const before = new Map(previous.map((file) => [file.path, file.size]));
  for (const { path, size } of current) {
    const oldSize = before.get(path);
    if (oldSize === undefined) record(added, { path, after: size });
    else if (oldSize !== size) record(resized, { path, before: oldSize, after: size });
    before.delete(path);
  }
  for (const [path, size] of before) record(removed, { path, before: size });
  if (added.count || removed.count || resized.count) return { added, removed, resized };
}

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DomainError } from './backend.js';
import { SharedVersionedDocument, type SharedDocumentStore } from './shared-projects.js';
import { voiceError, voiceOperationSchema } from './voices.js';

const MAX_RECORD_BYTES = 16 * 1024;
const comparable = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
const within = (root: string, target: string) => {
  const path = relative(root, target);
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
};

async function checkedDirectory(root: string, directory: string): Promise<boolean> {
  try {
    const rootStat = await lstat(root);
    const directoryStat = await lstat(directory);
    const actualRoot = await realpath(root);
    const actualDirectory = await realpath(directory);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !directoryStat.isDirectory()
      || directoryStat.isSymbolicLink() || comparable(actualRoot) !== comparable(root)
      || comparable(actualDirectory) !== comparable(directory) || !within(actualRoot, actualDirectory)) {
      throw voiceError('UPSTREAM');
    }
    return true;
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return false;
    throw voiceError('UPSTREAM');
  }
}

async function readRecord(root: string, directory: string, name: string) {
  const path = join(directory, name);
  if (!await checkedDirectory(root, directory)) throw voiceError('UPSTREAM');
  let text: string;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_RECORD_BYTES
      || !within(root, await realpath(path))) throw voiceError('UPSTREAM');
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!await checkedDirectory(root, directory)) throw voiceError('UPSTREAM');
      const opened = await handle.stat();
      const named = await lstat(path);
      if (!opened.isFile() || named.isSymbolicLink() || !named.isFile() || opened.size > MAX_RECORD_BYTES
        || opened.dev !== named.dev || opened.ino !== named.ino
        || comparable(await realpath(path)) !== comparable(path)) throw voiceError('UPSTREAM');
      // Read one bounded sentinel byte so a concurrently growing file cannot
      // turn the migration into an unbounded read after the initial stat.
      const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
      let count = 0;
      while (count < bytes.byteLength) {
        const { bytesRead } = await handle.read(bytes, count, bytes.byteLength - count, count);
        if (!bytesRead) break;
        count += bytesRead;
      }
      if (count > MAX_RECORD_BYTES) throw voiceError('UPSTREAM');
      text = bytes.subarray(0, count).toString('utf8');
    } finally { await handle.close(); }
  } catch { throw voiceError('UPSTREAM'); }
  try {
    if (Buffer.byteLength(text, 'utf8') > MAX_RECORD_BYTES) throw voiceError('OUTCOME_UNKNOWN');
    const record = voiceOperationSchema.parse(JSON.parse(text));
    const key = createHash('sha256').update(`${record.accountScope}\0${record.requestId}`).digest('hex');
    if (`${key}.json` !== name || !record.accountScope || record.accountScope.length > 200
      || !/^[A-Za-z0-9_-]{1,200}$/.test(record.requestId)
      || (record.result && record.result.requestId !== record.requestId)) throw voiceError('OUTCOME_UNKNOWN');
    return { key, record };
  } catch { throw voiceError('OUTCOME_UNKNOWN'); }
}

/** Read-only legacy migration. Existing matching remote claims always remain authoritative. */
export async function migrateLegacyVoiceOperations(directory: string, store: SharedDocumentStore): Promise<{ migrated: number }> {
  const root = resolve(directory);
  const operations = join(root, 'voice-operations');
  if (!await checkedDirectory(root, operations)) return { migrated: 0 };
  let names: string[];
  try { names = (await readdir(operations)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort(); }
  catch { throw voiceError('UPSTREAM'); }
  let migrated = 0;
  for (const name of names) {
    const { key, record } = await readRecord(root, operations, name);
    const file = new SharedVersionedDocument(store, `operations/${key}`, value => {
      try { return voiceOperationSchema.parse(value); }
      catch { throw voiceError('OUTCOME_UNKNOWN'); }
    });
    const matches = (existing: typeof record) => existing.accountScope === record.accountScope
      && existing.requestId === record.requestId && existing.fingerprint === record.fingerprint;
    let existing = await file.read();
    if (existing) {
      if (!matches(existing.value)) throw voiceError('REQUEST_ID_REUSED');
      continue;
    }
    try { await file.publish(undefined, record); migrated += 1; }
    catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'REVISION_CONFLICT') throw error;
      existing = await file.read();
      if (!existing || !matches(existing.value)) throw voiceError('REQUEST_ID_REUSED');
    }
  }
  return { migrated };
}

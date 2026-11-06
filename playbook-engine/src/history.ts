/**
 * Per-step file states (O27). Each execution keeps the exact bytes of what it consumed and published in
 * `<historyDir>/<execId>/objects/<sha256>`, so a later edit of the live file cannot erase the state a
 * step saw. An object is a copy (copy-on-write where the filesystem has it), never a hard link: a file
 * rewritten in place must leave its snapshot alone. No size cap.
 */
import { constants, closeSync, copyFileSync, existsSync, openSync, readSync, renameSync, rmSync, statSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { FileRecord, Occurrence } from './state.ts';

export const objectsDir = (historyDir: string, execId: string): string => join(historyDir, execId, 'objects');

let seq = 0;

function sha256Of(path: string): { sha256: string; size: number } {
  const hash = createHash('sha256');
  const buf = Buffer.allocUnsafe(1 << 20);
  const fd = openSync(path, 'r');
  let size = 0;
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
      size += n;
    }
  } finally {
    closeSync(fd);
  }
  return { sha256: hash.digest('hex'), size };
}

/**
 * Copy `path` into the execution's objects directory under the hash of the copy, so the object is
 * always the bytes its name says. A file that cannot be read gives a record with no hash.
 */
export function snapshotOccurrence(historyDir: string, execId: string, occurrence: Occurrence): FileRecord {
  const record: FileRecord = { occurrence: occurrence.id, role: occurrence.role, path: occurrence.path };
  const dir = objectsDir(historyDir, execId);
  const tmp = join(dir, `.tmp-${process.pid}-${seq++}`);
  try {
    mkdirSync(dir, { recursive: true });
    copyFileSync(occurrence.path, tmp, constants.COPYFILE_FICLONE);
    const { sha256, size } = sha256Of(tmp);
    const target = join(dir, sha256);
    if (existsSync(target)) rmSync(tmp);
    else renameSync(tmp, target);
    record.sha256 = sha256;
    record.size = size;
  } catch (error) {
    // The record keeps no sha256, which is how a reader tells a step whose input was not captured.
    console.error(`playbook-engine: ${execId} ${occurrence.id}: ${occurrence.path} not captured: ${error}`);
    rmSync(tmp, { force: true });
  }
  return record;
}

export type ObjectRead = { kind: 'found'; path: string } | { kind: 'pruned' } | { kind: 'missing' };

/** Where a recorded object is. `pruned` means the execution's `objects/` directory is gone (the task was archived). */
export function findObject(historyDir: string, execId: string, sha256: string): ObjectRead {
  if (!/^[0-9a-f]{64}$/.test(sha256)) return { kind: 'missing' };
  const dir = objectsDir(historyDir, execId);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return { kind: 'pruned' };
  const path = join(dir, sha256);
  return existsSync(path) ? { kind: 'found', path } : { kind: 'missing' };
}

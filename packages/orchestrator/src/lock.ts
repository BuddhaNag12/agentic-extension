import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * A lockfile that survives extension reloads (§2.2). It records the daemon's
 * pid and endpoint so a reloading window can attach to the running daemon
 * instead of spawning a second one.
 */
export interface LockInfo {
  pid: number;
  endpoint: string;
  startedAt: number;
  version: string;
  /**
   * Which build this daemon is running, as the mtime of the bundle it was
   * started from.
   *
   * `PROTOCOL_VERSION` was supposed to catch a client and daemon disagreeing,
   * and did not: it is a hand-maintained constant that nobody bumped across
   * five added methods, so an extension upgraded underneath a running daemon
   * kept talking to the old one and its new requests went to a process that
   * had never heard of them. A version nobody remembers to bump is not a
   * version check; a build's own mtime cannot be forgotten.
   */
  entryMtimeMs?: number;
}

/** The build identity of a daemon bundle, or undefined if it is not there. */
export function entryBuildId(entry: string): number | undefined {
  try {
    return statSync(entry).mtimeMs;
  } catch {
    return undefined;
  }
}

export function readLock(lockFile: string): LockInfo | undefined {
  if (!existsSync(lockFile)) return undefined;
  try {
    return JSON.parse(readFileSync(lockFile, 'utf8')) as LockInfo;
  } catch {
    return undefined;
  }
}

export function writeLock(lockFile: string, info: LockInfo): void {
  mkdirSync(dirname(lockFile), { recursive: true });
  writeFileSync(lockFile, JSON.stringify(info, null, 2), 'utf8');
}

export function clearLock(lockFile: string): void {
  rmSync(lockFile, { force: true });
}

/** Signal 0 tests for existence without delivering anything. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * A lock whose process is gone is stale — clear it so the next start is not
 * blocked forever by a daemon that crashed.
 */
export function readLiveLock(lockFile: string): LockInfo | undefined {
  const lock = readLock(lockFile);
  if (!lock) return undefined;
  if (isProcessAlive(lock.pid)) return lock;
  clearLock(lockFile);
  return undefined;
}

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ensureAgentsMd, fileExists, readJson, writeJson } from './fsWorkspace';
import {
  RunQLStorageRoot,
  StorageLocation,
  tryResolveRunQLRoot,
} from './storageRoot';
import { Logger } from './logger';

const LOCK_RELATIVE = ['system', 'storage-change.lock.json'];
const COMMIT_MARKER_RELATIVE = ['system', 'storage-change.commit.json'];
const BACKUP_DIR = ['system', 'migration_backup'];
const BACKUP_PREFIX = 'storage-root-';
const LOCK_TTL_MS = 5 * 60_000;
// The "recently committed" marker's TTL. Long enough for VS Code
// Settings Sync to propagate a settings.json change to peer windows on
// the same machine (usually seconds, worst-case tens of seconds), short
// enough that a subsequent, genuinely new migration between the same
// two roots isn't wrongly suppressed.
const COMMIT_MARKER_TTL_MS = 5 * 60_000;
const RETENTION_KEEP = 5;
const RETENTION_MS = 30 * 24 * 60 * 60_000;
const SESSION_ID = generateSessionId();

function generateSessionId(): string {
  return `rq-${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
}

interface StorageChangeLock {
  version: '0.1';
  oldRoot: string;
  newRoot: string;
  windowId: string;
  createdAt: string;
  expiresAt: string;
}

/**
 * Persisted "recently committed" record, written after a command flow
 * successfully commits a storage-change. Peer VS Code windows on the
 * same machine receive the settings.json change via Settings Sync and
 * would otherwise fire their own settings-edit auto-migration flow
 * against a source root that Window A has already migrated. On
 * receiving the event, peers check for a non-expired marker matching
 * the same (oldRoot, newRoot) pair from a different window and
 * short-circuit if found.
 */
interface StorageChangeCommitMarker {
  version: '0.1';
  oldRoot: string;
  newRoot: string;
  windowId: string;
  committedAt: string;
  expiresAt: string;
}

// -----------------------------------------------------------------------------
// Storage root inspection helpers
// -----------------------------------------------------------------------------

/**
 * A directory looks like a RunQL storage root when queries/, schemas/, or
 * system/ subdirectories are present.
 */
export async function looksLikeRunqlRoot(uri: vscode.Uri): Promise<boolean> {
  for (const sub of ['queries', 'schemas', 'system']) {
    if (await fileExists(vscode.Uri.joinPath(uri, sub))) return true;
  }
  return false;
}

/**
 * True when the storage root contains real RunQL data.
 *
 * We check for specifically-RunQL-owned files rather than "any file in
 * queries/ or schemas/", because a user-picked custom path might have
 * `queries/` from dbt / prisma / Rails / etc. and we don't want those
 * folders misclassified as populated RunQL storage. Signals we look for
 * (any one suffices):
 *
 *   - `system/connections.json`             — RunQL connection registry
 *   - `system/queries/queryIndex.json`      — RunQL query index
 *   - `system/queries/queryHistory.json`    — RunQL run history
 *   - `schemas/<connection>/manifest.json`  — RunQL schema bundle manifest
 *
 * Empty scaffold (only `queries/`, `schemas/`, `system/` present, no
 * files) returns false so the migration flow routes to the
 * empty-destination dialog.
 */
export async function hasRunqlData(uri: vscode.Uri): Promise<boolean> {
  if (!(await fileExists(uri))) return false;
  if (await fileExists(vscode.Uri.joinPath(uri, 'system', 'connections.json'))) return true;
  if (await fileExists(vscode.Uri.joinPath(uri, 'system', 'queries', 'queryIndex.json'))) return true;
  if (await fileExists(vscode.Uri.joinPath(uri, 'system', 'queries', 'queryHistory.json'))) return true;
  // Look for a schemas/<connection>/manifest.json — RunQL's specific
  // per-connection layout, unlikely to appear from unrelated tooling.
  const schemasUri = vscode.Uri.joinPath(uri, 'schemas');
  if (await fileExists(schemasUri)) {
    let subdirs: [string, vscode.FileType][];
    try {
      subdirs = await vscode.workspace.fs.readDirectory(schemasUri);
    } catch {
      subdirs = [];
    }
    for (const [name, type] of subdirs) {
      if (type !== vscode.FileType.Directory) continue;
      const manifest = vscode.Uri.joinPath(schemasUri, name, 'manifest.json');
      if (await fileExists(manifest)) return true;
    }
  }
  return false;
}

function isFilesystemRoot(fsPath: string): boolean {
  const parsed = path.parse(fsPath);
  return parsed.root === fsPath;
}

function isWindowsDriveRoot(fsPath: string): boolean {
  return /^[A-Za-z]:[\\/]?$/.test(fsPath);
}

/** True when the source root passes safety checks for destructive cleanup. */
export function isSafeToDeleteRoot(uri: vscode.Uri): boolean {
  if (uri.scheme !== 'file') return false;
  const fsPath = path.normalize(uri.fsPath);
  if (isFilesystemRoot(fsPath) || isWindowsDriveRoot(fsPath)) return false;
  if (fsPath === path.normalize(os.homedir())) return false;
  if (fsPath === path.normalize('/workspaces')) return false;
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const f of folders) {
    if (f.uri.scheme === 'file' && fsPath === path.normalize(f.uri.fsPath)) {
      return false;
    }
  }
  return true;
}

// -----------------------------------------------------------------------------
// Cross-window prompt lock
// -----------------------------------------------------------------------------

function lockUri(root: RunQLStorageRoot): vscode.Uri {
  return vscode.Uri.joinPath(root.uri, ...LOCK_RELATIVE);
}

async function readLock(uri: vscode.Uri): Promise<StorageChangeLock | undefined> {
  if (!(await fileExists(uri))) return undefined;
  try {
    return await readJson<StorageChangeLock>(uri);
  } catch {
    return undefined;
  }
}

function isLockActive(lock: StorageChangeLock | undefined): boolean {
  if (!lock) return false;
  const expires = Date.parse(lock.expiresAt);
  if (!Number.isFinite(expires)) return false;
  return Date.now() < expires;
}

/**
 * Best-effort coordination marker. Returns undefined when another
 * non-expired lock owned by a different window already exists for the
 * same (oldRoot,newRoot) pair.
 */
export async function acquireStorageChangeLock(
  hostRoot: RunQLStorageRoot,
  oldRoot: string,
  newRoot: string
): Promise<vscode.Uri | undefined> {
  const uri = lockUri(hostRoot);
  try {
    await vscode.workspace.fs.createDirectory(
      vscode.Uri.joinPath(hostRoot.uri, 'system')
    );
  } catch {
    // Directory may already exist
  }
  const existing = await readLock(uri);
  if (
    isLockActive(existing) &&
    existing?.oldRoot === oldRoot &&
    existing?.newRoot === newRoot &&
    existing?.windowId !== SESSION_ID
  ) {
    return undefined;
  }
  const now = Date.now();
  const lock: StorageChangeLock = {
    version: '0.1',
    oldRoot,
    newRoot,
    windowId: SESSION_ID,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + LOCK_TTL_MS).toISOString(),
  };
  // Reduce the read-then-write TOCTOU window using a temp-file +
  // rename pattern. VS Code's `fs.rename` doesn't guarantee failure
  // on an existing destination across all filesystems, but it does
  // narrow the race considerably vs. `writeJson` directly. After the
  // rename we re-read and confirm we own the lock; if not, we're the
  // loser of a concurrent acquisition and back off.
  const tmpUri = vscode.Uri.joinPath(
    hostRoot.uri,
    ...LOCK_RELATIVE.slice(0, -1),
    `.storage-change.lock.${SESSION_ID}.${now}.tmp`
  );
  try {
    await writeJson(tmpUri, lock);
    try {
      await vscode.workspace.fs.rename(tmpUri, uri, { overwrite: false });
    } catch {
      // Rename failed — destination existed. Check whether an active
      // lock owned by another window materialized between our earlier
      // check and this rename. If so, back off.
      const afterRace = await readLock(uri);
      if (
        isLockActive(afterRace) &&
        afterRace?.oldRoot === oldRoot &&
        afterRace?.newRoot === newRoot &&
        afterRace?.windowId !== SESSION_ID
      ) {
        try { await vscode.workspace.fs.delete(tmpUri); } catch { /* best effort */ }
        return undefined;
      }
      // Otherwise proceed with overwrite (expired or same-window lock).
      try {
        await vscode.workspace.fs.rename(tmpUri, uri, { overwrite: true });
      } catch (e) {
        Logger.warn('Failed to install storage-change lock after collision', e);
        try { await vscode.workspace.fs.delete(tmpUri); } catch { /* best effort */ }
        return uri;
      }
    }
    // Post-write confirmation: re-read and verify we own the file.
    // If another window's rename beat us in a very small window, back
    // out so both sides don't think they hold the lock.
    const confirm = await readLock(uri);
    if (confirm && confirm.windowId !== SESSION_ID) {
      return undefined;
    }
    return uri;
  } catch (e) {
    Logger.warn('Failed to write storage-change lock', e);
    return uri;
  }
}

/**
 * Suppress the settings-change-driven auto-migration briefly. Returned
 * function releases the suppression. Nestable — the flag is a depth
 * counter so overlapping commands don't clobber each other.
 *
 * Used by the changeLocation / moveFolder command handlers, which
 * orchestrate their own flow (with a revert callback). Without this
 * guard, a user cancelling the first prompt causes revertSetting() to
 * update the setting back, which fires onDidChangeStorageRoot again,
 * which fires a second migration flow for the revert direction — the
 * exact behavior we don't want after cancel.
 */
let _suppressAutoMigrationDepth = 0;
export function suppressAutoMigration(): () => void {
  _suppressAutoMigrationDepth++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    _suppressAutoMigrationDepth = Math.max(0, _suppressAutoMigrationDepth - 1);
  };
}
export function isAutoMigrationSuppressed(): boolean {
  return _suppressAutoMigrationDepth > 0;
}

// ----------------------------------------------------------------------------
// Deterministic "we just wrote this settings state" tracker
// ----------------------------------------------------------------------------

/**
 * The settings state a command handler is about to (or has just) committed.
 * The settings-change subscriber compares its "next" resolved root against
 * this expectation and skips the auto-migration if they match — meaning WE
 * are the source of the change, not a direct settings.json edit.
 *
 * Matching is done on the resolved storage-root display path, which is
 * stable across the `customPath` + `location` two-step commit. This
 * replaces the previous wall-clock 750ms suppression window, which was
 * fragile under settings-sync, contended writes, or slow disk.
 */
interface ExpectedNextRoot {
  displayPath: string;
  location: StorageLocation;
}

let _expectedNextRoot: ExpectedNextRoot | null = null;

export function markProgrammaticStorageChange(next: ExpectedNextRoot): void {
  _expectedNextRoot = next;
}

/**
 * Returns true iff the given resolved root matches the expected-next
 * marker. Consumes the marker on match — future events fall through.
 */
export function consumeExpectedNextRootIfMatches(
  candidate: RunQLStorageRoot | undefined
): boolean {
  if (!_expectedNextRoot || !candidate) return false;
  if (
    candidate.displayPath === _expectedNextRoot.displayPath &&
    candidate.location === _expectedNextRoot.location
  ) {
    _expectedNextRoot = null;
    return true;
  }
  return false;
}

/**
 * Clear the expected-next marker without matching. Used from finally
 * blocks so a mid-flow error doesn't leave a stale expectation.
 */
export function clearExpectedNextRoot(): void {
  _expectedNextRoot = null;
}

function commitMarkerUri(root: RunQLStorageRoot): vscode.Uri {
  return vscode.Uri.joinPath(root.uri, ...COMMIT_MARKER_RELATIVE);
}

/**
 * Write a "recently committed" marker at the new root after a
 * successful storage-change command. Peer windows on the same machine
 * will find this marker when their settings-edit event fires and skip
 * their own migration flow.
 */
export async function writeStorageChangeCommitMarker(
  nextRoot: RunQLStorageRoot,
  oldRootDisplayPath: string
): Promise<void> {
  const uri = commitMarkerUri(nextRoot);
  try {
    await vscode.workspace.fs.createDirectory(
      vscode.Uri.joinPath(nextRoot.uri, 'system')
    );
  } catch { /* directory may exist */ }
  const now = Date.now();
  const marker: StorageChangeCommitMarker = {
    version: '0.1',
    oldRoot: oldRootDisplayPath,
    newRoot: nextRoot.displayPath,
    windowId: SESSION_ID,
    committedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + COMMIT_MARKER_TTL_MS).toISOString(),
  };
  try {
    await writeJson(uri, marker);
  } catch (e) {
    Logger.warn('Failed to write storage-change commit marker', e);
  }
}

/**
 * True when the given root has a non-expired commit marker matching
 * the (oldRoot, newRoot) transition owned by a different window. Peer
 * windows call this from the settings-edit subscriber to short-circuit
 * a redundant migration flow.
 */
export async function hasRecentPeerCommit(
  nextRoot: RunQLStorageRoot,
  oldRootDisplayPath: string
): Promise<boolean> {
  const uri = commitMarkerUri(nextRoot);
  if (!(await fileExists(uri))) return false;
  let marker: StorageChangeCommitMarker | undefined;
  try {
    marker = await readJson<StorageChangeCommitMarker>(uri);
  } catch {
    return false;
  }
  if (!marker) return false;
  const expiresAt = Date.parse(marker.expiresAt);
  if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) return false;
  if (marker.oldRoot !== oldRootDisplayPath) return false;
  if (marker.newRoot !== nextRoot.displayPath) return false;
  // Only defer to peer commits — an old marker from THIS window means
  // we're the one still in the middle of things.
  if (marker.windowId === SESSION_ID) return false;
  return true;
}

export async function releaseStorageChangeLock(uri: vscode.Uri | undefined): Promise<void> {
  if (!uri) return;
  try {
    const current = await readLock(uri);
    if (current && current.windowId !== SESSION_ID) return;
    await vscode.workspace.fs.delete(uri);
  } catch {
    // Ignored - best effort
  }
}

/**
 * Delete an expired storage-change lock at the resolved storage root.
 * Called at startup so a crashed prior session doesn't leave a stale
 * marker suppressing prompts until its TTL passes. Only removes locks
 * whose `expiresAt` is in the past; active locks (whether ours or
 * another window's) are left alone.
 */
export async function pruneExpiredStorageChangeLock(
  root: RunQLStorageRoot
): Promise<boolean> {
  const uri = lockUri(root);
  const lock = await readLock(uri);
  if (!lock) return false;
  if (isLockActive(lock)) return false;
  try {
    await vscode.workspace.fs.delete(uri);
    Logger.info(`Pruned expired storage-change lock at ${uri.fsPath}`);
    return true;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Recursive filesystem operations
// -----------------------------------------------------------------------------

async function copyTree(
  src: vscode.Uri,
  dest: vscode.Uri,
  skip?: (name: string) => boolean
): Promise<void> {
  try {
    await vscode.workspace.fs.createDirectory(dest);
  } catch {
    // Directory already exists - safe to ignore
  }
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(src);
  } catch {
    return;
  }
  for (const [name, type] of entries) {
    if (skip && skip(name)) continue;
    const s = vscode.Uri.joinPath(src, name);
    const d = vscode.Uri.joinPath(dest, name);
    if (type === vscode.FileType.Directory) {
      // Propagate the skip filter to nested recursions so
      // `migration_backup` under `system/` is honored just like the top-level
      // filter — critical when the backup destination lives inside the
      // source tree (conflict-flow "Replace after backup").
      await copyTree(s, d, skip);
    } else if (type === vscode.FileType.File) {
      try {
        const bytes = await vscode.workspace.fs.readFile(s);
        await vscode.workspace.fs.writeFile(d, bytes);
      } catch (e) {
        Logger.warn(`Copy failed: ${s.toString()} -> ${d.toString()}`, e);
      }
    }
  }
}

async function countEntries(
  uri: vscode.Uri,
  skip?: (name: string) => boolean
): Promise<number> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(uri);
    let n = 0;
    for (const [name, type] of entries) {
      if (skip && skip(name)) continue;
      n += 1;
      if (type === vscode.FileType.Directory) {
        n += await countEntries(vscode.Uri.joinPath(uri, name), skip);
      }
    }
    return n;
  } catch {
    return 0;
  }
}

async function deleteTree(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false });
  } catch (e) {
    Logger.warn(`Delete failed: ${uri.toString()}`, e);
  }
}

async function backupInto(
  hostRoot: vscode.Uri,
  sourceRoot: vscode.Uri
): Promise<vscode.Uri> {
  const backupParent = vscode.Uri.joinPath(hostRoot, ...BACKUP_DIR);
  try {
    await vscode.workspace.fs.createDirectory(backupParent);
  } catch {
    // Backup parent already exists
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupUri = vscode.Uri.joinPath(backupParent, `${BACKUP_PREFIX}${stamp}`);
  await copyTree(sourceRoot, backupUri, (name) => name === 'migration_backup');
  return backupUri;
}

// -----------------------------------------------------------------------------
// Backup retention pruning
// -----------------------------------------------------------------------------

/**
 * Prune storage-root migration backups per the spec's retention policy:
 *   - keep newest 5 backups
 *   - also keep any backup created within the last 30 days
 *   - only touch entries whose names match `storage-root-*`
 */
export async function pruneMigrationBackups(
  root: RunQLStorageRoot
): Promise<{ pruned: string[] }> {
  const backupParent = vscode.Uri.joinPath(root.uri, ...BACKUP_DIR);
  if (!(await fileExists(backupParent))) return { pruned: [] };
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(backupParent);
  } catch {
    return { pruned: [] };
  }
  const backups = entries
    .filter(([name, type]) => type === vscode.FileType.Directory && name.startsWith(BACKUP_PREFIX))
    .map(([name]) => ({ name, stamp: parseBackupStamp(name) }))
    .filter((b) => b.stamp !== undefined)
    .sort((a, b) => (b.stamp as number) - (a.stamp as number));

  const cutoff = Date.now() - RETENTION_MS;
  const pruned: string[] = [];
  for (let i = 0; i < backups.length; i++) {
    const b = backups[i];
    if (i < RETENTION_KEEP) continue;
    if ((b.stamp as number) >= cutoff) continue;
    try {
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(backupParent, b.name), {
        recursive: true,
        useTrash: false,
      });
      pruned.push(b.name);
    } catch (e) {
      Logger.warn(`Failed to prune backup ${b.name}`, e);
    }
  }
  return { pruned };
}

function parseBackupStamp(name: string): number | undefined {
  if (!name.startsWith(BACKUP_PREFIX)) return undefined;
  const raw = name.substring(BACKUP_PREFIX.length);
  // stamps use : and . replaced by -, so restore for Date parsing
  const iso = raw.replace(/-(\d{2})-(\d{2})-(\d{3})Z$/, ':$1:$2.$3Z');
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// -----------------------------------------------------------------------------
// User-facing migration flows
// -----------------------------------------------------------------------------

export type MigrationTrigger = 'setting-change' | 'command';

export interface StorageChangeFlowContext {
  /** The root data was in before the change (still on disk). */
  previousRoot: RunQLStorageRoot;
  /** The newly-resolved root. */
  nextRoot: RunQLStorageRoot;
  /** How this flow was triggered. */
  trigger: MigrationTrigger;
  /** Callback used to revert the setting if the user cancels. */
  revertSetting?: () => Promise<void>;
}

export type FlowOutcome =
  | 'moved'
  | 'copied'
  | 'used-existing'
  | 'started-empty'
  | 'replaced'
  | 'cancelled'
  | 'noop-same-root'
  | 'no-source-data'
  | 'concurrent-in-progress';

/**
 * Top-level migration/link flow triggered when the resolved storage root
 * changes. Chooses the right sub-flow (empty destination vs. conflict)
 * and coordinates the destructive parts safely.
 */
export async function runStorageChangeFlow(
  ctx: StorageChangeFlowContext
): Promise<FlowOutcome> {
  const { previousRoot, nextRoot, trigger, revertSetting } = ctx;

  if (previousRoot.uri.toString() === nextRoot.uri.toString()) {
    return 'noop-same-root';
  }

  const sourceHasData = await hasRunqlData(previousRoot.uri);
  if (!sourceHasData) return 'no-source-data';

  const destExists = await fileExists(nextRoot.uri);
  const destHasData = destExists ? await hasRunqlData(nextRoot.uri) : false;

  // Dedup across windows on the same (oldRoot,newRoot) pair.
  const lockHost = destExists ? nextRoot : previousRoot;
  const lockAcquired = await acquireStorageChangeLock(
    lockHost,
    previousRoot.displayPath,
    nextRoot.displayPath
  );
  if (lockAcquired === undefined) {
    Logger.info('Storage-change prompt already active in another window; skipping.');
    return 'concurrent-in-progress';
  }

  try {
    if (destHasData) {
      return await runConflictFlow(ctx);
    }
    return await runEmptyDestinationFlow(ctx);
  } finally {
    await releaseStorageChangeLock(lockAcquired);
    // runStorageChangeFlow is invoked AFTER the settings have already
    // changed (typically from the direct settings.json-edit subscriber),
    // so `tryResolveRunQLRoot()` inside postMigrationHousekeeping
    // reflects the new mode correctly.
    await postMigrationHousekeeping();
    void ctx; // trigger is retained for future telemetry hooks
    void revertSetting; // handled inside sub-flows
    void trigger;
  }
}

async function runEmptyDestinationFlow(
  ctx: StorageChangeFlowContext
): Promise<FlowOutcome> {
  const { previousRoot, nextRoot, revertSetting } = ctx;
  const message =
    `RunQL storage location changed.\nExisting data: ${previousRoot.displayPath}\nNew location: ${nextRoot.displayPath}\nWhat should RunQL do with the existing files?`;
  const choice = await vscode.window.showInformationMessage(
    message,
    { modal: true },
    'Move',
    'Copy',
    'Use existing at new location',
    'Start empty at new location'
  );
  if (!choice) {
    if (revertSetting) await revertSetting();
    return 'cancelled';
  }

  if (choice === 'Use existing at new location') {
    // No-op; the resolver already points to the new location.
    return 'used-existing';
  }

  if (choice === 'Start empty at new location') {
    try {
      await vscode.workspace.fs.createDirectory(nextRoot.uri);
    } catch {
      // OK - already exists
    }
    for (const sub of ['queries', 'schemas', 'system', 'system/queries', 'system/prompts']) {
      try {
        await vscode.workspace.fs.createDirectory(
          vscode.Uri.joinPath(nextRoot.uri, sub)
        );
      } catch {
        // OK - already exists
      }
    }
    return 'started-empty';
  }

  // Move / Copy — always back up the source first (inside destination).
  await vscode.workspace.fs.createDirectory(nextRoot.uri).then(
    () => undefined,
    () => undefined
  );
  const backupUri = await backupInto(nextRoot.uri, previousRoot.uri);
  Logger.info(`Backed up ${previousRoot.displayPath} -> ${backupUri.fsPath}`);

  await copyTree(previousRoot.uri, nextRoot.uri, (name) => name === 'migration_backup');

  if (choice === 'Copy') return 'copied';

  // Move: verify copy, then delete source only if safety validation passes.
  const before = await countEntries(previousRoot.uri);
  const after = await countEntries(nextRoot.uri);
  if (after < before) {
    vscode.window.showWarningMessage(
      `RunQL migration copied ${after} entries but source has ${before}. Source files left in place.`
    );
    return 'copied';
  }
  const authoritativeAfter = tryResolveRunQLRoot();
  const authoritativeDiffers =
    !authoritativeAfter ||
    authoritativeAfter.uri.toString() !== previousRoot.uri.toString();
  if (
    authoritativeDiffers &&
    (await looksLikeRunqlRoot(previousRoot.uri)) &&
    isSafeToDeleteRoot(previousRoot.uri)
  ) {
    await deleteTree(previousRoot.uri);
    return 'moved';
  }
  if (!isSafeToDeleteRoot(previousRoot.uri)) {
    vscode.window.showWarningMessage(
      `RunQL move: source cleanup skipped (unsafe path). Files remain at ${previousRoot.displayPath}.`
    );
  }
  return 'copied';
}

async function runConflictFlow(
  ctx: StorageChangeFlowContext
): Promise<FlowOutcome> {
  const { previousRoot, nextRoot, revertSetting } = ctx;
  const message =
    `The new RunQL storage location already contains RunQL data.\nExisting source: ${previousRoot.displayPath}\nDestination (populated): ${nextRoot.displayPath}\nRunQL will not merge them automatically.`;
  const choice = await vscode.window.showInformationMessage(
    message,
    { modal: true },
    'Use existing at new location',
    'Replace existing at new location (backup is run first)'
  );
  if (!choice) {
    if (revertSetting) await revertSetting();
    return 'cancelled';
  }
  if (choice === 'Use existing at new location') {
    return 'used-existing';
  }
  // Replace destination after backup. Stash the backup in the SOURCE tree
  // so the destructive delete on the destination cannot wipe it.
  const destBackup = await backupInto(previousRoot.uri, nextRoot.uri);
  Logger.info(`Backed up destination ${nextRoot.displayPath} -> ${destBackup.fsPath}`);
  await deleteTree(nextRoot.uri);
  await vscode.workspace.fs.createDirectory(nextRoot.uri);
  await copyTree(previousRoot.uri, nextRoot.uri, (name) => name === 'migration_backup');
  return 'replaced';
}

// -----------------------------------------------------------------------------
// Ask-then-execute API (for command / webview flows that must decide
// whether to commit the setting change based on the user's choice).
// -----------------------------------------------------------------------------

export type StorageChangeAction =
  | 'move'
  | 'copy'
  | 'use-existing'
  | 'start-empty'
  | 'replace-after-backup'
  | 'cancelled'
  | 'no-source-data'
  | 'noop-same-root';

interface AskContext {
  previousRoot: RunQLStorageRoot;
  nextRoot: RunQLStorageRoot;
}

/**
 * Show the appropriate migration prompt WITHOUT touching any settings or
 * files. Returns the user's choice; callers decide whether to apply the
 * setting change (only when the returned choice is neither `cancelled`
 * nor a no-op).
 *
 * Semantics:
 *   - `noop-same-root`      → prev.uri === next.uri; nothing to do.
 *   - `no-source-data`      → source has no RunQL data; migration is
 *                             irrelevant. Caller should still apply the
 *                             setting change (it's a fresh switch).
 *   - `cancelled`           → user closed the dialog; caller MUST NOT
 *                             apply the setting change.
 *   - anything else         → user picked an action; caller should apply
 *                             the setting change and then invoke
 *                             `executeStorageChangeAction` with this choice.
 */
export async function askStorageChangeAction(
  ctx: AskContext
): Promise<StorageChangeAction> {
  if (ctx.previousRoot.uri.toString() === ctx.nextRoot.uri.toString()) {
    return 'noop-same-root';
  }
  const sourceHasData = await hasRunqlData(ctx.previousRoot.uri);
  if (!sourceHasData) return 'no-source-data';

  const destExists = await fileExists(ctx.nextRoot.uri);
  const destHasData = destExists ? await hasRunqlData(ctx.nextRoot.uri) : false;

  if (destHasData) return askConflictAction(ctx);
  return askEmptyDestinationAction(ctx);
}

async function askEmptyDestinationAction({
  previousRoot,
  nextRoot,
}: AskContext): Promise<StorageChangeAction> {
  const message =
    `Change RunQL storage location?\nCurrent: ${previousRoot.displayPath}\nNew: ${nextRoot.displayPath}\nWhat should RunQL do with the existing files?`;
  const choice = await vscode.window.showInformationMessage(
    message,
    { modal: true },
    'Move',
    'Copy',
    'Use existing at new location',
    'Start empty at new location'
  );
  if (!choice) return 'cancelled';
  if (choice === 'Move') return 'move';
  if (choice === 'Copy') return 'copy';
  if (choice === 'Use existing at new location') return 'use-existing';
  return 'start-empty';
}

async function askConflictAction({
  previousRoot,
  nextRoot,
}: AskContext): Promise<StorageChangeAction> {
  const message =
    `Change RunQL storage location?\nBoth locations contain RunQL data.\nCurrent: ${previousRoot.displayPath}\nNew (already populated): ${nextRoot.displayPath}\nRunQL will not merge them automatically.`;
  const choice = await vscode.window.showInformationMessage(
    message,
    { modal: true },
    'Use existing at new location',
    'Replace existing at new location (backup is run first)'
  );
  if (!choice) return 'cancelled';
  if (choice === 'Use existing at new location') return 'use-existing';
  return 'replace-after-backup';
}

/**
 * Post-migration housekeeping. Call this AFTER both:
 *   1. `executeStorageChangeAction` has copied the files, AND
 *   2. `runql.storage.*` settings have been updated to point at the new root.
 *
 * At that point `tryResolveRunQLRoot()` reflects the new authoritative
 * state and the file-system operations below make sense: prune old
 * backups under the new root, clean up now-stale `.runql-link/` files
 * if we landed in workspace mode, and refresh the AGENTS.md bounded
 * section against the new mode.
 */
export async function postMigrationHousekeeping(): Promise<void> {
  try {
    const authoritative = tryResolveRunQLRoot();
    if (authoritative) await pruneMigrationBackups(authoritative);
  } catch (e) {
    Logger.warn('Backup pruning failed in post-migration housekeeping', e);
  }
  try {
    const authoritative = tryResolveRunQLRoot();
    if (authoritative?.location === 'workspace') {
      const { cleanupWorkspaceLinksOnWorkspaceMode } = await import('./workspaceLinkCleanup');
      await cleanupWorkspaceLinksOnWorkspaceMode();
    }
  } catch (e) {
    Logger.warn('Workspace-link cleanup failed in post-migration housekeeping', e);
  }
  try {
    // Restrict AGENTS.md refresh to workspace folders that are
    // actually linked to RunQL. `ensureAgentsMd()` with no folder
    // argument iterates every open workspace folder — in a multi-root
    // workspace that would create/edit AGENTS.md in unrelated
    // projects.
    const { findLinkedFolders } = await import('./refreshGeneratedDocs');
    const linked = await findLinkedFolders();
    if (linked.length > 0) {
      await ensureAgentsMd(linked);
    }
  } catch (e) {
    Logger.warn('AGENTS.md refresh failed in post-migration housekeeping', e);
  }
}

/**
 * Execute a choice returned by `askStorageChangeAction`. Copies / moves
 * / deletes files as chosen. Does NOT touch settings and does NOT run
 * post-migration housekeeping — the caller is responsible for both,
 * in the correct order:
 *   1. `await executeStorageChangeAction(ctx, choice)`  ← files at new root
 *   2. `await cfg.update('runql.storage.*', …)`         ← subscribers fire against a consistent state
 *   3. `await postMigrationHousekeeping()`              ← cleanup uses the new resolver state
 *
 * Cross-window prompt dedup uses the same lock as `runStorageChangeFlow`.
 */
export async function executeStorageChangeAction(
  ctx: AskContext,
  action: StorageChangeAction
): Promise<FlowOutcome> {
  const { previousRoot, nextRoot } = ctx;
  if (
    action === 'cancelled' ||
    action === 'noop-same-root'
  ) {
    return action === 'cancelled' ? 'cancelled' : 'noop-same-root';
  }
  if (action === 'no-source-data') return 'no-source-data';

  const destExists = await fileExists(nextRoot.uri);
  const lockHost = destExists ? nextRoot : previousRoot;
  const lockAcquired = await acquireStorageChangeLock(
    lockHost,
    previousRoot.displayPath,
    nextRoot.displayPath
  );
  if (lockAcquired === undefined) {
    Logger.info('Storage-change action already active in another window; skipping.');
    return 'concurrent-in-progress';
  }

  try {
    if (action === 'use-existing') return 'used-existing';

    if (action === 'start-empty') {
      try { await vscode.workspace.fs.createDirectory(nextRoot.uri); } catch { /* exists */ }
      for (const sub of ['queries', 'schemas', 'system', 'system/queries', 'system/prompts']) {
        try {
          await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(nextRoot.uri, sub));
        } catch { /* exists */ }
      }
      return 'started-empty';
    }

    if (action === 'replace-after-backup') {
      const destBackup = await backupInto(previousRoot.uri, nextRoot.uri);
      Logger.info(`Backed up destination ${nextRoot.displayPath} -> ${destBackup.fsPath}`);
      // Count source content BEFORE the destructive delete/copy so we
      // have a solid reference for the verification step. Ignore
      // `migration_backup` because we won't copy that across (copyTree
      // uses the same skip filter below).
      const sourceCount = await countEntries(previousRoot.uri, (name) => name === 'migration_backup');
      await deleteTree(nextRoot.uri);
      await vscode.workspace.fs.createDirectory(nextRoot.uri);
      await copyTree(previousRoot.uri, nextRoot.uri, (name) => name === 'migration_backup');
      // Verify the copy landed everything. copyTree logs per-file errors
      // and returns successfully, so an incomplete copy is otherwise
      // silent. The destination has been destructively wiped at this
      // point — surface the failure so the user knows to restore from
      // the backup at ${destBackup.fsPath}.
      const destCount = await countEntries(nextRoot.uri);
      if (destCount < sourceCount) {
        vscode.window.showWarningMessage(
          `RunQL replace: destination copy is incomplete (${destCount}/${sourceCount} entries). The pre-replace backup is at ${destBackup.fsPath} — restore from there if needed.`
        );
      }
      return 'replaced';
    }

    // Move / Copy — always back up the source first.
    await vscode.workspace.fs.createDirectory(nextRoot.uri).then(
      () => undefined,
      () => undefined
    );
    const backupUri = await backupInto(nextRoot.uri, previousRoot.uri);
    Logger.info(`Backed up ${previousRoot.displayPath} -> ${backupUri.fsPath}`);
    await copyTree(previousRoot.uri, nextRoot.uri, (name) => name === 'migration_backup');

    if (action === 'copy') return 'copied';

    // action === 'move'
    //
    // Verify the copy landed everything (destination has at least as many
    // entries as source — the destination usually has strictly more because
    // it holds our migration_backup subdir) before we destroy the source.
    const before = await countEntries(previousRoot.uri);
    const after = await countEntries(nextRoot.uri);
    if (after < before) {
      vscode.window.showWarningMessage(
        `RunQL migration copied ${after} entries but source has ${before}. Source files left in place.`
      );
      return 'copied';
    }
    // Delete the source root. Safety guards:
    //   - looksLikeRunqlRoot: only delete things that look like a RunQL
    //     data tree (queries/, schemas/, or system/ present).
    //   - isSafeToDeleteRoot: never touch home, /workspaces, a workspace
    //     folder root, or the filesystem root.
    if (
      (await looksLikeRunqlRoot(previousRoot.uri)) &&
      isSafeToDeleteRoot(previousRoot.uri)
    ) {
      await deleteTree(previousRoot.uri);
      return 'moved';
    }
    if (!isSafeToDeleteRoot(previousRoot.uri)) {
      vscode.window.showWarningMessage(
        `RunQL move: source cleanup skipped (unsafe path). Files remain at ${previousRoot.displayPath}.`
      );
    }
    return 'copied';
  } finally {
    // Only release the lock here. Post-migration housekeeping (retention
    // pruning, .runql-link/ cleanup, AGENTS.md refresh) is deliberately
    // NOT run here: callers using the ask-then-commit flow have not
    // updated the settings yet, so `tryResolveRunQLRoot()` would return
    // the OLD root and the cleanup would apply to the wrong mode.
    // Callers must invoke `postMigrationHousekeeping()` AFTER the
    // setting change lands.
    await releaseStorageChangeLock(lockAcquired);
  }
}

// -----------------------------------------------------------------------------
// Setting-revert helper
// -----------------------------------------------------------------------------

/**
 * Build a revert callback that restores the previous storage location and
 * associated path when the user cancels a migration flow.
 */
export function buildRevertCallback(previous: {
  location: StorageLocation;
  userPath: string;
  codespacesPath: string;
  customPath: string;
}): () => Promise<void> {
  return async () => {
    const cfg = vscode.workspace.getConfiguration('runql.storage');
    await cfg.update('location', previous.location, vscode.ConfigurationTarget.Global);
    await cfg.update('userPath', previous.userPath, vscode.ConfigurationTarget.Global);
    await cfg.update('codespacesPath', previous.codespacesPath, vscode.ConfigurationTarget.Global);
    await cfg.update('customPath', previous.customPath, vscode.ConfigurationTarget.Global);
  };
}

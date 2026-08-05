import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export type StorageLocation = 'workspace' | 'user' | 'custom';

export interface RunQLStorageRoot {
  location: StorageLocation;
  uri: vscode.Uri;
  displayPath: string;
  isCodespaces: boolean;
  isWorkspaceScoped: boolean;
}

export type StorageErrorCode =
  | 'no-workspace'
  | 'invalid-custom-path'
  | 'unsafe-custom-path'
  | 'multi-root-owner-missing';

export class RunQLStorageError extends Error {
  code: StorageErrorCode;
  location: StorageLocation;
  constructor(code: StorageErrorCode, location: StorageLocation, message: string) {
    super(message);
    this.code = code;
    this.location = location;
  }
}

export function isCodespaces(): boolean {
  return process.env.CODESPACES === 'true';
}

export function expandTilde(p: string): string {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

interface StorageSettings {
  location: StorageLocation;
  userPath: string;
  codespacesPath: string;
  customPath: string;
  workspaceFolder: string;
}

function readSettings(): StorageSettings {
  const cfg = vscode.workspace.getConfiguration?.('runql.storage');
  const pick = <T>(key: string, fallback: T): T => {
    if (!cfg || typeof cfg.get !== 'function') return fallback;
    const value = cfg.get<T>(key, fallback);
    return value === undefined || value === null ? fallback : value;
  };
  return {
    location: pick<StorageLocation>('location', 'workspace'),
    userPath: pick<string>('userPath', '~/.runql'),
    codespacesPath: pick<string>('codespacesPath', '/workspaces/.runql'),
    customPath: pick<string>('customPath', ''),
    workspaceFolder: pick<string>('workspaceFolder', ''),
  };
}

function isFilesystemRoot(fsPath: string): boolean {
  const parsed = path.parse(fsPath);
  return parsed.root === fsPath;
}

function isWindowsDriveRoot(fsPath: string): boolean {
  return /^[A-Za-z]:[\\/]?$/.test(fsPath);
}

/**
 * Shared validator for user/custom storage paths. Applies the same set
 * of safety rules to both `runql.storage.userPath` and
 * `runql.storage.customPath`:
 *   - non-empty
 *   - not a Windows drive root (`C:\`, `D:\`, …)
 *   - absolute after `~` expansion
 *   - not the filesystem root
 *   - not the user's home directory
 *   - not `/workspaces` inside Codespaces
 *   - not a VS Code workspace folder root
 *
 * Symlinks are resolved so a link that points to any of the above is
 * still rejected.
 */
function validateStoragePath(
  rawPath: string,
  location: 'user' | 'custom'
): { fsPath?: string; error?: RunQLStorageError } {
  const label = location === 'user' ? 'User-level' : 'Custom';
  const invalidCode = location === 'user' ? 'invalid-custom-path' : 'invalid-custom-path';
  const unsafeCode = location === 'user' ? 'unsafe-custom-path' : 'unsafe-custom-path';
  if (!rawPath || !rawPath.trim()) {
    return {
      error: new RunQLStorageError(
        invalidCode,
        location,
        `${label} RunQL storage path is empty. Choose a folder or switch storage location.`
      ),
    };
  }
  const expanded = expandTilde(rawPath.trim());
  if (isWindowsDriveRoot(expanded)) {
    return {
      error: new RunQLStorageError(
        unsafeCode,
        location,
        `${label} RunQL storage path cannot be a Windows drive root.`
      ),
    };
  }
  if (!path.isAbsolute(expanded)) {
    return {
      error: new RunQLStorageError(
        invalidCode,
        location,
        `${label} RunQL storage path must be an absolute path.`
      ),
    };
  }
  let normalized = path.normalize(expanded);
  try {
    normalized = path.normalize(fs.realpathSync.native(normalized));
  } catch {
    // Non-existent path is fine — the safety checks below apply to the
    // literal form.
  }
  if (isFilesystemRoot(normalized)) {
    return {
      error: new RunQLStorageError(
        unsafeCode,
        location,
        `${label} RunQL storage path cannot be the filesystem root.`
      ),
    };
  }
  if (normalized === path.normalize(os.homedir())) {
    return {
      error: new RunQLStorageError(
        unsafeCode,
        location,
        `${label} RunQL storage path cannot be the user's home directory itself.`
      ),
    };
  }
  if (isCodespaces() && normalized === path.normalize('/workspaces')) {
    return {
      error: new RunQLStorageError(
        unsafeCode,
        location,
        `${label} RunQL storage path cannot be /workspaces itself in Codespaces.`
      ),
    };
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const f of folders) {
    if (f.uri.scheme === 'file' && normalized === path.normalize(f.uri.fsPath)) {
      return {
        error: new RunQLStorageError(
          unsafeCode,
          location,
          `${label} RunQL storage path cannot be a VS Code workspace folder root itself.`
        ),
      };
    }
  }
  return { fsPath: normalized };
}

export function validateCustomPath(rawPath: string): { fsPath?: string; error?: RunQLStorageError } {
  return validateStoragePath(rawPath, 'custom');
}

export function validateUserPath(rawPath: string): { fsPath?: string; error?: RunQLStorageError } {
  return validateStoragePath(rawPath, 'user');
}

/**
 * Verify the given path can be created and written to. Attempts to
 * create the directory (idempotent) and to write + delete a small probe
 * file. Returns undefined on success, or an error describing the
 * failure. Meant to run *after* validateCustomPath's safety checks.
 */
export async function checkCustomPathWritable(fsPath: string): Promise<RunQLStorageError | undefined> {
  const uri = vscode.Uri.file(fsPath);
  try {
    await vscode.workspace.fs.createDirectory(uri);
  } catch (e) {
    return new RunQLStorageError(
      'invalid-custom-path',
      'custom',
      `Custom RunQL storage path is not creatable: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  const probe = vscode.Uri.joinPath(uri, `.runql-write-test-${Date.now()}`);
  try {
    await vscode.workspace.fs.writeFile(probe, new Uint8Array([0]));
    await vscode.workspace.fs.delete(probe);
  } catch (e) {
    return new RunQLStorageError(
      'invalid-custom-path',
      'custom',
      `Custom RunQL storage path is not writable: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  return undefined;
}

/**
 * Compute what the resolved RunQL root WOULD be for a hypothetical
 * location + settings combination, WITHOUT touching any VS Code
 * settings. Used by the ask-then-commit command flow so we can preview
 * the destination in the migration dialog before applying any change.
 *
 * Returns undefined when the prospective settings can't resolve — e.g.
 * workspace mode with no folder open, or custom mode with an invalid
 * path.
 */
export function computeProspectiveRoot(
  location: StorageLocation,
  overrides: { userPath?: string; codespacesPath?: string; customPath?: string }
): RunQLStorageRoot | undefined {
  const codespaces = isCodespaces();
  if (location === 'workspace') {
    const owner = pickWorkspaceOwnerFolder();
    if (!owner) return undefined;
    const uri = vscode.Uri.joinPath(owner.uri, 'RunQL');
    return {
      location: 'workspace',
      uri,
      displayPath: uri.fsPath,
      isCodespaces: codespaces,
      isWorkspaceScoped: true,
    };
  }
  if (location === 'user') {
    const raw = codespaces
      ? (overrides.codespacesPath ?? '/workspaces/.runql')
      : (overrides.userPath ?? '~/.runql');
    const fallback = codespaces ? '/workspaces/.runql' : '~/.runql';
    const fsPath = path.resolve(expandTilde(raw && raw.trim() ? raw : fallback));
    return {
      location: 'user',
      uri: vscode.Uri.file(fsPath),
      displayPath: fsPath,
      isCodespaces: codespaces,
      isWorkspaceScoped: false,
    };
  }
  // custom
  const raw = overrides.customPath ?? '';
  const { fsPath, error } = validateCustomPath(raw);
  if (error || !fsPath) return undefined;
  return {
    location: 'custom',
    uri: vscode.Uri.file(fsPath),
    displayPath: fsPath,
    isCodespaces: codespaces,
    isWorkspaceScoped: false,
  };
}

/**
 * Pick the workspace folder that owns the workspace-mode RunQL root.
 * Single-folder workspaces return that folder. Multi-root workspaces use
 * the persisted `runql.storage.workspaceFolder` URI; return undefined if
 * the setting is unset or points to a folder that is no longer in the
 * workspace so callers can prompt.
 */
export function pickWorkspaceOwnerFolder(): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  if (folders.length === 1) return folders[0];
  const persisted = readSettings().workspaceFolder;
  if (!persisted) return undefined;
  return folders.find((f) => f.uri.toString() === persisted);
}

/**
 * Resolve the authoritative RunQL storage root.
 * Throws RunQLStorageError when the current settings are not resolvable
 * (missing workspace folder, invalid custom path, multi-root without owner).
 */
export function resolveRunQLRoot(): RunQLStorageRoot {
  const s = readSettings();
  const codespaces = isCodespaces();

  if (s.location === 'workspace') {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      throw new RunQLStorageError(
        'no-workspace',
        'workspace',
        'Workspace storage requires an open folder. Open a folder or switch RunQL storage to User-level.'
      );
    }
    const owner = pickWorkspaceOwnerFolder();
    if (!owner) {
      throw new RunQLStorageError(
        'multi-root-owner-missing',
        'workspace',
        'Multi-root workspace: choose which workspace folder should own the RunQL storage root.'
      );
    }
    const uri = vscode.Uri.joinPath(owner.uri, 'RunQL');
    return {
      location: 'workspace',
      uri,
      displayPath: uri.fsPath,
      isCodespaces: codespaces,
      isWorkspaceScoped: true,
    };
  }

  if (s.location === 'user') {
    const raw = codespaces ? s.codespacesPath : s.userPath;
    const fallback = codespaces ? '/workspaces/.runql' : '~/.runql';
    // Validate against the same safety rules as custom mode so an
    // unsafe/synced setting (e.g. userPath === '.' resolving against
    // launch cwd, or a workspace-folder root, or `~` itself) can't
    // silently point RunQL at somewhere dangerous.
    const rawResolved = raw && raw.trim() ? raw : fallback;
    const validation = validateUserPath(rawResolved);
    if (validation.error || !validation.fsPath) {
      throw validation.error ?? new RunQLStorageError('invalid-custom-path', 'user', 'Invalid user-mode storage path.');
    }
    return {
      location: 'user',
      uri: vscode.Uri.file(validation.fsPath),
      displayPath: validation.fsPath,
      isCodespaces: codespaces,
      isWorkspaceScoped: false,
    };
  }

  // custom
  const { fsPath, error } = validateCustomPath(s.customPath);
  if (error || !fsPath) {
    throw error ?? new RunQLStorageError('invalid-custom-path', 'custom', 'Invalid custom path.');
  }
  return {
    location: 'custom',
    uri: vscode.Uri.file(fsPath),
    displayPath: fsPath,
    isCodespaces: codespaces,
    isWorkspaceScoped: false,
  };
}

/** Non-throwing variant for read-only checks. */
export function tryResolveRunQLRoot(): RunQLStorageRoot | undefined {
  try {
    return resolveRunQLRoot();
  } catch {
    return undefined;
  }
}

export interface StorageRootChangeEvent {
  previous: RunQLStorageRoot | undefined;
  next: RunQLStorageRoot | undefined;
}

const _onDidChangeStorageRoot = new vscode.EventEmitter<StorageRootChangeEvent>();
export const onDidChangeStorageRoot = _onDidChangeStorageRoot.event;

let _lastResolved: RunQLStorageRoot | undefined;

/**
 * Subscribe to storage-root changes triggered by settings edits (from the
 * Welcome page, commands, or direct edits to settings.json in this or
 * another window) and by workspace-folder changes.
 */
export function registerStorageRootChangeListener(): vscode.Disposable {
  _lastResolved = tryResolveRunQLRoot();
  const subs: vscode.Disposable[] = [];

  subs.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        !e.affectsConfiguration('runql.storage.location') &&
        !e.affectsConfiguration('runql.storage.userPath') &&
        !e.affectsConfiguration('runql.storage.codespacesPath') &&
        !e.affectsConfiguration('runql.storage.customPath') &&
        !e.affectsConfiguration('runql.storage.workspaceFolder')
      ) {
        return;
      }
      const previous = _lastResolved;
      const next = tryResolveRunQLRoot();
      // Suppress no-op events (touching customPath while in user mode,
      // rewriting a setting to the same value, etc.). Without this
      // guard the queryIndex handler triggers a full storage-root scan
      // + persist for every unrelated storage-key touch.
      const prevKey = previous?.uri.toString() ?? '';
      const nextKey = next?.uri.toString() ?? '';
      const prevLocation = previous?.location ?? '';
      const nextLocation = next?.location ?? '';
      if (prevKey === nextKey && prevLocation === nextLocation) return;
      _lastResolved = next;
      _onDidChangeStorageRoot.fire({ previous, next });
    })
  );

  subs.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const previous = _lastResolved;
      const next = tryResolveRunQLRoot();
      const prevKey = previous?.uri.toString() ?? '';
      const nextKey = next?.uri.toString() ?? '';
      if (prevKey !== nextKey) {
        _lastResolved = next;
        _onDidChangeStorageRoot.fire({ previous, next });
      }
    })
  );

  return { dispose: () => subs.forEach((s) => s.dispose()) };
}

/** Persist the multi-root workspace-mode owner folder as its URI string. */
export async function setWorkspaceOwnerFolder(
  folder: vscode.WorkspaceFolder | undefined
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('runql.storage');
  await cfg.update(
    'workspaceFolder',
    folder?.uri.toString() ?? '',
    vscode.ConfigurationTarget.Workspace
  );
}

// ----------------------------------------------------------------------------
// Path helpers used by consumers that need to serialize/resolve URIs relative
// to the active RunQL storage root.
//
// v1 storage-root-relative paths look like:
//     queries/<connection>/<query>.sql
//     schemas/<connection>/<schema>/schema.json
//     system/queries/queryIndex.json
//
// Legacy workspace-relative paths (from before this feature) look like:
//     RunQL/queries/<connection>/<query>.sql
//     RunQL/schemas/<connection>/<schema>/schema.json
//
// resolveStoredPath accepts both forms so existing queryIndex.json /
// queryHistory.json / etc. keep working after a storage-root switch.
// makeStoredPath prefers the root-relative form for new writes.
// ----------------------------------------------------------------------------

const KNOWN_ROOT_PREFIXES = ['queries', 'schemas', 'system'];

function stripLeading(p: string): string {
  if (!p) return p;
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * Reject any `..` segment in a serialized path. `vscode.Uri.joinPath`
 * normalizes `..`, so without this check a stored path like
 * `queries/../../../etc/passwd` would escape the RunQL storage root
 * and let a maliciously-crafted `queryIndex.json` entry trick
 * `savedQueriesView` / `deleteSavedQuery` into opening or unlinking
 * arbitrary files.
 */
function containsParentTraversal(p: string): boolean {
  if (!p) return false;
  const parts = p.split('/');
  for (const seg of parts) {
    if (seg === '..') return true;
  }
  return false;
}

/**
 * Resolve a serialized RunQL path back into a full URI.
 *
 * Handles three cases (in order):
 *   1. Legacy `RunQL/queries|schemas|system/...` — strip `RunQL/` and join
 *      onto the current storage root.
 *   2. Root-relative `queries|schemas|system/...` — join onto the storage root.
 *   3. Anything else — treat as workspace-relative and join onto the first
 *      workspace folder (for general SQL files outside RunQL).
 */
export function resolveStoredPath(
  stored: string,
  root?: RunQLStorageRoot
): vscode.Uri | undefined {
  const cleaned = stripLeading(stored);
  if (!cleaned) return undefined;
  // Refuse to resolve paths that try to escape their base via `..`.
  // vscode.Uri.joinPath normalizes such segments, so without this
  // guard a stored entry like `queries/../../../../etc/passwd` would
  // silently resolve outside the storage root.
  if (containsParentTraversal(cleaned)) {
    return undefined;
  }
  const resolvedRoot = root ?? tryResolveRunQLRoot();
  const legacy = /^RunQL\/(queries|schemas|system)(\/|$)/.exec(cleaned);
  if (legacy && resolvedRoot) {
    return vscode.Uri.joinPath(resolvedRoot.uri, cleaned.substring('RunQL/'.length));
  }
  const rootPrefix = KNOWN_ROOT_PREFIXES.find((p) =>
    cleaned === p || cleaned.startsWith(`${p}/`)
  );
  if (rootPrefix && resolvedRoot) {
    return vscode.Uri.joinPath(resolvedRoot.uri, cleaned);
  }
  // Workspace-relative fallback for general SQL files outside the RunQL
  // tree. In a multi-root workspace the file could belong to any of the
  // open folders — historical behaviour was to always assume folder[0],
  // which silently opened / deleted the wrong file when the entry lived
  // in folder[1..N]. Return the first folder+path pair whose URI is a
  // syntactic match; callers can also pass this into `pickResolvedFolder`
  // below when they need on-disk existence checks.
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return undefined;
  return vscode.Uri.joinPath(folders[0].uri, cleaned);
}

/**
 * When resolving a stored workspace-relative path in a multi-root
 * workspace, the syntactic joinPath fallback in `resolveStoredPath`
 * picks folder[0] blindly. This helper tries every workspace folder
 * and returns the URI whose target file exists; falls back to folder[0]
 * when nothing exists yet. Callers that will read/write the target
 * (open, delete, rename) should prefer this over the raw
 * `resolveStoredPath` result.
 */
export async function resolveStoredPathToExistingFile(
  stored: string,
  root?: RunQLStorageRoot
): Promise<vscode.Uri | undefined> {
  const cleaned = stripLeading(stored);
  if (!cleaned || containsParentTraversal(cleaned)) return undefined;
  // Root-relative and legacy `RunQL/…` paths still route through the
  // synchronous resolver — the storage root is a single URI, not
  // ambiguous across folders.
  if (
    /^RunQL\/(queries|schemas|system)(\/|$)/.test(cleaned) ||
    KNOWN_ROOT_PREFIXES.some((p) => cleaned === p || cleaned.startsWith(`${p}/`))
  ) {
    return resolveStoredPath(stored, root);
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return undefined;
  // Probe every folder; return the first hit.
  for (const f of folders) {
    const candidate = vscode.Uri.joinPath(f.uri, cleaned);
    try {
      await vscode.workspace.fs.stat(candidate);
      return candidate;
    } catch {
      // Not this folder — try next.
    }
  }
  // Nothing exists yet — return folder[0]-based candidate so callers
  // creating a new file land somewhere deterministic.
  return vscode.Uri.joinPath(folders[0].uri, cleaned);
}

/**
 * Serialize a URI to a storage-root-relative path when it lives under the
 * resolved RunQL storage root; otherwise fall back to a workspace-relative
 * path (for general SQL files opened outside RunQL/). Always returns a
 * forward-slash string.
 */
export function makeStoredPath(uri: vscode.Uri, root?: RunQLStorageRoot): string {
  const resolvedRoot = root ?? tryResolveRunQLRoot();
  if (resolvedRoot && uri.scheme === resolvedRoot.uri.scheme) {
    const rp = resolvedRoot.uri.path.replace(/\/$/, '');
    if (uri.path === rp) return '';
    if (uri.path.startsWith(rp + '/')) {
      return uri.path.slice(rp.length + 1).replace(/\\/g, '/');
    }
  }
  if (typeof vscode.workspace.asRelativePath === 'function') {
    return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
  }
  return uri.path.replace(/\\/g, '/');
}

/** True when the given URI is under the resolved RunQL storage root. */
export function isPathUnderRunqlRoot(uri: vscode.Uri, root?: RunQLStorageRoot): boolean {
  const resolved = root ?? tryResolveRunQLRoot();
  if (!resolved) return false;
  if (uri.scheme !== resolved.uri.scheme) return false;
  const rp = resolved.uri.path.replace(/\/$/, '');
  return uri.path === rp || uri.path.startsWith(rp + '/');
}

/** Strip legacy `RunQL/` prefix so callers can compare paths uniformly. */
export function normalizeStoredPath(stored: string): string {
  const cleaned = stripLeading(stored);
  const legacy = /^RunQL\/(queries|schemas|system)(\/|$)/.exec(cleaned);
  return legacy ? cleaned.substring('RunQL/'.length) : cleaned;
}

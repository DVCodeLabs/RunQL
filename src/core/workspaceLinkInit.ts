import * as vscode from 'vscode';
import {
  ensureAgentsMd,
  ensureReadmeMd,
  ensureRunqlGitignoreEntries,
  ensureRunqlLinkDir,
  fileExists,
  probeLinkMarkerVersions,
  readJson,
  writeJson,
  writeRunqlRef,
  writeStorageRootMarker,
  clearStorageLinkSkipMarker,
  RUNQL_LINK_DIR,
  RUNQL_LINK_STORAGE_ROOT,
  RUNQL_LINK_SKIP,
} from './fsWorkspace';
import {
  RunQLStorageRoot,
  pickWorkspaceOwnerFolder,
  setWorkspaceOwnerFolder,
  tryResolveRunQLRoot,
} from './storageRoot';
import { Logger } from './logger';

interface StorageLinkSkipMarker {
  version: '0.1';
  storageLocation: 'user' | 'custom' | 'workspace';
  runqlRoot: string;
  reason: string;
  createdAt: string;
}

const SKIP_MARKER_PATH = [RUNQL_LINK_DIR, RUNQL_LINK_SKIP];
const ROOT_MARKER_PATH = [RUNQL_LINK_DIR, RUNQL_LINK_STORAGE_ROOT];

function skipMarkerUri(folder: vscode.WorkspaceFolder): vscode.Uri {
  return vscode.Uri.joinPath(folder.uri, ...SKIP_MARKER_PATH);
}

function rootMarkerUri(folder: vscode.WorkspaceFolder): vscode.Uri {
  return vscode.Uri.joinPath(folder.uri, ...ROOT_MARKER_PATH);
}

interface RootMarker {
  version: string;
  storageLocation: 'user' | 'custom' | 'workspace';
  runqlRoot: string;
  createdAt: string;
  updatedAt: string;
}

export type LinkStatus =
  | { kind: 'linked-current'; folder: vscode.WorkspaceFolder }
  | { kind: 'linked-other'; folder: vscode.WorkspaceFolder; otherRoot: string }
  | { kind: 'skipped'; folder: vscode.WorkspaceFolder }
  | { kind: 'unlinked'; folder: vscode.WorkspaceFolder };

async function inspectFolder(
  folder: vscode.WorkspaceFolder,
  root: RunQLStorageRoot
): Promise<LinkStatus> {
  const marker = rootMarkerUri(folder);
  if (await fileExists(marker)) {
    try {
      const parsed = await readJson<RootMarker>(marker);
      if (parsed?.runqlRoot === root.displayPath) {
        return { kind: 'linked-current', folder };
      }
      return {
        kind: 'linked-other',
        folder,
        otherRoot: parsed?.runqlRoot ?? '(unknown)',
      };
    } catch {
      // Unreadable marker -> treat as unlinked
    }
  }
  if (await fileExists(skipMarkerUri(folder))) {
    // Skip marker resets when root changes; check it matches current.
    try {
      const skip = await readJson<StorageLinkSkipMarker>(skipMarkerUri(folder));
      if (skip?.runqlRoot === root.displayPath) {
        return { kind: 'skipped', folder };
      }
    } catch {
      // Fall through - treat as unlinked
    }
  }
  return { kind: 'unlinked', folder };
}

async function writeSkipMarker(
  folder: vscode.WorkspaceFolder,
  root: RunQLStorageRoot
): Promise<void> {
  const uri = skipMarkerUri(folder);
  await ensureRunqlLinkDir(folder);
  const marker: StorageLinkSkipMarker = {
    version: '0.1',
    storageLocation: root.location,
    runqlRoot: root.displayPath,
    reason: 'user_skipped',
    createdAt: new Date().toISOString(),
  };
  await writeJson(uri, marker);
}

/**
 * Write all workspace-link files for a single folder: storage-root marker,
 * .runql-ref.json mirror, AGENTS.md RunQL section, README_RUNQL.md, and
 * .gitignore entries. Also removes a stale storage-link-skip marker if
 * present.
 */
export async function initializeFolderLink(
  folder: vscode.WorkspaceFolder,
  root: RunQLStorageRoot
): Promise<void> {
  await ensureRunqlLinkDir(folder);
  // Check BOTH marker files' versions atomically before writing either.
  // Without this, storage-root.json could be v0.2 (skipped as "newer")
  // while ref.json is written fresh at v0.1 — the two files would then
  // disagree and the disagreement rule (trust storage-root.json)
  // would immediately overwrite ref.json again.
  const probe = await probeLinkMarkerVersions(folder);
  if (!probe.ok) {
    Logger.warn(
      `Skipping workspace-link init for ${folder.uri.fsPath}: ${probe.reason}. Delete the file or upgrade RunQL to write the newer schema.`
    );
    return;
  }
  await writeStorageRootMarker(folder, root);
  await writeRunqlRef(folder, root);
  await ensureAgentsMd([folder]);
  await ensureReadmeMd([folder]);
  await ensureRunqlGitignoreEntries(folder);
  await clearStorageLinkSkipMarker(folder);
}

/**
 * Ask the user which workspace folders should be linked to the given
 * user/custom storage root. Session-only Skip choices are not persisted;
 * "Do Not Ask Again" writes a storage-link-skip.json marker.
 *
 * Returns the folders that were initialized (may be empty).
 */
export async function promptWorkspaceLinkInit(
  root: RunQLStorageRoot
): Promise<vscode.WorkspaceFolder[]> {
  if (root.location === 'workspace') return [];
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return [];

  const statuses = await Promise.all(folders.map((f) => inspectFolder(f, root)));
  const unlinked = statuses.filter((s) => s.kind === 'unlinked');
  const linkedOther = statuses.filter((s) => s.kind === 'linked-other');

  const initialized: vscode.WorkspaceFolder[] = [];

  // 1. Handle folders already linked to a different root.
  for (const s of linkedOther) {
    if (s.kind !== 'linked-other') continue;
    const pick = await vscode.window.showInformationMessage(
      `Workspace folder "${s.folder.name}" is linked to a different RunQL storage root (${s.otherRoot}). Update it to use ${root.displayPath}?`,
      { modal: false },
      'Update',
      'Leave unchanged',
      'Open Settings'
    );
    if (pick === 'Update') {
      await initializeFolderLink(s.folder, root);
      initialized.push(s.folder);
    } else if (pick === 'Open Settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'runql.storage');
    }
  }

  if (unlinked.length === 0) return initialized;

  // 2. Prompt per-unlinked folder, offering All/Skip All when multiple.
  const supportsBatch = unlinked.length > 1;
  let applyAll: 'init' | 'skip' | undefined;

  for (const s of unlinked) {
    if (s.kind !== 'unlinked') continue;
    let choice: string | undefined;
    if (applyAll === 'init') {
      choice = 'Initialize';
    } else if (applyAll === 'skip') {
      choice = 'Skip';
    } else {
      const actions: string[] = ['Initialize', 'Skip'];
      if (supportsBatch) {
        actions.push('Initialize All', 'Skip All');
      }
      actions.push('Do Not Ask Again');
      choice = await vscode.window.showInformationMessage(
        `Initialize RunQL in "${s.folder.name}" to use storage at ${root.displayPath}?`,
        { modal: false },
        ...actions
      );
    }

    if (choice === 'Initialize All') {
      applyAll = 'init';
      choice = 'Initialize';
    } else if (choice === 'Skip All') {
      applyAll = 'skip';
      choice = 'Skip';
    }

    try {
      if (choice === 'Initialize') {
        await initializeFolderLink(s.folder, root);
        initialized.push(s.folder);
      } else if (choice === 'Do Not Ask Again') {
        await writeSkipMarker(s.folder, root);
      }
      // Skip / undefined => session-only, do nothing.
    } catch (e) {
      Logger.warn(`Failed to initialize workspace link for ${s.folder.name}`, e);
    }
  }

  return initialized;
}

/**
 * Multi-root workspace-mode owner selection. If a persisted owner exists
 * and is still in the workspace, returns it. Otherwise prompts the user
 * to pick a folder and persists the choice as its URI string.
 */
export async function promptWorkspaceOwnerFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  if (folders.length === 1) return folders[0];

  const existing = pickWorkspaceOwnerFolder();
  if (existing) return existing;

  const items: (vscode.QuickPickItem & { folder: vscode.WorkspaceFolder })[] = folders.map((f) => ({
    label: f.name,
    description: f.uri.fsPath,
    folder: f,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Choose which workspace folder should own the local RunQL data root',
    title: 'RunQL: Multi-root workspace',
    ignoreFocusOut: true,
  });
  if (!picked) return undefined;
  await setWorkspaceOwnerFolder(picked.folder);
  return picked.folder;
}

/** Convenience: current resolver root, prompting for owner if needed. */
export async function ensureResolvableRoot(): Promise<RunQLStorageRoot | undefined> {
  const root = tryResolveRunQLRoot();
  if (root) return root;
  const owner = await promptWorkspaceOwnerFolder();
  if (!owner) return undefined;
  return tryResolveRunQLRoot();
}

/** Check current link status for each open folder against the given root. */
export async function inspectAllFolders(
  root: RunQLStorageRoot
): Promise<LinkStatus[]> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return [];
  return Promise.all(folders.map((f) => inspectFolder(f, root)));
}

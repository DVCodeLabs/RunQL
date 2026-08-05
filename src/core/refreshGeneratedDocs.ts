import * as vscode from 'vscode';
import {
  ensureAgentsMd,
  ensureReadmeMd,
  fileExists,
  RUNQL_LINK_DIR,
  RUNQL_LINK_STORAGE_ROOT,
} from './fsWorkspace';
import { tryResolveRunQLRoot } from './storageRoot';
import { Logger } from './logger';

const LAST_VERSION_KEY = 'runql.docs.lastActivatedVersion';

/**
 * Refresh RunQL-generated docs (AGENTS.md bounded section + README_RUNQL.md
 * when unedited) in every workspace folder that is already linked to RunQL.
 *
 * Called on activation only when the extension version has changed since
 * the last activation — so user-visible file rewrites only fire on
 * upgrades, not every launch.
 *
 * "Linked" means:
 *   - workspace mode: the folder is the resolved storage root's parent
 *     (i.e., <folder>/RunQL/queries exists — proof that RunQL is set
 *     up here).
 *   - user/custom mode: the folder has <folder>/.runql-link/storage-root.json.
 *
 * Folders that don't meet those criteria are skipped — we don't want to
 * create AGENTS.md/README_RUNQL.md in a random project the user just
 * happened to open.
 */
export async function maybeRefreshGeneratedDocsOnVersionBump(
  context: vscode.ExtensionContext,
  currentVersion: string
): Promise<void> {
  if (!currentVersion) return;
  const lastVersion = context.globalState.get<string>(LAST_VERSION_KEY);
  if (lastVersion === currentVersion) return;

  try {
    const linked = await findLinkedFolders();
    if (linked.length > 0) {
      Logger.info(
        `RunQL version bump ${lastVersion ?? '(none)'} -> ${currentVersion}: refreshing generated docs in ${linked.length} folder(s).`
      );
      await ensureAgentsMd(linked);
      await ensureReadmeMd(linked);
    }
  } catch (e) {
    Logger.warn('Doc refresh on version bump failed', e);
  } finally {
    // Always stamp the version so a failed refresh doesn't re-run on
    // every activation.
    try {
      await context.globalState.update(LAST_VERSION_KEY, currentVersion);
    } catch (e) {
      Logger.warn('Failed to record last-activated version for doc refresh', e);
    }
  }
}

/**
 * Return the workspace folders that are currently linked to RunQL:
 *   - workspace mode: the folder that owns the resolved storage root
 *     (i.e., `<folder>/RunQL/queries/` exists).
 *   - user/custom mode: any folder with `.runql-link/storage-root.json`.
 *
 * Exported so `postMigrationHousekeeping` and other subsystems that
 * touch project-local RunQL files can avoid writing into unrelated
 * folders of a multi-root workspace.
 */
export async function findLinkedFolders(): Promise<vscode.WorkspaceFolder[]> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return [];
  const root = tryResolveRunQLRoot();
  if (!root) return [];

  const linked: vscode.WorkspaceFolder[] = [];
  if (root.location === 'workspace') {
    // Workspace mode: folder is linked when it owns the resolved
    // storage root (i.e., <folder>/RunQL exists with the required
    // subdirs).
    for (const f of folders) {
      const rootUri = vscode.Uri.joinPath(f.uri, 'RunQL');
      if (rootUri.path !== root.uri.path) continue;
      if (await fileExists(vscode.Uri.joinPath(rootUri, 'queries'))) {
        linked.push(f);
      }
    }
    return linked;
  }

  // User/custom mode: folder is linked when it has an authoritative
  // .runql-link/storage-root.json marker.
  for (const f of folders) {
    const marker = vscode.Uri.joinPath(
      f.uri,
      RUNQL_LINK_DIR,
      RUNQL_LINK_STORAGE_ROOT
    );
    if (await fileExists(marker)) linked.push(f);
  }
  return linked;
}

import * as vscode from 'vscode';
import {
  fileExists,
  pruneRunqlGitignoreEntries,
  removeRunqlLinkFolder,
  RUNQL_LINK_DIR,
} from './fsWorkspace';
import { tryResolveRunQLRoot } from './storageRoot';
import { Logger } from './logger';

export interface CleanupResult {
  folder: string;
  removedLinkDir: boolean;
  prunedGitignore: boolean;
}

/**
 * When RunQL is in workspace mode, `.runql-link/` markers from a prior
 * user/custom session are stale. Delete the folder in every open
 * workspace folder that has one and prune RunQL-owned entries from
 * `.gitignore`. Refuses to delete `.runql-link/` folders that contain
 * unexpected files (surfaced as a warning).
 *
 * No-op in user/custom mode. Idempotent.
 */
export async function cleanupWorkspaceLinksOnWorkspaceMode(): Promise<CleanupResult[]> {
  const root = tryResolveRunQLRoot();
  if (!root || root.location !== 'workspace') return [];
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return [];

  const results: CleanupResult[] = [];
  for (const folder of folders) {
    const linkDir = vscode.Uri.joinPath(folder.uri, RUNQL_LINK_DIR);
    const hadLinkDir = await fileExists(linkDir);
    let removed = false;
    if (hadLinkDir) {
      removed = await removeRunqlLinkFolder(folder);
      if (removed) {
        Logger.info(`Removed stale ${linkDir.fsPath}`);
      }
    }
    try {
      await pruneRunqlGitignoreEntries(folder);
    } catch (e) {
      Logger.warn(`Failed to prune .gitignore for ${folder.uri.fsPath}`, e);
    }
    results.push({
      folder: folder.uri.fsPath,
      removedLinkDir: removed,
      prunedGitignore: true,
    });
  }
  return results;
}

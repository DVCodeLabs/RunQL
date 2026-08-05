import * as vscode from 'vscode';
import { tryResolveRunQLRoot } from './storageRoot';

/**
 * Checks whether the resolved RunQL storage root exists with the standard
 * required subdirectories. Read-only, no side effects.
 */
export async function isProjectInitialized(): Promise<boolean> {
  const root = tryResolveRunQLRoot();
  if (!root) return false;

  const dpDir = root.uri;
  try {
    const stat = await vscode.workspace.fs.stat(dpDir);
    if (stat.type !== vscode.FileType.Directory) return false;
  } catch {
    return false;
  }

  const requiredSubs = ['queries', 'schemas', 'system'];
  for (const sub of requiredSubs) {
    try {
      const subUri = vscode.Uri.joinPath(dpDir, sub);
      const stat = await vscode.workspace.fs.stat(subUri);
      if (stat.type !== vscode.FileType.Directory) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Updates the runql.project.initialized context key based on current state.
 */
export async function updateProjectInitializedContext(): Promise<boolean> {
  const initialized = await isProjectInitialized();
  await vscode.commands.executeCommand('setContext', 'runql.project.initialized', initialized);
  return initialized;
}

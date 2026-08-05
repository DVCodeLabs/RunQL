import * as vscode from "vscode";
import { onDidChangeStorageRoot, tryResolveRunQLRoot, RunQLStorageRoot } from "./storageRoot";
import { Logger } from "./logger";

export interface Watchers {
  dispose(): void;
}

/**
 * Register file system watchers for the RunQL data root. Watchers are
 * scoped to the resolved storage root (workspace, user, or custom) via
 * vscode.RelativePattern so they fire whether the root lives inside a
 * workspace folder or not. When storage settings change, the watchers
 * are disposed and re-registered against the new resolved root.
 */
export function registerDPWatchers(
  onConnectionsChanged: () => void,
  onSchemasChanged: () => void,
  onQueryIndexChanged: () => void
): Watchers {
  let current: vscode.Disposable | undefined = createWatchers(
    tryResolveRunQLRoot(),
    onConnectionsChanged,
    onSchemasChanged,
    onQueryIndexChanged
  );

  const changeSub = onDidChangeStorageRoot(({ next }) => {
    try {
      current?.dispose();
    } catch (e) {
      Logger.warn("Failed to dispose previous RunQL watchers", e);
    }
    current = createWatchers(
      next,
      onConnectionsChanged,
      onSchemasChanged,
      onQueryIndexChanged
    );
    // Re-fire so downstream views refresh against the new root.
    try {
      onConnectionsChanged();
      onSchemasChanged();
      onQueryIndexChanged();
    } catch (e) {
      Logger.warn("Failed to refresh views after storage-root change", e);
    }
  });

  return {
    dispose: () => {
      try {
        current?.dispose();
      } catch {
        // Ignored
      }
      changeSub.dispose();
    },
  };
}

function createWatchers(
  root: RunQLStorageRoot | undefined,
  onConnectionsChanged: () => void,
  onSchemasChanged: () => void,
  onQueryIndexChanged: () => void
): vscode.Disposable | undefined {
  if (!root) return undefined;
  if (root.uri.scheme !== "file") {
    // VS Code's createFileSystemWatcher requires a file-scheme base.
    // Non-local schemes (e.g. virtual FS) are not supported in v1.
    Logger.warn(
      `RunQL storage root has unsupported scheme "${root.uri.scheme}"; file watchers not registered.`
    );
    return undefined;
  }

  const subs: vscode.Disposable[] = [];

  const connPattern = new vscode.RelativePattern(root.uri, "system/connections.json");
  const connWatcher = vscode.workspace.createFileSystemWatcher(connPattern);
  subs.push(connWatcher);
  subs.push(connWatcher.onDidChange(onConnectionsChanged));
  subs.push(connWatcher.onDidCreate(onConnectionsChanged));
  subs.push(connWatcher.onDidDelete(onConnectionsChanged));

  const schemaPattern = new vscode.RelativePattern(root.uri, "schemas/**/*.json");
  const schemaWatcher = vscode.workspace.createFileSystemWatcher(schemaPattern);
  subs.push(schemaWatcher);
  subs.push(schemaWatcher.onDidChange(onSchemasChanged));
  subs.push(schemaWatcher.onDidCreate(onSchemasChanged));
  subs.push(schemaWatcher.onDidDelete(onSchemasChanged));

  const queryIndexPattern = new vscode.RelativePattern(
    root.uri,
    "system/queries/queryIndex.json"
  );
  const qWatcher = vscode.workspace.createFileSystemWatcher(queryIndexPattern);
  subs.push(qWatcher);
  subs.push(qWatcher.onDidChange(onQueryIndexChanged));
  subs.push(qWatcher.onDidCreate(onQueryIndexChanged));
  subs.push(qWatcher.onDidDelete(onQueryIndexChanged));

  return {
    dispose: () => subs.forEach((s) => s.dispose()),
  };
}

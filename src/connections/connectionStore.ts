import * as vscode from "vscode";
import { ConnectionProfile, ConnectionSecrets } from "../core/types";
import { ensureDPDirs, fileExists, readJson, writeJson } from "../core/fsWorkspace";
import { tryResolveRunQLRoot } from "../core/storageRoot";
import { Logger } from '../core/logger';
import { normalizeConnectionType } from './connectionType';
import { isReservedConnectionFolderName, normalizedConnectionFolderKey } from '../schema/schemaPaths';

let secretStorage: vscode.SecretStorage | undefined;

export function initConnectionStore(context: vscode.ExtensionContext) {
  secretStorage = context.secrets;
}

interface ConnectionsFile {
  version: "0.1";
  generatedAt: string;
  connections: ConnectionProfile[];
}

async function getConnectionsUri(createIfMissing = false): Promise<vscode.Uri | undefined> {
  if (createIfMissing) {
    try {
      const dpDir = await ensureDPDirs();
      return vscode.Uri.joinPath(dpDir, "system", "connections.json");
    } catch (e) {
      Logger.warn("Cannot ensure RunQL storage root for connections.json", e);
      return undefined;
    }
  }
  // Read-only path resolution must not create folders.
  const root = tryResolveRunQLRoot();
  if (!root) return undefined;
  return vscode.Uri.joinPath(root.uri, "system", "connections.json");
}

export async function loadConnectionProfiles(): Promise<ConnectionProfile[]> {
  const uri = await getConnectionsUri(false);
  if (!uri) return [];
  let connections: ConnectionProfile[] = [];

  if (await fileExists(uri)) {
    try {
      const file = await readJson<ConnectionsFile>(uri);
      connections = file.connections || [];

      // Migration: 'type' -> 'dialect' (v0 legacy fix)
      let changed = false;
      connections.forEach((c) => {
        const legacy = c as unknown as Record<string, unknown>;
        if (!legacy.dialect && legacy.type) {
          legacy.dialect = legacy.type;
          delete legacy.type;
          changed = true;
        }
        const normalizedConnectionType = normalizeConnectionType(legacy.connectionType);
        if (legacy.connectionType !== normalizedConnectionType) {
          legacy.connectionType = normalizedConnectionType;
          changed = true;
        }
      });

      if (changed) {
        await writeJson(uri, { ...file, connections });
      }

    } catch (e) {
      Logger.error("Failed to load connections.json", e);
    }
  }

  return connections;
}

/**
 * Save (create or update) a connection profile with optimistic concurrency
 * against `system/connections.json`:
 *
 *   1. Reload the latest file from disk (may reflect another window's edits).
 *   2. Merge by profile id — records only present on disk are preserved.
 *   3. If the disk record for the same id was modified after our baseline
 *      `updatedAt`, prompt Keep Current Window / Keep Disk / Cancel.
 *   4. Bump `updatedAt` on our record and write the merged file.
 */
export async function saveConnectionProfile(profile: ConnectionProfile): Promise<void> {
  const uri = await getConnectionsUri(true);
  if (!uri) {
    throw new Error("No workspace folder open.");
  }
  profile.connectionType = normalizeConnectionType(profile.connectionType);

  const nameError = await validateConnectionName(profile.name, profile.id);
  if (nameError) {
    throw new Error(nameError);
  }

  const baselineUpdatedAt = profile.updatedAt;
  const diskConnections = await loadConnectionProfiles();
  const diskIdx = diskConnections.findIndex((c) => c.id === profile.id);
  const diskProfile = diskIdx >= 0 ? diskConnections[diskIdx] : undefined;

  // Always work with a fresh object so we never mutate the caller's
  // profile in place. Mutating it would advance the caller's
  // `updatedAt` and break the baseline they'd hand back for a
  // subsequent save.
  let resolvedProfile: ConnectionProfile = { ...profile };

  if (diskProfile) {
    // Concurrent-edit detection uses `updatedAt` timestamps. When
    // either side is missing a parseable timestamp — pre-1.16 profiles
    // never had one — we can't tell whether disk moved on since our
    // load. Treat the missing baseline as "unknown" and still prompt
    // rather than silently overwriting.
    const diskTs = Date.parse(diskProfile.updatedAt ?? '');
    const baseTs = Date.parse(baselineUpdatedAt ?? '');
    const conflictKnown =
      Number.isFinite(diskTs) && Number.isFinite(baseTs) && diskTs > baseTs;
    const conflictUnknown =
      !Number.isFinite(baseTs) || !Number.isFinite(diskTs);
    if (conflictKnown || conflictUnknown) {
      const detail = conflictKnown
        ? `Connection "${profile.name}" was modified in another VS Code window since you started editing.`
        : `Connection "${profile.name}" has no reliable last-modified timestamp on one side, so RunQL can't be sure whether the disk copy has moved on. Choose which version to keep.`;
      const choice = await vscode.window.showWarningMessage(
        detail,
        { modal: true },
        'Keep Current Window Version',
        'Keep Disk Version',
        'Cancel'
      );
      if (!choice || choice === 'Cancel') {
        throw new Error('Save cancelled: connection was modified in another window.');
      }
      if (choice === 'Keep Disk Version') {
        return;
      }
      // Keep Current Window Version → fall through and overwrite.
    }
  }

  // Rename side-effects use whatever name the disk record currently has.
  const priorForRename = diskProfile;
  if (priorForRename && priorForRename.name !== resolvedProfile.name) {
    try {
      const { renameSchemaFiles } = require('../schema/schemaStore');
      const { renameQueryConnectionFolder } = require('../queryLibrary/queryStorage');
      await renameSchemaFiles(resolvedProfile.id, priorForRename.name, resolvedProfile.name);
      await renameQueryConnectionFolder(resolvedProfile.id, priorForRename.name, resolvedProfile.name);
    } catch (e) {
      Logger.error("Failed to rename connection-scoped files:", e);
    }
  }

  resolvedProfile.updatedAt = new Date().toISOString();

  const merged = [...diskConnections];
  if (diskIdx >= 0) {
    merged[diskIdx] = resolvedProfile;
  } else {
    merged.push(resolvedProfile);
  }

  const file: ConnectionsFile = {
    version: "0.1",
    generatedAt: new Date().toISOString(),
    connections: merged,
  };
  await writeJson(uri, file);
}

export async function deleteConnection(id: string): Promise<void> {
  const uri = await getConnectionsUri(true);
  if (!uri) {
    throw new Error("No workspace folder open.");
  }
  // Reload the latest disk state immediately before doing anything so
  // side-effects (schema folder rename, query folder archive) use the
  // current connection name — a concurrent rename in another window
  // between our earlier load and this delete would otherwise leave
  // orphaned folders under the pre-rename name.
  const latest = await loadConnectionProfiles();
  const existing = latest.find(c => c.id === id);
  if (existing) {
    try {
      const { archiveSchemaFilesForDeletedConnection } = require('../schema/schemaStore');
      const { archiveQueryConnectionFolder } = require('../queryLibrary/queryStorage');
      await archiveSchemaFilesForDeletedConnection(existing.id, existing.name);
      await archiveQueryConnectionFolder(existing.id, existing.name);
    } catch (e) {
      Logger.error("Failed to archive connection-scoped files:", e);
    }
  }
  const filtered = latest.filter(c => c.id !== id);

  const file: ConnectionsFile = {
    version: "0.1",
    generatedAt: new Date().toISOString(),
    connections: filtered,
  };
  await writeJson(uri, file);

  // also delete secrets
  if (secretStorage) {
    await secretStorage.delete(`runql.secrets.${id}`);
  }
}

const sessionSecrets = new Map<string, string>(); // JSON stringified

export async function getConnectionSecrets(id: string): Promise<ConnectionSecrets> {
  // Determine mode from profile
  const profile = await getConnection(id);
  // Default to 'secretStorage' for legacy compatibility if undefined
  const mode = profile?.credentialStorageMode || 'secretStorage';

  if (mode === 'session') {
    if (sessionSecrets.has(id)) {
      try {
        return JSON.parse(sessionSecrets.get(id)!);
      } catch {
        return {};
      }
    }
    return {};
  } else if (mode === 'secretStorage') {
    if (!secretStorage) { return {}; }
    const json = await secretStorage.get(`runql.secrets.${id}`);
    if (!json) { return {}; }
    try {
      return JSON.parse(json) as ConnectionSecrets;
    } catch {
      return {};
    }
  }
  return {};
}

export async function saveConnectionSecrets(id: string, secrets: ConnectionSecrets, explicitMode?: 'session' | 'secretStorage' | 'browser'): Promise<void> {
  let mode = explicitMode;
  if (!mode) {
    const profile = await getConnection(id);
    mode = profile?.credentialStorageMode || 'secretStorage';
  }

  if (mode === 'session') {
    sessionSecrets.set(id, JSON.stringify(secrets));
    // Optional: Clear from secretStorage if previously there?
    // For safety/cleanup, we could attempts to delete from secretStorage.
    if (secretStorage) {
      await secretStorage.delete(`runql.secrets.${id}`);
    }
  } else if (mode === 'secretStorage') {
    if (!secretStorage) {
      throw new Error("SecretStorage not initialized");
    }
    await secretStorage.store(`runql.secrets.${id}`, JSON.stringify(secrets));
    // Clear from session if exists
    sessionSecrets.delete(id);
  }
}

export async function validateConnectionName(name: string, excludeId?: string): Promise<string | undefined> {
  const profiles = await loadConnectionProfiles();
  const clean = name.trim();
  if (!clean) return "Name cannot be empty";

  if (isReservedConnectionFolderName(clean)) {
    return "'Unassigned' is reserved by RunQL. Choose a different connection name.";
  }

  const cleanKey = normalizedConnectionFolderKey(clean);
  const conflict = profiles.find(p => normalizedConnectionFolderKey(p.name) === cleanKey && p.id !== excludeId);
  if (conflict) {
    return `Connection name '${clean}' is already in use.`;
  }
  return undefined;
}
// Helper to get single connection
export async function getConnection(id: string): Promise<ConnectionProfile | undefined> {
  const profiles = await loadConnectionProfiles();
  return profiles.find(p => p.id === id);
}

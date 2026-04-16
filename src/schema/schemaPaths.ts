import * as vscode from 'vscode';
import { Logger } from '../core/logger';
import { SchemaIntrospection } from '../core/types';
import { fileExists, readJson } from '../core/fsWorkspace';

export const SCHEMA_BUNDLE_FILES = {
  schema: 'schema.json',
  description: 'description.json',
  customRelationships: 'custom.relationships.json',
  erd: 'erd.json',
  layout: 'erd.layout.json',
} as const;

export const LEGACY_SCHEMA_BUNDLE_LAYOUT_FILE = 'layout.json';

export function sanitizeSchemaBundleName(connectionName?: string, connectionId?: string): string {
  const base = (connectionName && connectionName.trim().length > 0) ? connectionName : connectionId;
  const safe = String(base || 'connection').replace(/[^a-z0-9_\-\.]/gi, '_');
  return safe.length > 0 ? safe : 'connection';
}

export function getSchemasRoot(dpDir: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(dpDir, 'schemas');
}

export function getSchemaMigrationsRoot(dpDir: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(dpDir, 'system', 'migrations');
}

export function getSchemaBundleMigrationStateUri(dpDir: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(getSchemaMigrationsRoot(dpDir), 'schema-bundles-v1.json');
}

export function getMigrationBackupRoot(dpDir: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(dpDir, 'system', 'migration_backup');
}

export function getMigrationBackupSchemasRoot(dpDir: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(getMigrationBackupRoot(dpDir), 'schemas');
}

export function getMigrationBackupErdRoot(dpDir: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(getMigrationBackupRoot(dpDir), 'erd');
}

export function getMigrationBackupManifestUri(dpDir: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(getMigrationBackupRoot(dpDir), 'manifest.json');
}

export function buildSchemaBundlePaths(bundleDir: vscode.Uri) {
  return {
    bundleDir,
    schema: vscode.Uri.joinPath(bundleDir, SCHEMA_BUNDLE_FILES.schema),
    description: vscode.Uri.joinPath(bundleDir, SCHEMA_BUNDLE_FILES.description),
    customRelationships: vscode.Uri.joinPath(bundleDir, SCHEMA_BUNDLE_FILES.customRelationships),
    erd: vscode.Uri.joinPath(bundleDir, SCHEMA_BUNDLE_FILES.erd),
    layout: vscode.Uri.joinPath(bundleDir, SCHEMA_BUNDLE_FILES.layout),
  };
}

export async function listSchemaBundleDirs(dpDir: vscode.Uri): Promise<vscode.Uri[]> {
  const root = getSchemasRoot(dpDir);
  try {
    const entries = await vscode.workspace.fs.readDirectory(root);
    const dirs: vscode.Uri[] = [];
    for (const [name] of entries) {
      const candidate = vscode.Uri.joinPath(root, name);
      if (await fileExists(vscode.Uri.joinPath(candidate, SCHEMA_BUNDLE_FILES.schema))) {
        dirs.push(candidate);
      }
    }
    return dirs;
  } catch (err) {
    Logger.warn(`Failed to enumerate schema bundles in ${root.fsPath}`, err);
    return [];
  }
}

async function readBundleSchema(bundleDir: vscode.Uri): Promise<SchemaIntrospection | undefined> {
  try {
    return await readJson<SchemaIntrospection>(vscode.Uri.joinPath(bundleDir, SCHEMA_BUNDLE_FILES.schema));
  } catch (err) {
    Logger.warn(`Failed to read schema bundle ${bundleDir.fsPath}`, err);
    return undefined;
  }
}

export async function findSchemaBundleDirByConnectionId(dpDir: vscode.Uri, connectionId: string): Promise<vscode.Uri | undefined> {
  const bundleDirs = await listSchemaBundleDirs(dpDir);
  for (const bundleDir of bundleDirs) {
    const schema = await readBundleSchema(bundleDir);
    if (schema?.connectionId === connectionId) {
      return bundleDir;
    }
  }
  return undefined;
}

function shortConnectionId(connectionId: string): string {
  return connectionId.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bundle';
}

export async function resolveSchemaBundleDir(
  dpDir: vscode.Uri,
  connectionId: string,
  connectionName?: string
): Promise<vscode.Uri> {
  const existing = await findSchemaBundleDirByConnectionId(dpDir, connectionId);
  if (existing) {
    return existing;
  }

  const root = getSchemasRoot(dpDir);
  const preferredName = sanitizeSchemaBundleName(connectionName, connectionId);
  const preferredDir = vscode.Uri.joinPath(root, preferredName);
  if (!await fileExists(preferredDir)) {
    return preferredDir;
  }

  const existingSchema = await readBundleSchema(preferredDir);
  if (existingSchema?.connectionId === connectionId) {
    return preferredDir;
  }

  return vscode.Uri.joinPath(root, `${preferredName}--${shortConnectionId(connectionId)}`);
}

export async function resolveSchemaBundlePaths(
  dpDir: vscode.Uri,
  connectionId: string,
  connectionName?: string
) {
  const bundleDir = await resolveSchemaBundleDir(dpDir, connectionId, connectionName);
  return buildSchemaBundlePaths(bundleDir);
}

export async function getDescriptionUriForConnection(
  dpDir: vscode.Uri,
  connectionId: string,
  connectionName?: string
): Promise<vscode.Uri> {
  const paths = await resolveSchemaBundlePaths(dpDir, connectionId, connectionName);
  return paths.description;
}

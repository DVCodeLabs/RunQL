
import * as vscode from 'vscode';
import {
  SchemaIntrospection,
  CustomRelationshipsFile,
  CustomRelationship,
  SchemaModel,
  RoutineModel,
  RoutineParameterModel,
} from '../core/types';
import { ensureDPDirs, readJson, writeJson, fileExists } from '../core/fsWorkspace';
import { SchemaDescriptionsFile } from './descriptionStore';
import { Logger } from '../core/logger';
import {
  buildSchemaBundlePaths,
  listSchemaBundleDirs,
  resolveSchemaBundleDir,
  resolveSchemaBundlePaths,
  sanitizeSchemaBundleName,
} from './schemaPaths';

function normalizeRoutineModel(rawRoutine: Record<string, unknown>, fallbackKind: 'procedure' | 'function'): RoutineModel {
  const kind = rawRoutine?.kind === 'procedure' || rawRoutine?.kind === 'function'
    ? rawRoutine.kind
    : fallbackKind;
  return {
    name: String(rawRoutine?.name ?? ''),
    kind,
    comment: typeof rawRoutine?.comment === 'string' ? rawRoutine.comment : undefined,
    returnType: typeof rawRoutine?.returnType === 'string' ? rawRoutine.returnType : undefined,
    language: typeof rawRoutine?.language === 'string' ? rawRoutine.language : undefined,
    deterministic: typeof rawRoutine?.deterministic === 'boolean' ? rawRoutine.deterministic : undefined,
    schemaQualifiedName: typeof rawRoutine?.schemaQualifiedName === 'string' ? rawRoutine.schemaQualifiedName : undefined,
    signature: typeof rawRoutine?.signature === 'string' ? rawRoutine.signature : undefined,
    parameters: Array.isArray(rawRoutine?.parameters)
      ? (rawRoutine.parameters as Record<string, unknown>[])
        .map((p: Record<string, unknown>): RoutineParameterModel => ({
          name: String(p?.name ?? ''),
          mode: typeof p?.mode === 'string' ? p.mode as RoutineParameterModel['mode'] : undefined,
          type: typeof p?.type === 'string' ? p.type : undefined,
          position: typeof p?.position === 'number' ? p.position : undefined,
        }))
        .filter(p => p.name.length > 0)
      : [],
  };
}

function normalizeSchemaModel(rawSchema: Record<string, unknown>): SchemaModel {
  const tables = Array.isArray(rawSchema?.tables) ? rawSchema.tables : [];
  const views = Array.isArray(rawSchema?.views) ? rawSchema.views : [];
  const procedures = Array.isArray(rawSchema?.procedures)
    ? rawSchema.procedures.map((routine: Record<string, unknown>) => normalizeRoutineModel(routine, 'procedure'))
    : [];
  const functions = Array.isArray(rawSchema?.functions)
    ? rawSchema.functions.map((routine: Record<string, unknown>) => normalizeRoutineModel(routine, 'function'))
    : [];

  return {
    name: String(rawSchema?.name ?? ''),
    tables,
    views,
    procedures,
    functions,
  };
}

function normalizeSchemaIntrospection(rawSchema: Record<string, unknown>): SchemaIntrospection | undefined {
  if (!rawSchema || !rawSchema.connectionId) return undefined;
  const schemas = Array.isArray(rawSchema.schemas)
    ? (rawSchema.schemas as Record<string, unknown>[]).map(normalizeSchemaModel)
    : [];
  return {
    version: rawSchema.version === '0.2' ? '0.2' : '0.1',
    generatedAt: typeof rawSchema.generatedAt === 'string' ? rawSchema.generatedAt : new Date().toISOString(),
    connectionId: String(rawSchema.connectionId),
    connectionName: typeof rawSchema.connectionName === 'string' ? rawSchema.connectionName : undefined,
    dialect: String(rawSchema.dialect ?? '') as SchemaIntrospection['dialect'],
    docPath: typeof rawSchema.docPath === 'string' ? rawSchema.docPath : undefined,
    customRelationshipsPath: typeof rawSchema.customRelationshipsPath === 'string' ? rawSchema.customRelationshipsPath : undefined,
    schemas,
  };
}

/**
 * Monotonically increasing counter that bumps whenever schemas are
 * saved, deleted, or renamed. Consumers can compare their last-seen
 * version to decide if cached data is stale.
 */
let schemaVersion = 0;

export function getSchemaVersion(): number {
  return schemaVersion;
}

export function bumpSchemaVersion(): void {
  schemaVersion++;
}

function buildDefaultDescription(normalized: SchemaIntrospection): SchemaDescriptionsFile {
  return {
    __runqlHeader: "#RunQL created",
    version: "0.1",
    generatedAt: new Date().toISOString(),
    connectionId: normalized.connectionId,
    connectionName: normalized.connectionName,
    dialect: normalized.dialect,
    schemaName: normalized.schemas?.[0]?.name || 'main',
    tables: {},
    columns: {}
  };
}

function buildDefaultCustomRelationships(normalized: SchemaIntrospection): CustomRelationshipsFile {
  return {
    version: "0.1",
    connectionId: normalized.connectionId,
    connectionName: normalized.connectionName,
    relationships: []
  };
}

function buildOrderedIntrospection(normalized: SchemaIntrospection, paths: ReturnType<typeof buildSchemaBundlePaths>): SchemaIntrospection {
  return {
    version: "0.2",
    generatedAt: normalized.generatedAt,
    connectionId: normalized.connectionId,
    connectionName: normalized.connectionName,
    dialect: normalized.dialect,
    docPath: paths.description.fsPath,
    customRelationshipsPath: paths.customRelationships.fsPath,
    schemas: normalized.schemas
  };
}

async function ensureBundleFiles(paths: ReturnType<typeof buildSchemaBundlePaths>, normalized: SchemaIntrospection): Promise<void> {
  await vscode.workspace.fs.createDirectory(paths.bundleDir);

  if (!await fileExists(paths.description)) {
    await writeJson(paths.description, buildDefaultDescription(normalized));
  }

  if (!await fileExists(paths.customRelationships)) {
    await writeJson(paths.customRelationships, buildDefaultCustomRelationships(normalized));
  }
}

async function updateJsonFile<T extends object>(
  uri: vscode.Uri,
  updater: (data: T) => boolean | void
): Promise<void> {
  try {
    if (!await fileExists(uri)) return;
    const data = await readJson<T>(uri);
    const changed = updater(data);
    if (changed !== false) {
      await writeJson(uri, data);
    }
  } catch (err) {
    Logger.warn(`Failed to update JSON file ${uri.fsPath}`, err);
  }
}

async function resolveRenameTargetBundleDir(
  dpDir: vscode.Uri,
  connectionId: string,
  currentBundleDir: vscode.Uri | undefined,
  newName: string
): Promise<vscode.Uri> {
  const root = vscode.Uri.joinPath(dpDir, 'schemas');
  const preferredName = sanitizeSchemaBundleName(newName, connectionId);
  const preferredDir = vscode.Uri.joinPath(root, preferredName);

  if (!currentBundleDir || currentBundleDir.fsPath === preferredDir.fsPath) {
    return preferredDir;
  }

  if (!await fileExists(preferredDir)) {
    return preferredDir;
  }

  try {
    const existing = await readJson<SchemaIntrospection>(vscode.Uri.joinPath(preferredDir, 'schema.json'));
    if (existing?.connectionId === connectionId) {
      return preferredDir;
    }
  } catch {
    // Fall through to suffixed directory.
  }

  return vscode.Uri.joinPath(root, `${preferredName}--${connectionId.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bundle'}`);
}

export async function loadSchemas(): Promise<SchemaIntrospection[]> {
  const dpDir = await ensureDPDirs();
  const bundleDirs = await listSchemaBundleDirs(dpDir);
  const allSchemas: SchemaIntrospection[] = [];

  for (const bundleDir of bundleDirs) {
    const schemaUri = vscode.Uri.joinPath(bundleDir, 'schema.json');
    try {
      const raw = await readJson<Record<string, unknown>>(schemaUri);
      const normalized = normalizeSchemaIntrospection(raw);
      if (normalized) {
        normalized.docPath = vscode.Uri.joinPath(bundleDir, 'description.json').fsPath;
        normalized.customRelationshipsPath = vscode.Uri.joinPath(bundleDir, 'custom.relationships.json').fsPath;
        allSchemas.push(normalized);
      }
    } catch (err) {
      Logger.warn(`Failed to parse schema bundle ${bundleDir.fsPath}`, err);
    }
  }

  const schemaMap = new Map<string, SchemaIntrospection>();
  for (const schema of allSchemas) {
    const existing = schemaMap.get(schema.connectionId);
    if (!existing || (schema.schemas?.length ?? 0) > (existing.schemas?.length ?? 0)) {
      schemaMap.set(schema.connectionId, schema);
    }
  }

  return Array.from(schemaMap.values());
}

export async function saveSchema(introspection: SchemaIntrospection) {
  bumpSchemaVersion();
  const normalized = normalizeSchemaIntrospection(introspection as unknown as Record<string, unknown>);
  if (!normalized) {
    throw new Error('Invalid schema introspection payload');
  }

  const dpDir = await ensureDPDirs();
  const paths = await resolveSchemaBundlePaths(dpDir, normalized.connectionId, normalized.connectionName);
  await ensureBundleFiles(paths, normalized);
  await writeJson(paths.schema, buildOrderedIntrospection(normalized, paths));
}

export async function deleteSchema(connectionId: string, connectionName?: string) {
  bumpSchemaVersion();
  const dpDir = await ensureDPDirs();
  const bundleDir = await resolveSchemaBundleDir(dpDir, connectionId, connectionName);
  try {
    if (await fileExists(bundleDir)) {
      await vscode.workspace.fs.delete(bundleDir, { recursive: true, useTrash: false });
    }
  } catch (err) {
    Logger.warn(`Failed to delete schema bundle ${bundleDir.fsPath}`, err);
  }
}

export async function renameSchemaFiles(connectionId: string, oldName: string, newName: string) {
  bumpSchemaVersion();
  const dpDir = await ensureDPDirs();
  const currentBundleDir = await resolveSchemaBundleDir(dpDir, connectionId, oldName);
  if (!await fileExists(currentBundleDir)) return;

  const targetBundleDir = await resolveRenameTargetBundleDir(dpDir, connectionId, currentBundleDir, newName);
  if (currentBundleDir.fsPath !== targetBundleDir.fsPath) {
    try {
      await vscode.workspace.fs.rename(currentBundleDir, targetBundleDir, { overwrite: true });
    } catch (err) {
      Logger.warn(`Failed to rename schema bundle ${currentBundleDir.fsPath}`, err);
      return;
    }
  }

  const paths = buildSchemaBundlePaths(targetBundleDir);
  await updateJsonFile<SchemaIntrospection>(paths.schema, (schema) => {
    schema.connectionName = newName;
    schema.docPath = paths.description.fsPath;
    schema.customRelationshipsPath = paths.customRelationships.fsPath;
  });
  await updateJsonFile<SchemaDescriptionsFile>(paths.description, (description) => {
    description.connectionName = newName;
  });
  await updateJsonFile<CustomRelationshipsFile>(paths.customRelationships, (customRelationships) => {
    customRelationships.connectionName = newName;
  });
  await updateJsonFile<Record<string, unknown>>(paths.layout, (layout) => {
    layout.connectionName = newName;
  });
}

// Custom Relationships Management
export async function loadCustomRelationships(customRelationshipsPath: string): Promise<CustomRelationship[]> {
  try {
    const uri = vscode.Uri.file(customRelationshipsPath);
    const file = await readJson<CustomRelationshipsFile>(uri);
    return file?.relationships || [];
  } catch (_e) {
    Logger.warn('Failed to load custom relationships:', _e);
    return [];
  }
}

export async function saveCustomRelationships(
  connectionId: string,
  connectionName: string,
  relationships: CustomRelationship[]
) {
  const dpDir = await ensureDPDirs();
  const paths = await resolveSchemaBundlePaths(dpDir, connectionId, connectionName);
  await vscode.workspace.fs.createDirectory(paths.bundleDir);

  const file: CustomRelationshipsFile = {
    version: "0.1",
    connectionId,
    connectionName,
    relationships
  };

  await writeJson(paths.customRelationships, file);
}

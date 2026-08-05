
import * as vscode from 'vscode';
import { Logger } from './logger';
import {
  RunQLStorageRoot,
  resolveRunQLRoot,
  tryResolveRunQLRoot,
} from './storageRoot';

/**
 * Resolve the RunQL data root and ensure the standard subdirectory layout
 * exists inside it. Throws RunQLStorageError when the current storage
 * settings are not resolvable (e.g. workspace mode with no folder open).
 */
export async function ensureDPDirs(): Promise<vscode.Uri> {
  const root = resolveRunQLRoot();
  const dpDir = root.uri;

  try {
    await vscode.workspace.fs.createDirectory(dpDir);
  } catch {
    // Directory already exists - safe to ignore
  }

  // system/migrations and system/migration_backup are created lazily when
  // a migration or backup actually needs them.
  const subs = ['schemas', 'queries', 'system', 'system/queries', 'system/prompts'];
  for (const s of subs) {
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(dpDir, s));
    } catch {
      // Directory already exists - safe to ignore
    }
  }

  return dpDir;
}

export async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(uri: vscode.Uri): Promise<T> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  const text = new TextDecoder().decode(bytes);
  if (!text || !text.trim()) {
    throw new Error(`File is empty: ${uri.fsPath}`);
  }
  return JSON.parse(text);
}

export async function writeJson(uri: vscode.Uri, data: unknown): Promise<void> {
  const text = JSON.stringify(data, null, 2);
  const bytes = new TextEncoder().encode(text);
  await vscode.workspace.fs.writeFile(uri, bytes);
}

export async function listFiles(dir: vscode.Uri): Promise<string[]> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    return entries.map(([name, _type]) => name);
  } catch (e) {
    Logger.warn(`listFiles failed for ${dir.toString()}`, e);
    return [];
  }
}

// -----------------------------------------------------------------------------
// AGENTS.md — bounded RunQL section, marker-based append/update
// -----------------------------------------------------------------------------

const RUNQL_BEGIN = '<!-- RUNQL:BEGIN -->';
const RUNQL_END = '<!-- RUNQL:END -->';

interface AgentsMarkerScan {
  status: 'none' | 'one' | 'malformed';
  startIdx?: number;
  endIdx?: number;
}

function scanRunqlMarkers(content: string): AgentsMarkerScan {
  const beginCount = (content.match(/<!--\s*RUNQL:BEGIN\s*-->/g) ?? []).length;
  const endCount = (content.match(/<!--\s*RUNQL:END\s*-->/g) ?? []).length;
  if (beginCount === 0 && endCount === 0) return { status: 'none' };
  if (beginCount !== 1 || endCount !== 1) return { status: 'malformed' };
  const startIdx = content.indexOf(RUNQL_BEGIN);
  const endIdx = content.indexOf(RUNQL_END);
  if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) return { status: 'malformed' };
  return { status: 'one', startIdx, endIdx };
}

/**
 * For each open workspace folder, ensure `AGENTS.md` reflects the current
 * RunQL storage root using a bounded RunQL section (idempotent).
 *
 * Behavior per the storage-location spec:
 *   - Missing AGENTS.md          → create with a storage-aware RunQL section
 *   - Exists, no RUNQL markers   → append a bounded RunQL section at the end
 *   - Exists, exactly one section → replace only content between markers
 *   - Malformed/duplicate markers → leave untouched, report via Logger
 *
 * `folders` narrows the update to a specific set (used by the workspace-link
 * flow so we don't rewrite guidance in every open folder silently).
 */
export async function ensureAgentsMd(
  folders?: vscode.WorkspaceFolder[]
): Promise<void> {
  const targets = folders ?? vscode.workspace.workspaceFolders;
  if (!targets || targets.length === 0) return;

  const root = tryResolveRunQLRoot();
  if (!root) return;

  const section = runqlAgentsSection(root);

  for (const folder of targets) {
    const agentsUri = vscode.Uri.joinPath(folder.uri, 'AGENTS.md');
    try {
      if (!(await fileExists(agentsUri))) {
        const initial = defaultAgentsHeader() + '\n' + section + '\n';
        await vscode.workspace.fs.writeFile(agentsUri, new TextEncoder().encode(initial));
        continue;
      }

      const bytes = await vscode.workspace.fs.readFile(agentsUri);
      const existing = new TextDecoder().decode(bytes);
      const scan = scanRunqlMarkers(existing);

      if (scan.status === 'malformed') {
        Logger.warn(
          `AGENTS.md at ${agentsUri.fsPath} has malformed, partial, or duplicate RunQL markers; leaving untouched.`
        );
        continue;
      }

      if (scan.status === 'none') {
        const trailing = existing.endsWith('\n') ? '' : '\n';
        const updated = existing + trailing + '\n' + section + '\n';
        await vscode.workspace.fs.writeFile(agentsUri, new TextEncoder().encode(updated));
        continue;
      }

      // Exactly one valid section — replace between markers.
      const before = existing.substring(0, scan.startIdx!);
      const afterStart = scan.endIdx! + RUNQL_END.length;
      const after = existing.substring(afterStart);
      const updated = before + section + after;
      if (updated !== existing) {
        await vscode.workspace.fs.writeFile(agentsUri, new TextEncoder().encode(updated));
      }
    } catch (e) {
      Logger.warn(`Failed to update AGENTS.md at ${agentsUri.fsPath}`, e);
    }
  }
}

function defaultAgentsHeader(): string {
  return `# Agent Guidance\n\nThis repo uses RunQL for SQL workflows and schema exploration.\n`;
}

function runqlAgentsSection(root: RunQLStorageRoot): string {
  const displayRoot = displayForDoc(root);
  const queries = joinDisplay(displayRoot, 'queries');
  const schemas = joinDisplay(displayRoot, 'schemas');
  const queryIndex = joinDisplay(displayRoot, 'system/queries/queryIndex.json');
  const connections = joinDisplay(displayRoot, 'system/connections.json');
  const prompts = joinDisplay(displayRoot, 'system/prompts');
  const markdownDocPrompt = joinDisplay(prompts, 'markdownDoc.txt');
  const describeSchemaPrompt = joinDisplay(prompts, 'describeSchema.txt');
  const inlineCommentsPrompt = joinDisplay(prompts, 'inlineComments.txt');
  const modeNote = storageModeNote(root);
  return `${RUNQL_BEGIN}
# RunQL Context

${modeNote}

RunQL storage root:

${displayRoot}

Useful paths:

- Queries: ${queries}
- Query index: ${queryIndex} (auto-updated when a query is saved)
- Schemas: ${schemas}
- Connection profiles: ${connections}
- Prompt templates: ${prompts}

## Required Workflow (SQL Queries)

1. Search for existing queries first — check the query index and \`${queries}\` (including subdirectories).
2. If nothing relevant exists, read the schema and docs under \`${schemas}\`. Use \`${schemas}/<connection>/manifest.json\` to find available schemas, then read only the relevant \`${schemas}/<connection>/<schema>/schema.json\` and \`description.json\`. Ignore \`${schemas}/deleted/\` and \`*_deleted\` folders unless the user asks for archived content.
3. Only then create a new SQL query file. Prefer to reuse or extend existing patterns. Put saved SQL under \`${queries}/<connection>/\`.

## Required Workflow (Documentation Requests)

1. **SQL query documentation:** follow \`${markdownDocPrompt}\`. Output goes in the same directory as the query with the same base name and a \`.md\` extension (e.g., \`olympic_gold.sql\` → \`olympic_gold.md\`).
2. **Schema description:** follow \`${describeSchemaPrompt}\`. Output goes to the matching bundle folder as \`${schemas}/<connection>/<schema>/description.json\`.
3. **Inline SQL comments:** follow \`${inlineCommentsPrompt}\`.

Secrets are stored in VS Code SecretStorage and are not present in these files.
${RUNQL_END}`;
}

function storageModeNote(root: RunQLStorageRoot): string {
  switch (root.location) {
    case 'user':
      return root.isCodespaces
        ? 'This workspace uses RunQL user-level storage inside GitHub Codespaces.'
        : 'This workspace uses RunQL user-level storage shared across projects.';
    case 'custom':
      return 'This workspace uses a custom RunQL storage location.';
    case 'workspace':
    default:
      return 'This workspace stores RunQL files locally under this project folder.';
  }
}

function displayForDoc(root: RunQLStorageRoot): string {
  if (root.location === 'workspace') return './RunQL';
  // Normalize to forward slashes so AGENTS.md / README_RUNQL.md and
  // the paths derived from them are consistent across Windows and
  // POSIX. Forward slashes are accepted by all Windows APIs and by
  // Node's path resolver, and this avoids readers (and tests) seeing
  // a mix of separators depending on which OS wrote the file.
  return root.displayPath.replace(/\\/g, '/');
}

function joinDisplay(base: string, sub: string): string {
  const normalizedBase = base.replace(/\\/g, '/');
  if (normalizedBase.endsWith('/')) return normalizedBase + sub;
  return `${normalizedBase}/${sub}`;
}

// -----------------------------------------------------------------------------
// README_RUNQL.md — non-destructive, storage-aware creation
// -----------------------------------------------------------------------------

/**
 * For each open workspace folder, write RunQL's `README_RUNQL.md`.
 * The file is RunQL-owned — creation, refresh on mode changes, and
 * refresh on extension version bumps all just overwrite. The write is
 * skipped when the fresh content is byte-identical to what's on disk to
 * avoid pointless file-change events for downstream watchers.
 */
export async function ensureReadmeMd(
  folders?: vscode.WorkspaceFolder[]
): Promise<void> {
  const targets = folders ?? vscode.workspace.workspaceFolders;
  if (!targets || targets.length === 0) return;

  const root = tryResolveRunQLRoot();
  if (!root) return;

  const content = readmeContent(root);

  for (const folder of targets) {
    const readmeUri = vscode.Uri.joinPath(folder.uri, 'README_RUNQL.md');
    try {
      if (await fileExists(readmeUri)) {
        const existing = new TextDecoder().decode(
          await vscode.workspace.fs.readFile(readmeUri)
        );
        if (existing === content) continue;
      }
      await vscode.workspace.fs.writeFile(readmeUri, new TextEncoder().encode(content));
    } catch (e) {
      Logger.warn(`Failed to write README_RUNQL.md at ${readmeUri.fsPath}`, e);
    }
  }
}

function readmeContent(root: RunQLStorageRoot): string {
  const displayRoot = displayForDoc(root);
  const mode = root.location === 'workspace'
    ? 'workspace-local'
    : root.location === 'user'
      ? (root.isCodespaces ? 'user-level (Codespaces)' : 'user-level')
      : 'custom';
  const gitignoreBlock = root.location === 'workspace'
    ? `Recommended \`.gitignore\` entry:

\`\`\`gitignore
RunQL/system/
\`\`\`

*Note: \`RunQL/queries/\` and \`RunQL/schemas/\` SHOULD be committed as they contain your source artifacts.*`
    : `In ${mode} mode, RunQL data lives outside this workspace. RunQL manages a small pointer here so agents can find the storage root. \`.runql-link/\` (which holds \`storage-root.json\` and \`ref.json\`) is gitignored by default because it contains a machine-local path.`;

  const agentAccessBlock = root.location === 'workspace'
    ? ''
    : `

## Agent access to RunQL data

RunQL data lives at \`${displayRoot}\`, outside this workspace folder. Whether an AI agent can *read* those files depends on how it accesses the filesystem:

- **Agents with OS-level file access** (Claude Code, Codex, most terminal-driven AI tools) can open \`${displayRoot}\` directly. The guidance in \`AGENTS.md\` and \`.runql-link/ref.json\` gives them the paths they need.
- **VS Code workspace-scoped agents** (Copilot Chat's \`@workspace\` / \`#file:\` tools, and other extensions that only see the open workspace) will read the \`AGENTS.md\` pointer but can't open files under \`${displayRoot}\` through their built-in tools.

If you use a workspace-scoped agent and need it to reach RunQL files, either:

- Add \`${displayRoot}\` as a second folder in this VS Code workspace (**File → Add Folder to Workspace…**), or
- Switch RunQL storage to *Workspace folder* mode for this project (via the Welcome page or \`RunQL: Change Storage Location\`).`;

  return `# RunQL Project

This project uses RunQL for SQL workflows and schema exploration.

Storage mode: **${mode}**

Storage root: \`${displayRoot}\`

## Setup

${gitignoreBlock}${agentAccessBlock}

## Folder Structure

- **queries/**: Saved SQL queries.
- **queries/<connection>/**: Saved SQL queries grouped by connection.
- **schemas/<connection>/manifest.json**: Lists schema bundles for a connection.
- **schemas/<connection>/<schema>/**: Per-schema schema bundle including descriptions and ERD files.
- **system/**: Generated indexes, migration backups, and prompt templates.
`;
}

// -----------------------------------------------------------------------------
// Workspace link markers (user/custom mode)
// -----------------------------------------------------------------------------

const MARKER_VERSION = '0.1';
const SUPPORTED_MARKER_VERSIONS: readonly string[] = ['0.1'];

function isSupportedMarkerVersion(version: unknown): boolean {
  return typeof version === 'string' && SUPPORTED_MARKER_VERSIONS.includes(version);
}

interface StorageRootMarker {
  version: '0.1';
  storageLocation: 'user' | 'custom' | 'workspace';
  runqlRoot: string;
  createdAt: string;
  updatedAt: string;
}

interface RunqlRefFile {
  version: '0.1';
  storageLocation: 'user' | 'custom' | 'workspace';
  runqlRoot: string;
  queriesPath: string;
  schemasPath: string;
  connectionsProfilePath: string;
  createdAt: string;
  updatedAt: string;
  secrets: string;
}

const SECRETS_NOTICE =
  'Secrets remain in VS Code SecretStorage and are not available in this file.';

/**
 * Workspace-local RunQL pointer files live under `<workspace>/.runql-link/`.
 * See specs/RunQL-Client/runql-link-consolidation.md.
 */
export const RUNQL_LINK_DIR = '.runql-link';
export const RUNQL_LINK_STORAGE_ROOT = 'storage-root.json';
export const RUNQL_LINK_REF = 'ref.json';
export const RUNQL_LINK_SKIP = 'skip.json';

/**
 * Files RunQL owns inside `.runql-link/`. The workspace-mode cleanup uses
 * this list to decide whether the folder contains only RunQL-owned files
 * (safe to delete) or has extra files (leave in place, log).
 */
export const RUNQL_LINK_OWNED_FILES: readonly string[] = [
  RUNQL_LINK_STORAGE_ROOT,
  RUNQL_LINK_REF,
  RUNQL_LINK_SKIP,
];

/**
 * Gitignore lines RunQL owns in user/custom mode. On switch to workspace
 * mode these lines are pruned; unrelated .gitignore content is preserved.
 */
export const RUNQL_GITIGNORE_ENTRIES: readonly string[] = [
  `${RUNQL_LINK_DIR}/`,
  'README_RUNQL.md',
];

function linkDirUri(workspaceFolder: vscode.WorkspaceFolder): vscode.Uri {
  return vscode.Uri.joinPath(workspaceFolder.uri, RUNQL_LINK_DIR);
}

function storageRootMarkerUri(workspaceFolder: vscode.WorkspaceFolder): vscode.Uri {
  return vscode.Uri.joinPath(linkDirUri(workspaceFolder), RUNQL_LINK_STORAGE_ROOT);
}

function runqlRefUri(workspaceFolder: vscode.WorkspaceFolder): vscode.Uri {
  return vscode.Uri.joinPath(linkDirUri(workspaceFolder), RUNQL_LINK_REF);
}

function skipMarkerUri(workspaceFolder: vscode.WorkspaceFolder): vscode.Uri {
  return vscode.Uri.joinPath(linkDirUri(workspaceFolder), RUNQL_LINK_SKIP);
}

/**
 * Ensure the workspace-local `.runql-link/` folder exists. Idempotent.
 * Call before invoking any of the marker writers when doing several in
 * a row from the same caller.
 */
export async function ensureRunqlLinkDir(
  workspaceFolder: vscode.WorkspaceFolder
): Promise<vscode.Uri> {
  const dir = linkDirUri(workspaceFolder);
  try {
    await vscode.workspace.fs.createDirectory(dir);
  } catch {
    // Directory already exists - safe to ignore
  }
  return dir;
}

/**
 * Probe both link-marker files for unsupported (newer) schema versions.
 * Callers doing a "write both storage-root.json AND ref.json" pair
 * should call this first and abort the whole write if any marker is
 * newer than what this client understands — otherwise the two files
 * can drift (e.g. storage-root.json is skipped at v0.2 but ref.json
 * is missing and gets written fresh at v0.1).
 *
 * Returns `{ ok: true }` when both files are absent or at a supported
 * version. Returns `{ ok: false, reason }` otherwise so the caller can
 * log/surface it and skip the write.
 */
export async function probeLinkMarkerVersions(
  workspaceFolder: vscode.WorkspaceFolder
): Promise<{ ok: true } | { ok: false; reason: string }> {
  for (const [uri, label] of [
    [storageRootMarkerUri(workspaceFolder), 'storage-root.json'],
    [runqlRefUri(workspaceFolder), 'ref.json'],
  ] as const) {
    if (!(await fileExists(uri))) continue;
    try {
      const existing = await readJson<{ version?: string }>(uri);
      if (existing?.version && !isSupportedMarkerVersion(existing.version)) {
        return {
          ok: false,
          reason: `${label} at ${uri.fsPath} has unsupported version ${existing.version}`,
        };
      }
    } catch {
      // Unreadable — treat as writable/new. The marker writer will
      // overwrite it.
    }
  }
  return { ok: true };
}

/**
 * Write or update `<workspace>/.runql-link/storage-root.json` — the
 * authoritative marker that a workspace folder is linked to an external
 * RunQL storage root. Preserves `createdAt` if the file already exists
 * and refuses to overwrite markers that report a newer schema version.
 * Callers must have ensured `.runql-link/` exists (see
 * `ensureRunqlLinkDir`).
 */
export async function writeStorageRootMarker(
  workspaceFolder: vscode.WorkspaceFolder,
  root: RunQLStorageRoot,
  now: string = new Date().toISOString()
): Promise<vscode.Uri> {
  const uri = storageRootMarkerUri(workspaceFolder);
  let createdAt = now;
  if (await fileExists(uri)) {
    try {
      const existing = await readJson<StorageRootMarker>(uri);
      if (existing?.version && !isSupportedMarkerVersion(existing.version)) {
        Logger.warn(
          `storage-root.json at ${uri.fsPath} has unsupported version ${existing.version}; not overwriting.`
        );
        return uri;
      }
      if (existing?.createdAt) createdAt = existing.createdAt;
    } catch {
      // Fall through - existing file unreadable, treat as new
    }
  }
  const marker: StorageRootMarker = {
    version: MARKER_VERSION,
    storageLocation: root.location,
    runqlRoot: root.displayPath,
    createdAt,
    updatedAt: now,
  };
  await writeJson(uri, marker);
  return uri;
}

/**
 * Write or update `<workspace>/.runql-link/ref.json` — the agent-readable
 * mirror. Callers should only invoke this after `writeStorageRootMarker`
 * has run (or been confirmed unchanged) for the same folder, and must
 * have ensured `.runql-link/` exists.
 */
export async function writeRunqlRef(
  workspaceFolder: vscode.WorkspaceFolder,
  root: RunQLStorageRoot,
  now: string = new Date().toISOString()
): Promise<vscode.Uri> {
  const uri = runqlRefUri(workspaceFolder);
  let createdAt = now;
  if (await fileExists(uri)) {
    try {
      const existing = await readJson<RunqlRefFile>(uri);
      if (existing?.version && !isSupportedMarkerVersion(existing.version)) {
        Logger.warn(
          `ref.json at ${uri.fsPath} has unsupported version ${existing.version}; not overwriting.`
        );
        return uri;
      }
      if (existing?.createdAt) createdAt = existing.createdAt;
    } catch {
      // Fall through
    }
  }
  const displayRoot = root.location === 'workspace'
    ? './RunQL'
    : root.displayPath;
  const ref: RunqlRefFile = {
    version: MARKER_VERSION,
    storageLocation: root.location,
    runqlRoot: displayRoot,
    queriesPath: joinDisplay(displayRoot, 'queries'),
    schemasPath: joinDisplay(displayRoot, 'schemas'),
    connectionsProfilePath: joinDisplay(displayRoot, 'system/connections.json'),
    createdAt,
    updatedAt: now,
    secrets: SECRETS_NOTICE,
  };
  await writeJson(uri, ref);
  return uri;
}

/**
 * Ensure the workspace `.gitignore` contains RunQL machine-local marker
 * entries in user/custom mode. Appends only missing entries; never
 * ignores AGENTS.md.
 */
export async function ensureRunqlGitignoreEntries(
  workspaceFolder: vscode.WorkspaceFolder
): Promise<void> {
  const gitignoreUri = vscode.Uri.joinPath(workspaceFolder.uri, '.gitignore');
  let existing = '';
  if (await fileExists(gitignoreUri)) {
    try {
      existing = new TextDecoder().decode(await vscode.workspace.fs.readFile(gitignoreUri));
    } catch {
      existing = '';
    }
  }
  const lines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = RUNQL_GITIGNORE_ENTRIES.filter((e) => !lines.has(e));
  if (missing.length === 0) return;
  // Layout rules:
  //   - Fresh (empty) file: no leading blank line; header + entries + trailing newline.
  //   - Existing file without trailing newline: append `\n` first so the
  //     header doesn't run into the previous line.
  //   - Existing file with trailing newline: add one blank line separator.
  const header = '# RunQL machine-local markers';
  const body = `${header}\n${missing.join('\n')}\n`;
  let output: string;
  if (existing.length === 0) {
    output = body;
  } else if (existing.endsWith('\n')) {
    output = `${existing}\n${body}`;
  } else {
    output = `${existing}\n\n${body}`;
  }
  const bytes = new TextEncoder().encode(output);
  try {
    await vscode.workspace.fs.writeFile(gitignoreUri, bytes);
  } catch (e) {
    Logger.warn(`Failed to update .gitignore at ${gitignoreUri.fsPath}`, e);
  }
}

/**
 * Prune RunQL-owned entries from the workspace `.gitignore`. Preserves
 * unrelated content and drops the "# RunQL machine-local markers"
 * header comment when RunQL added it. Called on switch to workspace
 * mode.
 */
export async function pruneRunqlGitignoreEntries(
  workspaceFolder: vscode.WorkspaceFolder
): Promise<void> {
  const gitignoreUri = vscode.Uri.joinPath(workspaceFolder.uri, '.gitignore');
  if (!(await fileExists(gitignoreUri))) return;
  let existing = '';
  try {
    existing = new TextDecoder().decode(await vscode.workspace.fs.readFile(gitignoreUri));
  } catch {
    return;
  }
  const ownedSet = new Set<string>(RUNQL_GITIGNORE_ENTRIES);
  const HEADER = '# RunQL machine-local markers';
  let removedOwned = false;
  const lines = existing.split(/\r?\n/);
  // First pass: drop RunQL-owned entries and remember whether we removed any.
  const afterEntries = lines.filter((raw) => {
    const trimmed = raw.trim();
    if (ownedSet.has(trimmed)) {
      removedOwned = true;
      return false;
    }
    return true;
  });
  // Second pass: only strip the header when we actually removed RunQL entries
  // (otherwise a user's coincidental identical comment survives).
  const filtered = removedOwned
    ? afterEntries.filter((raw) => raw.trim() !== HEADER)
    : afterEntries;
  // Collapse runs of >2 blank lines that the removals may have introduced.
  const collapsed: string[] = [];
  for (const line of filtered) {
    const isBlank = line.trim().length === 0;
    const prevBlank = collapsed.length > 0 && collapsed[collapsed.length - 1].trim().length === 0;
    if (isBlank && prevBlank) continue;
    collapsed.push(line);
  }
  // Preserve a trailing newline if the original had one.
  const originalTrailing = existing.endsWith('\n');
  let out = collapsed.join('\n');
  if (originalTrailing && !out.endsWith('\n')) out += '\n';
  if (!originalTrailing && out.endsWith('\n')) out = out.slice(0, -1);
  if (out === existing) return;
  try {
    await vscode.workspace.fs.writeFile(gitignoreUri, new TextEncoder().encode(out));
  } catch (e) {
    Logger.warn(`Failed to prune .gitignore at ${gitignoreUri.fsPath}`, e);
  }
}

/**
 * Delete the `skip.json` marker for the given workspace folder (called
 * when a previously skipped folder is initialized).
 */
export async function clearStorageLinkSkipMarker(
  workspaceFolder: vscode.WorkspaceFolder
): Promise<void> {
  try {
    await vscode.workspace.fs.delete(skipMarkerUri(workspaceFolder));
  } catch {
    // Not present - nothing to do
  }
}

/**
 * Delete the entire `<workspace>/.runql-link/` folder for the given
 * workspace folder. Refuses to delete if the folder contains files RunQL
 * doesn't own — those are surfaced as a warning and the folder is left
 * in place. Returns true iff the folder was deleted (or was already
 * absent).
 */
export async function removeRunqlLinkFolder(
  workspaceFolder: vscode.WorkspaceFolder
): Promise<boolean> {
  const dir = linkDirUri(workspaceFolder);
  if (!(await fileExists(dir))) return true;
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return false;
  }
  const owned = new Set(RUNQL_LINK_OWNED_FILES);
  const unexpected = entries.filter(([name]) => !owned.has(name));
  if (unexpected.length > 0) {
    Logger.warn(
      `Not deleting ${dir.fsPath}: contains unexpected files (${unexpected.map((e) => e[0]).join(', ')}).`
    );
    return false;
  }
  try {
    await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false });
    return true;
  } catch (e) {
    Logger.warn(`Failed to delete ${dir.fsPath}`, e);
    return false;
  }
}

export { RUNQL_BEGIN, RUNQL_END };

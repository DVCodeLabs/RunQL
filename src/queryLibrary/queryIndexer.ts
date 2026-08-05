import * as vscode from "vscode";
import { canonicalizeSql } from "../core/hashing";
import { ensureDPDirs, writeJson } from "../core/fsWorkspace";
import { isPathUnderRunqlRoot, makeStoredPath, tryResolveRunQLRoot } from "../core/storageRoot";

export interface QueryIndexFile {
  version: "0.1";
  generatedAt: string;
  queries: QueryIndexEntry[];
}

export interface QueryIndexEntry {
  path: string;       // workspace-relative
  docPath?: string;   // companion markdown relative path
  title?: string;     // first comment line if present
  sqlHash: string;
  tables?: string[];  // optional best-effort later
  createdAt: string;  // ISO - when the query was first indexed
  updatedAt: string;  // ISO - when the query was last modified
  connectionId?: string | null;
  connectionName?: string | null;
  dialect?: string | null;
  schemaContext?: string | null;
  catalogContext?: string | null;
  lastRunAt?: string | null;

  // Search metadata (derived from companion markdown)
  mdTitle?: string;
  mdTags?: string[];
  mdSummary?: string;          // first meaningful paragraph/line from notes
  mdBodyText?: string;         // plain text, normalized
  searchText?: string;         // concatenated normalized field for fast contains match
  searchUpdatedAt?: string;    // last time search fields were derived
}

// Excludes only known-parent RunQL system folders. Do NOT include a bare
// `system` here — that would match any user folder called `system`
// anywhere in the workspace (`apps/system/queries/*.sql`, etc.) and
// silently drop those files from the index. Custom-path storage roots
// inside the workspace are handled by the runtime filter below, not by
// this glob.
const EXCLUDE_GLOB =
  "**/{node_modules,dist,out,.git,RunQL/system,.runql/system}/**";

export async function rebuildQueryIndex(): Promise<void> {
  const dpDir = await ensureDPDirs();
  const indexUri = vscode.Uri.joinPath(dpDir, "system", "queries", "queryIndex.json");

  // Post-filter: `findFiles` above can't know where a custom-path
  // storage root is, so drop anything that falls under the resolved
  // RunQL root's `system/` at runtime.
  const runqlRoot = tryResolveRunQLRoot();
  const runqlSystemPath = runqlRoot
    ? runqlRoot.uri.path.replace(/\/$/, '') + '/system'
    : undefined;
  const rawFiles = await vscode.workspace.findFiles("**/*.sql", EXCLUDE_GLOB);
  const sqlFiles = runqlSystemPath
    ? rawFiles.filter((uri) => {
        const p = uri.path;
        return p !== runqlSystemPath && !p.startsWith(runqlSystemPath + '/');
      })
    : rawFiles;
  void isPathUnderRunqlRoot; // reserved for future callers

  const entries: QueryIndexEntry[] = [];

  for (const file of sqlFiles) {
    const doc = await vscode.workspace.openTextDocument(file);
    const text = doc.getText();
    const { sqlHash } = canonicalizeSql(text);
    const title = extractTitle(text);

    const wsRelative = makeStoredPath(file);
    const stat = await vscode.workspace.fs.stat(file);

    // Check for companion markdown
    let docPath: string | undefined;
    let connectionId: string | undefined;
    const mdPath = file.path.replace(/\.sql$/i, '.md');
    try {
      const mdUri = file.with({ path: mdPath });
      const mdStat = await vscode.workspace.fs.stat(mdUri);
      if (mdStat) {
        docPath = wsRelative.replace(/\.sql$/i, '.md');
        // Read connection ID from frontmatter
        const mdBytes = await vscode.workspace.fs.readFile(mdUri);
        const mdContent = Buffer.from(mdBytes).toString('utf8');
        const match = mdContent.match(/^connection_id:\s*"?(.*?)"?$/m);
        if (match) {
          connectionId = match[1];
        } else {
          // Fallback: try to resolve connection name? (Too risky without index)
          // Just leave undefined, user will select manually.
        }
      }
    } catch {
      // No companion doc
    }

    entries.push({
      path: wsRelative,
      docPath,
      title,
      sqlHash,
      createdAt: new Date(stat.ctime).toISOString(),
      updatedAt: new Date(stat.mtime).toISOString(),
      connectionId
    });
  }

  const index: QueryIndexFile = {
    version: "0.1",
    generatedAt: new Date().toISOString(),
    queries: entries
  };

  await writeJson(indexUri, index);
}

function extractTitle(sql: string): string | undefined {
  // Title heuristic: first non-empty line that is a comment
  const lines = sql.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("--")) return line.replace(/^--\s?/, "").trim() || undefined;
    if (line.startsWith("/*")) return undefined; // keep v0 simple
    return undefined;
  }
  return undefined;
}

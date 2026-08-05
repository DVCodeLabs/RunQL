import * as vscode from 'vscode';
import { canonicalizeSql } from '../core/hashing';
import { ensureDPDirs, readJson, writeJson, fileExists } from '../core/fsWorkspace';
import {
    isPathUnderRunqlRoot,
    makeStoredPath,
    normalizeStoredPath,
    onDidChangeStorageRoot,
    resolveStoredPath,
    tryResolveRunQLRoot,
} from '../core/storageRoot';
import { QueryIndexEntry, QueryIndexFile } from './queryIndexer';
import { parseMdMetadata, buildSearchText } from './mdParser';
import { Logger } from '../core/logger';

/**
 * Canonical map key for a URI: storage-root-relative when under the
 * resolved RunQL root, otherwise workspace-relative (for general SQL
 * files opened outside RunQL/).
 */
function keyForUri(uri: vscode.Uri): string {
  return makeStoredPath(uri);
}

export { QueryIndexEntry }; // Re-export for convenience

export class QueryIndex {
    // Map hash -> list of locations
    private index = new Map<string, QueryIndexEntry[]>();

    // Map path -> entry (PRIMARY lookup for persistence)
    private pathIndex = new Map<string, QueryIndexEntry>();

    private initialized = false;
    private persistencePending = false;
    private storageRootWatchers: vscode.Disposable | undefined;
    private storageRootSubscription: vscode.Disposable | undefined;

    // Event emitter for search index changes
    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    constructor() { }

    async initialize() {
        if (this.initialized) return;

        // 1. Load existing JSON
        await this.loadFromDisk();

        // 2. Find all SQL files to sync/add new ones — workspace scope AND
        //    the resolved storage root when it lives outside the workspace
        //    (user/custom mode).
        const workspaceFiles = await vscode.workspace.findFiles(
            '**/*.{sql,postgres}',
            '**/node_modules/**'
        );
        for (const file of workspaceFiles) {
            await this.updateFile(file, true);
        }
        await this.scanStorageRootFiles();

        // 3. Watch for SQL/markdown changes in the workspace…
        const watcher = vscode.workspace.createFileSystemWatcher('**/*.{sql,postgres}');
        watcher.onDidChange(uri => { this.updateFile(uri); });
        watcher.onDidCreate(uri => { this.updateFile(uri); });
        watcher.onDidDelete(uri => { this.removeFile(uri); });

        const mdWatcher = vscode.workspace.createFileSystemWatcher('**/*.md');
        mdWatcher.onDidChange(uri => { this.handleMdChange(uri); });
        mdWatcher.onDidCreate(uri => { this.handleMdChange(uri); });
        mdWatcher.onDidDelete(uri => { this.handleMdDelete(uri); });

        // …plus a second set of watchers rooted at the storage root, so
        // files under `~/.runql/queries/` (user/custom mode) also flow
        // through the index.
        this.storageRootWatchers = this.createStorageRootWatchers();
        // Retain the subscription's Disposable so tests / any code path
        // that re-invokes initialize() can dispose it before stacking a
        // second handler (each handler kicks off its own scan+persist
        // and they race on queryIndex.json). Production hits the
        // `if (this.initialized) return` guard so this is defensive
        // rather than load-bearing.
        this.storageRootSubscription?.dispose();
        this.storageRootSubscription = onDidChangeStorageRoot(async ({ next }) => {
            this.storageRootWatchers?.dispose();
            this.storageRootWatchers = this.createStorageRootWatchers(next?.uri);
            // Re-scan under the new root so saves made in another window
            // (or via CLI) show up without waiting on a create event.
            // Migration flows do their file copy BEFORE the setting
            // change, so by the time this handler runs, files at the new
            // root are in place and the scan reflects reality.
            await this.scanStorageRootFiles();
            await this.persist();
        });

        this.initialized = true;

        // Initial persist to cleanup stale entries or add new ones
        await this.persist();
    }

    private createStorageRootWatchers(
        rootUri?: vscode.Uri
    ): vscode.Disposable | undefined {
        const uri = rootUri ?? tryResolveRunQLRoot()?.uri;
        if (!uri || uri.scheme !== 'file') return undefined;
        // Skip when the storage root lives inside the workspace: the
        // workspace-wide watchers above already cover it, and adding a
        // second overlapping RelativePattern watcher fires duplicate
        // events.
        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        const rootPath = uri.path.replace(/\/$/, '');
        for (const f of workspaceFolders) {
            const fp = f.uri.path.replace(/\/$/, '');
            if (rootPath === fp || rootPath.startsWith(`${fp}/`)) {
                return undefined;
            }
        }
        const subs: vscode.Disposable[] = [];
        const sqlPattern = new vscode.RelativePattern(uri, 'queries/**/*.{sql,postgres}');
        const sqlWatcher = vscode.workspace.createFileSystemWatcher(sqlPattern);
        subs.push(sqlWatcher);
        subs.push(sqlWatcher.onDidChange((u) => { this.updateFile(u); }));
        subs.push(sqlWatcher.onDidCreate((u) => { this.updateFile(u); }));
        subs.push(sqlWatcher.onDidDelete((u) => { this.removeFile(u); }));
        const mdPattern = new vscode.RelativePattern(uri, 'queries/**/*.md');
        const mdWatcher = vscode.workspace.createFileSystemWatcher(mdPattern);
        subs.push(mdWatcher);
        subs.push(mdWatcher.onDidChange((u) => { this.handleMdChange(u); }));
        subs.push(mdWatcher.onDidCreate((u) => { this.handleMdChange(u); }));
        subs.push(mdWatcher.onDidDelete((u) => { this.handleMdDelete(u); }));
        return { dispose: () => subs.forEach((s) => s.dispose()) };
    }

    private async scanStorageRootFiles(): Promise<void> {
        const root = tryResolveRunQLRoot();
        if (!root || root.uri.scheme !== 'file') return;
        // If the storage root is inside the workspace, findFiles above
        // already covered it.
        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        const rootPath = root.uri.path.replace(/\/$/, '');
        for (const f of workspaceFolders) {
            const fp = f.uri.path.replace(/\/$/, '');
            if (rootPath === fp || rootPath.startsWith(`${fp}/`)) return;
        }
        const files = await vscode.workspace.findFiles(
            new vscode.RelativePattern(root.uri, 'queries/**/*.{sql,postgres}')
        );
        for (const file of files) {
            await this.updateFile(file, true);
        }
        // Best-effort: remove index entries for files that no longer
        // exist under the storage root.
        const stale: string[] = [];
        for (const [key, entry] of this.pathIndex.entries()) {
            const uri = resolveStoredPath(entry.path);
            if (!uri) continue;
            if (!isPathUnderRunqlRoot(uri, root)) continue;
            if (!(await fileExists(uri))) stale.push(key);
        }
        for (const key of stale) this.pathIndex.delete(key);
    }

    private async loadFromDisk() {
        const dpDir = await ensureDPDirs();
        const indexUri = vscode.Uri.joinPath(dpDir, "system", "queries", "queryIndex.json");

        if (await fileExists(indexUri)) {
            try {
                const data = await readJson<QueryIndexFile>(indexUri);
                if (data && data.queries) {
                    for (const q of data.queries) {
                        // Legacy entries used workspace-relative paths like
                        // `RunQL/queries/…`. Normalize to storage-root-relative
                        // on load so lookups match new writes.
                        q.path = normalizeStoredPath(q.path);
                        if (q.docPath) q.docPath = normalizeStoredPath(q.docPath);
                        this.pathIndex.set(q.path, q);
                        if (!this.index.has(q.sqlHash)) {
                            this.index.set(q.sqlHash, []);
                        }
                        this.index.get(q.sqlHash)?.push(q);
                    }
                }
            } catch (e) {
                Logger.error("[QueryIndex] Failed to load queryIndex.json", e);
            }
        }
    }

    private async persist() {
        if (this.persistencePending) return;
        this.persistencePending = true;

        // Debounce slightly
        setTimeout(async () => {
            try {
                const dpDir = await ensureDPDirs();
                const indexUri = vscode.Uri.joinPath(dpDir, "system", "queries", "queryIndex.json");

                // Reload the latest queryIndex.json from disk and merge
                // with our in-memory state so a concurrent write from
                // another VS Code window (sharing the same user/custom
                // storage root) doesn't get clobbered. Union by
                // storage-root-relative path; on collision keep the
                // record with the newer `updatedAt`.
                let onDisk: QueryIndexEntry[] = [];
                if (await fileExists(indexUri)) {
                    try {
                        const data = await readJson<QueryIndexFile>(indexUri);
                        onDisk = data?.queries ?? [];
                    } catch {
                        onDisk = [];
                    }
                }
                const byPath = new Map<string, QueryIndexEntry>();
                for (const e of onDisk) {
                    if (!e || !e.path) continue;
                    e.path = normalizeStoredPath(e.path);
                    if (e.docPath) e.docPath = normalizeStoredPath(e.docPath);
                    byPath.set(e.path, e);
                }
                for (const e of this.pathIndex.values()) {
                    if (!e || !e.path) continue;
                    const existing = byPath.get(e.path);
                    if (!existing) {
                        byPath.set(e.path, e);
                        continue;
                    }
                    // Same path in both: prefer the record with the
                    // later `updatedAt`. Fall back to our in-memory
                    // record if timestamps are equal or unparseable.
                    const ourTs = Date.parse(e.updatedAt ?? '');
                    const diskTs = Date.parse(existing.updatedAt ?? '');
                    if (Number.isFinite(diskTs) && Number.isFinite(ourTs) && diskTs > ourTs) {
                        byPath.set(e.path, existing);
                    } else {
                        byPath.set(e.path, e);
                    }
                }

                const entries = Array.from(byPath.values())
                    .sort((a, b) => a.path.localeCompare(b.path))
                    .map(e => ({
                        connectionId: e.connectionId,
                        connectionName: e.connectionName,
                        createdAt: e.createdAt,
                        dialect: e.dialect,
                        docPath: e.docPath,
                        lastRunAt: e.lastRunAt,
                        mdBodyText: e.mdBodyText,
                        mdSummary: e.mdSummary,
                        mdTags: e.mdTags,
                        mdTitle: e.mdTitle,
                        path: e.path,
                        catalogContext: e.catalogContext,
                        searchText: e.searchText,
                        searchUpdatedAt: e.searchUpdatedAt,
                        schemaContext: e.schemaContext,
                        sqlHash: e.sqlHash,
                        title: e.title,
                        updatedAt: e.updatedAt
                    }));

                const file: QueryIndexFile = {
                    version: "0.1",
                    generatedAt: new Date().toISOString(),
                    queries: entries
                };

                await writeJson(indexUri, file);
                this.persistencePending = false;
                this._onDidChange.fire();
            } catch (e) {
                Logger.error("[QueryIndex] Failed to save queryIndex.json", e);
                this.persistencePending = false;
            }
        }, 500);
    }

    private isTracked(uri: vscode.Uri): boolean {
        // Only track file scheme
        if (uri.scheme !== 'file') return false;

        const path = uri.path.toLowerCase();
        return path.endsWith('.sql') || path.endsWith('.postgres');
    }

    async updateFile(uri: vscode.Uri, skipSave = false) {
        if (!this.isTracked(uri)) return;

        try {
            const document = await vscode.workspace.openTextDocument(uri);
            const text = document.getText();
            const { sqlHash } = canonicalizeSql(text);
            const wsRelative = keyForUri(uri);
            const title = this.extractTitle(text);



            // Check for companion md and extract search metadata
            let docPath: string | undefined;
            let mdMeta: ReturnType<typeof parseMdMetadata> | undefined;
            try {
                const mdUri = uri.with({ path: uri.path.replace(/\.sql$/i, '.md') });
                try {
                    await vscode.workspace.fs.stat(mdUri);
                    docPath = keyForUri(mdUri);
                    // Read and parse markdown for search metadata
                    const mdBytes = await vscode.workspace.fs.readFile(mdUri);
                    const mdContent = Buffer.from(mdBytes).toString('utf8');
                    mdMeta = parseMdMetadata(mdContent);
                } catch {
                    // No markdown file
                }
            } catch (_e) {
                // ignore
            }

            let entry = this.pathIndex.get(wsRelative);

            // Get stats for timestamps
            let createdAt = new Date().toISOString(); // fallback
            let updatedAt = new Date().toISOString();
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                createdAt = new Date(stat.ctime).toISOString();
                updatedAt = new Date(stat.mtime).toISOString();
            } catch { }

            if (entry) {
                // Update existing
                entry.sqlHash = sqlHash;
                entry.updatedAt = updatedAt;
                entry.title = title;
                entry.docPath = docPath;
            } else {
                // New entry
                entry = {
                    path: wsRelative,
                    sqlHash,
                    createdAt: createdAt,
                    updatedAt: updatedAt,
                    title,
                    docPath
                };
                this.pathIndex.set(wsRelative, entry);
            }

            // Apply markdown metadata if available
            if (mdMeta) {
                entry.mdTitle = mdMeta.title;
                entry.mdTags = mdMeta.tags;
                entry.mdSummary = mdMeta.summary;
                entry.mdBodyText = mdMeta.bodyText;
                if (mdMeta.connectionId) entry.connectionId = mdMeta.connectionId;
                if (mdMeta.connectionName) entry.connectionName = mdMeta.connectionName;
                if (mdMeta.dialect) entry.dialect = mdMeta.dialect;
                entry.schemaContext = mdMeta.schemaContext ?? null;
                entry.catalogContext = mdMeta.catalogContext ?? null;
            } else {
                entry.mdTitle = undefined;
                entry.mdTags = undefined;
                entry.mdSummary = undefined;
                entry.mdBodyText = undefined;
                entry.schemaContext = null;
                entry.catalogContext = null;
            }

            // Build searchText
            entry.searchText = buildSearchText({
                title: entry.title,
                mdTitle: entry.mdTitle,
                mdTags: entry.mdTags,
                mdBodyText: entry.mdBodyText,
                path: entry.path,
                connectionName: entry.connectionName ?? undefined,
                dialect: entry.dialect ?? undefined,
                sqlText: text,
            });
            entry.searchUpdatedAt = new Date().toISOString();

            this.rebuildHashIndex();

            if (!skipSave) await this.persist();

        } catch (e) {
            Logger.error(`[QueryIndex] Failed to update ${uri.toString()}`, e);
        }
    }

    /**
     * Handle companion markdown file change — find associated SQL entry and update search fields.
     */
    private async handleMdChange(mdUri: vscode.Uri) {
        if (mdUri.scheme !== 'file') return;
        // Find the associated SQL file path
        const sqlPath = mdUri.path.replace(/\.md$/i, '.sql');
        const sqlUri = mdUri.with({ path: sqlPath });

        // Check if we track a SQL file with this companion
        const wsRelative = keyForUri(sqlUri);
        const entry = this.pathIndex.get(wsRelative);
        if (!entry) return;

        // Re-parse the markdown and update entry
        try {
            const mdBytes = await vscode.workspace.fs.readFile(mdUri);
            const mdContent = Buffer.from(mdBytes).toString('utf8');
            const mdMeta = parseMdMetadata(mdContent);

            entry.docPath = keyForUri(mdUri);
            entry.mdTitle = mdMeta.title;
            entry.mdTags = mdMeta.tags;
            entry.mdSummary = mdMeta.summary;
            entry.mdBodyText = mdMeta.bodyText;
            if (mdMeta.connectionId) entry.connectionId = mdMeta.connectionId;
            if (mdMeta.connectionName) entry.connectionName = mdMeta.connectionName;
            if (mdMeta.dialect) entry.dialect = mdMeta.dialect;
            entry.schemaContext = mdMeta.schemaContext ?? null;
            entry.catalogContext = mdMeta.catalogContext ?? null;

            // Re-read SQL text for searchText rebuild
            let sqlText = '';
            try {
                const sqlBytes = await vscode.workspace.fs.readFile(sqlUri);
                sqlText = Buffer.from(sqlBytes).toString('utf8');
            } catch { }

            entry.searchText = buildSearchText({
                title: entry.title,
                mdTitle: entry.mdTitle,
                mdTags: entry.mdTags,
                mdBodyText: entry.mdBodyText,
                path: entry.path,
                connectionName: entry.connectionName ?? undefined,
                dialect: entry.dialect ?? undefined,
                sqlText,
            });
            entry.searchUpdatedAt = new Date().toISOString();

            await this.persist();
        } catch (e) {
            Logger.error(`[QueryIndex] Failed to update md metadata for ${mdUri.toString()}`, e);
        }
    }

    /**
     * Handle companion markdown file deletion — clear search metadata from associated entry.
     */
    private handleMdDelete(mdUri: vscode.Uri) {
        if (mdUri.scheme !== 'file') return;
        const sqlPath = mdUri.path.replace(/\.md$/i, '.sql');
        const sqlUri = mdUri.with({ path: sqlPath });

        const wsRelative = keyForUri(sqlUri);
        const entry = this.pathIndex.get(wsRelative);
        if (!entry) return;

        entry.docPath = undefined;
        entry.mdTitle = undefined;
        entry.mdTags = undefined;
        entry.mdSummary = undefined;
        entry.mdBodyText = undefined;
        entry.schemaContext = null;
        entry.catalogContext = null;
        // Rebuild searchText without md fields
        entry.searchText = buildSearchText({
            title: entry.title,
            path: entry.path,
            connectionName: entry.connectionName ?? undefined,
            dialect: entry.dialect ?? undefined,
        });
        entry.searchUpdatedAt = new Date().toISOString();

        this.persist();
    }

    private extractTitle(sql: string): string | undefined {
        const lines = sql.split(/\r?\n/);
        for (const raw of lines) {
            const line = raw.trim();
            if (!line) continue;
            if (line.startsWith("--")) return line.replace(/^--\s?/, "").trim() || undefined;
            if (line.startsWith("/*")) return undefined;
            return undefined;
        }
        return undefined;
    }

    async handleRename(oldUri: vscode.Uri, newUri: vscode.Uri) {
        const oldRel = keyForUri(oldUri);
        const newRel = keyForUri(newUri);

        // If new extension is not supported, treat as deletion
        if (!newRel.endsWith('.sql') && !newRel.endsWith('.postgres')) {
            this.removeFile(oldUri);
            return;
        }



        const entry = this.pathIndex.get(oldRel);
        if (entry) {
            // Update path
            entry.path = newRel;
            if (entry.docPath) {
                const oldMd = oldRel.replace(/\.sql$/i, '.md');
                // Only update docPath if it matched the old pattern
                if (entry.docPath === oldMd) {
                    entry.docPath = newRel.replace(/\.sql$/i, '.md');
                }
            }
            entry.updatedAt = new Date().toISOString();

            // Move in map
            this.pathIndex.delete(oldRel);
            this.pathIndex.set(newRel, entry);

            // Rebuild hash index (could be optimized)
            this.rebuildHashIndex();
            await this.persist();
        } else {
            Logger.warn(`[QueryIndex] Rename source not found in index: ${oldRel}. Treating as new file.`);
            await this.updateFile(newUri);
        }
    }

    async handleConnectionFolderRename(oldFolder: vscode.Uri, newFolder: vscode.Uri, newName: string) {
        const oldRel = keyForUri(oldFolder).replace(/\\/g, '/');
        const newRel = keyForUri(newFolder).replace(/\\/g, '/');
        const entries = Array.from(this.pathIndex.entries());
        let changed = false;

        for (const [pathKey, entry] of entries) {
            if (!entry.path.startsWith(`${oldRel}/`)) continue;

            const nextPath = `${newRel}/${entry.path.slice(oldRel.length + 1)}`;
            const previousConnectionName = entry.connectionName;

            entry.path = nextPath;
            if (entry.docPath?.startsWith(`${oldRel}/`)) {
                entry.docPath = `${newRel}/${entry.docPath.slice(oldRel.length + 1)}`;
            }
            entry.connectionName = newName;
            entry.updatedAt = new Date().toISOString();
            entry.searchText = buildSearchText({
                title: entry.title,
                mdTitle: entry.mdTitle,
                mdTags: entry.mdTags,
                mdBodyText: entry.mdBodyText,
                path: entry.path,
                connectionName: entry.connectionName ?? undefined,
                dialect: entry.dialect ?? undefined,
            });
            entry.searchUpdatedAt = new Date().toISOString();

            if (pathKey !== nextPath) {
                this.pathIndex.delete(pathKey);
                this.pathIndex.set(nextPath, entry);
            }
            changed = changed || pathKey !== nextPath || previousConnectionName !== newName;
        }

        if (changed) {
            this.rebuildHashIndex();
            await this.persist();
        }
    }

    removeFile(uri: vscode.Uri) {
        const wsRelative = keyForUri(uri);
        if (this.pathIndex.delete(wsRelative)) {
            this.rebuildHashIndex();
            this.persist();
        }
    }

    // Updates metadata when connection changes
    async updateConnectionContext(uri: vscode.Uri, connId: string | null, connName: string | null, dialect: string | null) {
        if (!this.isTracked(uri)) return;

        const wsRelative = keyForUri(uri);
        const entry = this.pathIndex.get(wsRelative);

        if (entry) {
            entry.connectionId = connId;
            entry.connectionName = connName;
            entry.dialect = dialect;
            entry.updatedAt = new Date().toISOString();
            await this.persist();

        } else {
            // Should exist if file is open, but if not, force update?
            await this.updateFile(uri, true);
            // recursive retry once?
            const retry = this.pathIndex.get(wsRelative);
            if (retry) {
                retry.connectionId = connId;
                retry.connectionName = connName;
                retry.dialect = dialect;
                await this.persist();
            }
        }
    }

    async updateLastRun(uri: vscode.Uri) {
        if (!this.isTracked(uri)) return;

        const wsRelative = keyForUri(uri);
        let entry = this.pathIndex.get(wsRelative);

        if (!entry) {
            // Ensure it exists
            await this.updateFile(uri, true);
            entry = this.pathIndex.get(wsRelative);
        }

        if (entry) {
            entry.lastRunAt = new Date().toISOString();
            await this.persist();
        }
    }

    getEntry(uri: vscode.Uri): QueryIndexEntry | undefined {
        const wsRelative = keyForUri(uri);
        return this.pathIndex.get(wsRelative);
    }

    /**
     * Returns all index entries (for search).
     */
    getAllEntries(): QueryIndexEntry[] {
        return Array.from(this.pathIndex.values());
    }

    /**
     * Force rebuild search metadata for all entries.
     */
    async rebuildSearchMetadata(): Promise<void> {
        const entries = this.getAllEntries();
        for (const entry of entries) {
            const sqlUri = resolveStoredPath(entry.path);
            if (!sqlUri) continue;
            await this.updateFile(sqlUri, true);
        }
        await this.persist();
    }

    private rebuildHashIndex() {
        this.index.clear();
        for (const entry of this.pathIndex.values()) {
            if (!this.index.has(entry.sqlHash)) {
                this.index.set(entry.sqlHash, []);
            }
            this.index.get(entry.sqlHash)?.push(entry);
        }
    }

    /**
     * Returns all entries matching the given hash
     */
    getMatches(hash: string): QueryIndexEntry[] {
        return this.index.get(hash) || [];
    }
}

export const queryIndex = new QueryIndex();

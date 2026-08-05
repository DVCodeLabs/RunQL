
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { Logger } from '../core/logger';
import { fileExists, readJson, writeJson } from '../core/fsWorkspace';

export interface HistoryEntry {
    id: string;
    query: string;
    timestamp: number;
    connectionName: string;
    schemaName?: string;
    connectionId?: string;
    rows?: number;
    status?: 'success' | 'error';
    duration?: number;
}

export class HistoryService {
    private static instance: HistoryService;
    private readonly STORAGE_FILE = 'queryHistory.json';
    private _history: HistoryEntry[] = [];
    private _storageUri: vscode.Uri | undefined;

    private constructor() { }

    public static getInstance(): HistoryService {
        if (!HistoryService.instance) {
            HistoryService.instance = new HistoryService();
        }
        return HistoryService.instance;
    }

    public async initialize(_context?: vscode.ExtensionContext) {
        const { isProjectInitialized } = require('../core/isProjectInitialized');
        if (!(await isProjectInitialized())) {
            return;
        }

        const { ensureDPDirs } = require('../core/fsWorkspace');
        try {
            const dpDir: vscode.Uri = await ensureDPDirs();
            this._storageUri = vscode.Uri.joinPath(
                dpDir,
                'system',
                'queries',
                this.STORAGE_FILE
            );
            const systemDir = vscode.Uri.joinPath(dpDir, 'system', 'queries');
            try {
                await vscode.workspace.fs.createDirectory(systemDir);
            } catch {
                // Directory already exists - safe to ignore
            }
            await this.loadHistory();
        } catch (e) {
            Logger.error('RunQL: Failed to initialize history storage', e);
        }
    }

    private async loadHistory(): Promise<void> {
        if (!this._storageUri) return;
        if (!(await fileExists(this._storageUri))) {
            this._history = [];
            return;
        }
        try {
            const parsed = await readJson<unknown>(this._storageUri);
            // Guard against truncated / corrupt files. If the on-disk
            // JSON is `{}`, `null`, or otherwise not an array,
            // `unshift`/`for..of` on `_history` would throw and history
            // would silently stop recording for the whole session.
            this._history = Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
        } catch (e) {
            Logger.error('RunQL: Failed to load query history', e);
            this._history = [];
        }
    }

    /**
     * Reload the latest history from disk and merge it with our in-memory
     * copy so a concurrent write from another window doesn't lose entries.
     * Union by id; on collision, keep the version with the later timestamp.
     */
    private async saveHistory(): Promise<void> {
        if (!this._storageUri) return;
        try {
            let onDisk: HistoryEntry[] = [];
            if (await fileExists(this._storageUri)) {
                try {
                    const parsed = await readJson<unknown>(this._storageUri);
                    onDisk = Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
                } catch {
                    onDisk = [];
                }
            }
            const byId = new Map<string, HistoryEntry>();
            for (const e of onDisk) if (e && e.id) byId.set(e.id, e);
            for (const e of this._history) {
                if (!e || !e.id) continue;
                const existing = byId.get(e.id);
                if (!existing || (e.timestamp ?? 0) >= (existing.timestamp ?? 0)) {
                    byId.set(e.id, e);
                }
            }
            const merged = Array.from(byId.values())
                .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
            this._history = merged;
            this.pruneOldEntries();
            await writeJson(this._storageUri, this._history);
        } catch (e) {
            Logger.error('RunQL: Failed to save query history', e);
        }
    }

    public async addEntry(entry: Omit<HistoryEntry, 'id' | 'timestamp'>): Promise<void> {
        const newEntry: HistoryEntry = {
            id: this.generateId(),
            timestamp: Date.now(),
            ...entry,
        };

        this._history.unshift(newEntry);
        await this.saveHistory();

        vscode.commands.executeCommand('runql.memoryRecall.refresh');
    }

    public getEntries(): HistoryEntry[] {
        return this._history;
    }

    public async updateConnectionName(
        connectionId: string,
        oldName: string,
        newName: string
    ): Promise<void> {
        if (!this._storageUri) {
            await this.initialize();
        }
        await this.loadHistory();

        let changed = false;
        for (const entry of this._history) {
            if (
                entry.connectionId === connectionId ||
                (!entry.connectionId && entry.connectionName === oldName)
            ) {
                entry.connectionName = newName;
                changed = true;
            }
        }

        if (changed) {
            await this.saveHistory();
            vscode.commands.executeCommand('runql.memoryRecall.refresh');
        }
    }

    private pruneOldEntries(): void {
        const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
        const cutoff = Date.now() - SEVEN_DAYS_MS;

        this._history = this._history.filter((entry, index) => {
            if (index < 20) return true; // Always keep most recent 20
            return entry.timestamp > cutoff;
        });
    }

    private generateId(): string {
        return crypto.randomUUID();
    }
}

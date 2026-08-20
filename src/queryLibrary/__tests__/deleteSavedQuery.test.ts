import * as vscode from 'vscode';
import { deleteSavedQuery } from '../deleteSavedQuery';
import { queryIndex } from '../queryIndex';
import { SavedQueryItem } from '../savedQueriesView';

type Entry =
  | { kind: 'dir' }
  | { kind: 'file'; bytes: Uint8Array; ctime: number; mtime: number };

const fsMap = new Map<string, Entry>();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function normalizePath(input: string): string {
  if (!input) return '/';
  const normalized = input.replace(/\/+/g, '/').replace(/\/$/, '');
  return normalized.length > 0 ? normalized : '/';
}

function ensureDir(path: string): void {
  const normalized = normalizePath(path);
  if (normalized === '/') {
    fsMap.set('/', { kind: 'dir' });
    return;
  }

  const parts = normalized.split('/').filter(Boolean);
  let current = '';
  fsMap.set('/', { kind: 'dir' });
  for (const part of parts) {
    current += `/${part}`;
    fsMap.set(current, { kind: 'dir' });
  }
}

function writeTextAt(path: string, text: string): void {
  const normalized = normalizePath(path);
  ensureDir(normalized.split('/').slice(0, -1).join('/'));
  fsMap.set(normalized, {
    kind: 'file',
    bytes: encoder.encode(text),
    ctime: Date.now(),
    mtime: Date.now(),
  });
}

function writeJsonAt(path: string, data: unknown): void {
  writeTextAt(path, JSON.stringify(data, null, 2));
}

function readTextAt(path: string): string {
  const entry = fsMap.get(normalizePath(path));
  if (!entry || entry.kind !== 'file') {
    throw new Error(`Missing file at ${path}`);
  }
  return decoder.decode(entry.bytes);
}

function readJsonAt<T>(path: string): T {
  return JSON.parse(readTextAt(path)) as T;
}

function fileExists(path: string): boolean {
  return fsMap.has(normalizePath(path));
}

function relativePath(uri: vscode.Uri): string {
  return normalizePath(uri.path).replace(/^\/workspace\//, '');
}

function configureWorkspaceFs(): void {
  (vscode.workspace.workspaceFolders as unknown) = [{ uri: vscode.Uri.file('/workspace') }];
  (vscode.workspace as unknown as { asRelativePath: jest.Mock }).asRelativePath = jest.fn((uri: vscode.Uri) => relativePath(uri));

  (vscode.workspace.fs.createDirectory as jest.Mock).mockImplementation(async (uri: vscode.Uri) => {
    ensureDir(uri.path);
  });

  (vscode.workspace.fs.writeFile as jest.Mock).mockImplementation(async (uri: vscode.Uri, bytes: Uint8Array) => {
    const normalized = normalizePath(uri.path);
    ensureDir(normalized.split('/').slice(0, -1).join('/'));
    fsMap.set(normalized, {
      kind: 'file',
      bytes,
      ctime: Date.now(),
      mtime: Date.now(),
    });
  });

  (vscode.workspace.fs.readFile as jest.Mock).mockImplementation(async (uri: vscode.Uri) => {
    const entry = fsMap.get(normalizePath(uri.path));
    if (!entry || entry.kind !== 'file') {
      throw new Error(`ENOENT: ${uri.path}`);
    }
    return entry.bytes;
  });

  (vscode.workspace.fs.stat as jest.Mock).mockImplementation(async (uri: vscode.Uri) => {
    const entry = fsMap.get(normalizePath(uri.path));
    if (!entry) {
      throw new Error(`ENOENT: ${uri.path}`);
    }
    return {
      type: entry.kind === 'dir' ? vscode.FileType.Directory : vscode.FileType.File,
      ctime: entry.kind === 'file' ? entry.ctime : Date.now(),
      mtime: entry.kind === 'file' ? entry.mtime : Date.now(),
    };
  });

  (vscode.workspace.fs.delete as jest.Mock).mockImplementation(async (uri: vscode.Uri) => {
    const normalized = normalizePath(uri.path);
    if (!fsMap.has(normalized)) {
      const error = new Error(`ENOENT: ${uri.path}`) as Error & { code: string };
      error.code = 'FileNotFound';
      throw error;
    }
    fsMap.delete(normalized);
  });
}

function seedRunQLProject(): void {
  ensureDir('/workspace/RunQL/queries/Analytics');
  ensureDir('/workspace/RunQL/system/queries');
}

interface QueryIndexTestState {
  index: Map<string, unknown>;
  pathIndex: Map<string, unknown>;
  persistencePending: boolean;
  persistenceTimer?: ReturnType<typeof setTimeout>;
  persistencePromise?: Promise<void>;
  resolvePersistencePromise?: () => void;
  persistenceFlushing: boolean;
  persistenceRerunRequested: boolean;
  pendingCheckMemorySources: boolean;
}

function resetQueryIndexForTest(): void {
  const state = queryIndex as unknown as QueryIndexTestState;
  state.index = new Map();
  state.pathIndex = new Map();
  state.persistencePending = false;
  state.persistenceTimer = undefined;
  state.persistencePromise = undefined;
  state.resolvePersistencePromise = undefined;
  state.persistenceFlushing = false;
  state.persistenceRerunRequested = false;
  state.pendingCheckMemorySources = false;
}

describe('deleteSavedQuery', () => {
  beforeEach(() => {
    fsMap.clear();
    jest.clearAllMocks();
    configureWorkspaceFs();
    seedRunQLProject();
    resetQueryIndexForTest();
  });

  it('deletes the source, markdown companion, query index row, and refreshes the view', async () => {
    writeTextAt('/workspace/RunQL/queries/Analytics/revenue.sql', 'select * from revenue;');
    writeTextAt('/workspace/RunQL/queries/Analytics/revenue.md', 'Revenue notes');
    writeTextAt('/workspace/RunQL/queries/Analytics/revenue.comments.json', '{}');
    writeJsonAt('/workspace/RunQL/system/queries/queryIndex.json', {
      version: '0.1',
      generatedAt: '2026-08-20T00:00:00.000Z',
      queries: [{
        path: 'queries/Analytics/revenue.sql',
        docPath: 'queries/Analytics/revenue.md',
        sqlHash: 'hash',
        createdAt: '2026-08-20T00:00:00.000Z',
        updatedAt: '2026-08-20T00:00:00.000Z',
      }],
    });
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Delete');

    await deleteSavedQuery({
      label: 'Revenue',
      entry: {
        path: 'queries/Analytics/revenue.sql',
        docPath: 'queries/Analytics/revenue.md',
        sqlHash: 'hash',
        createdAt: '2026-08-20T00:00:00.000Z',
        updatedAt: '2026-08-20T00:00:00.000Z',
      },
    } as SavedQueryItem);

    expect(fileExists('/workspace/RunQL/queries/Analytics/revenue.sql')).toBe(false);
    expect(fileExists('/workspace/RunQL/queries/Analytics/revenue.md')).toBe(false);
    expect(fileExists('/workspace/RunQL/queries/Analytics/revenue.comments.json')).toBe(false);
    expect(readJsonAt<{ queries: unknown[] }>('/workspace/RunQL/system/queries/queryIndex.json').queries).toEqual([]);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('runql.view.refreshSavedQueries');
  });
});

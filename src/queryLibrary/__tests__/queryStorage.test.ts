import * as vscode from 'vscode';
import { HistoryService } from '../../services/historyService';
import { queryIndex } from '../queryIndex';
import { renameQueryConnectionFolder } from '../queryStorage';

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

  (vscode.workspace.openTextDocument as jest.Mock).mockImplementation(async (uri: vscode.Uri) => ({
    uri,
    getText: () => readTextAt(uri.path),
  }));

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

  (vscode.workspace.fs.readDirectory as jest.Mock).mockImplementation(async (uri: vscode.Uri) => {
    const root = normalizePath(uri.path);
    const prefix = root === '/' ? '/' : `${root}/`;
    const names = new Map<string, number>();

    for (const [path, entry] of fsMap.entries()) {
      if (path === root || !path.startsWith(prefix)) continue;
      const remainder = path.slice(prefix.length);
      if (!remainder || remainder.includes('/')) continue;
      names.set(remainder, entry.kind === 'dir' ? vscode.FileType.Directory : vscode.FileType.File);
    }

    return Array.from(names.entries());
  });

  (vscode.workspace.fs.rename as jest.Mock).mockImplementation(async (oldUri: vscode.Uri, newUri: vscode.Uri, options?: { overwrite?: boolean }) => {
    const source = normalizePath(oldUri.path);
    const target = normalizePath(newUri.path);
    const sourceEntry = fsMap.get(source);
    if (!sourceEntry) throw new Error(`ENOENT: ${oldUri.path}`);
    if (!options?.overwrite && fsMap.has(target)) throw new Error(`EEXIST: ${newUri.path}`);

    ensureDir(target.split('/').slice(0, -1).join('/'));

    if (sourceEntry.kind === 'file') {
      fsMap.set(target, sourceEntry);
      fsMap.delete(source);
      return;
    }

    const descendants = Array.from(fsMap.entries())
      .filter(([path]) => path === source || path.startsWith(`${source}/`))
      .sort(([left], [right]) => left.length - right.length);

    for (const [path, entry] of descendants) {
      const movedPath = path === source ? target : `${target}${path.slice(source.length)}`;
      fsMap.set(movedPath, entry);
    }
    for (const [path] of descendants) {
      fsMap.delete(path);
    }
  });
}

function seedRunQLProject(): void {
  ensureDir('/workspace/RunQL/queries');
  ensureDir('/workspace/RunQL/schemas');
  ensureDir('/workspace/RunQL/system/queries');
}

describe('query connection storage', () => {
  beforeEach(() => {
    fsMap.clear();
    configureWorkspaceFs();
    seedRunQLProject();
    (HistoryService as unknown as { instance?: unknown }).instance = undefined;
    (queryIndex as unknown as { index: Map<string, unknown>; pathIndex: Map<string, unknown>; persistencePending: boolean }).index = new Map();
    (queryIndex as unknown as { index: Map<string, unknown>; pathIndex: Map<string, unknown>; persistencePending: boolean }).pathIndex = new Map();
    (queryIndex as unknown as { index: Map<string, unknown>; pathIndex: Map<string, unknown>; persistencePending: boolean }).persistencePending = false;
  });

  it('renames query folders and updates query index, live index, markdown, and history', async () => {
    writeTextAt('/workspace/RunQL/queries/Analytics/reports/revenue.sql', 'select * from revenue;');
    writeTextAt('/workspace/RunQL/queries/Analytics/reports/revenue.md', [
      '---',
      'title: "Revenue"',
      'connection: "Analytics"',
      'connection_id: "conn-1234"',
      'dialect: "postgres"',
      '---',
      '',
      'Revenue query.',
    ].join('\n'));
    writeJsonAt('/workspace/RunQL/system/queries/queryIndex.json', {
      version: '0.1',
      generatedAt: '2026-05-21T00:00:00.000Z',
      queries: [{
        path: 'RunQL/queries/Analytics/reports/revenue.sql',
        docPath: 'RunQL/queries/Analytics/reports/revenue.md',
        sqlHash: 'hash',
        createdAt: '2026-05-21T00:00:00.000Z',
        updatedAt: '2026-05-21T00:00:00.000Z',
        connectionId: 'conn-1234',
        connectionName: 'Analytics',
        searchText: 'analytics revenue',
      }],
    });
    writeJsonAt('/workspace/RunQL/system/queries/queryHistory.json', [
      { id: '1', query: 'select 1', timestamp: 1, connectionId: 'conn-1234', connectionName: 'Analytics' },
      { id: '2', query: 'select 2', timestamp: 2, connectionName: 'Analytics' },
      { id: '3', query: 'select 3', timestamp: 3, connectionId: 'other', connectionName: 'Other' },
    ]);

    await queryIndex.updateFile(vscode.Uri.file('/workspace/RunQL/queries/Analytics/reports/revenue.sql'), true);

    await renameQueryConnectionFolder('conn-1234', 'Analytics', 'Analytics Prod');
    await new Promise(resolve => setTimeout(resolve, 600));

    expect(fileExists('/workspace/RunQL/queries/Analytics')).toBe(false);
    expect(fileExists('/workspace/RunQL/queries/Analytics_Prod/reports/revenue.sql')).toBe(true);
    expect(readTextAt('/workspace/RunQL/queries/Analytics_Prod/reports/revenue.md')).toContain('connection: "Analytics Prod"');

    const indexFile = readJsonAt<{ queries: Array<{ path: string; docPath?: string; connectionName?: string; searchText?: string }> }>('/workspace/RunQL/system/queries/queryIndex.json');
    expect(indexFile.queries[0].path).toBe('RunQL/queries/Analytics_Prod/reports/revenue.sql');
    expect(indexFile.queries[0].docPath).toBe('RunQL/queries/Analytics_Prod/reports/revenue.md');
    expect(indexFile.queries[0].connectionName).toBe('Analytics Prod');
    expect(indexFile.queries[0].searchText).toContain('analytics prod');

    expect(queryIndex.getEntry(vscode.Uri.file('/workspace/RunQL/queries/Analytics/reports/revenue.sql'))).toBeUndefined();
    expect(queryIndex.getEntry(vscode.Uri.file('/workspace/RunQL/queries/Analytics_Prod/reports/revenue.sql'))?.connectionName).toBe('Analytics Prod');

    const history = readJsonAt<Array<{ id: string; connectionName: string }>>('/workspace/RunQL/system/queries/queryHistory.json');
    expect(history.find(entry => entry.id === '1')?.connectionName).toBe('Analytics Prod');
    expect(history.find(entry => entry.id === '2')?.connectionName).toBe('Analytics Prod');
    expect(history.find(entry => entry.id === '3')?.connectionName).toBe('Other');
  });

  it('updates metadata when the sanitized query folder name does not change', async () => {
    writeTextAt('/workspace/RunQL/queries/Analytics_Prod/revenue.sql', 'select * from revenue;');
    writeTextAt('/workspace/RunQL/queries/Analytics_Prod/revenue.md', [
      '---',
      'connection: "Analytics Prod"',
      'connection_id: "conn-1234"',
      '---',
      '',
      'Revenue query.',
    ].join('\n'));
    writeJsonAt('/workspace/RunQL/system/queries/queryIndex.json', {
      version: '0.1',
      generatedAt: '2026-05-21T00:00:00.000Z',
      queries: [{
        path: 'RunQL/queries/Analytics_Prod/revenue.sql',
        docPath: 'RunQL/queries/Analytics_Prod/revenue.md',
        sqlHash: 'hash',
        createdAt: '2026-05-21T00:00:00.000Z',
        updatedAt: '2026-05-21T00:00:00.000Z',
        connectionId: 'conn-1234',
        connectionName: 'Analytics Prod',
      }],
    });
    writeJsonAt('/workspace/RunQL/system/queries/queryHistory.json', [
      { id: '1', query: 'select 1', timestamp: 1, connectionId: 'conn-1234', connectionName: 'Analytics Prod' },
    ]);

    await renameQueryConnectionFolder('conn-1234', 'Analytics Prod', 'Analytics_Prod');

    expect(fileExists('/workspace/RunQL/queries/Analytics_Prod/revenue.sql')).toBe(true);
    expect(readTextAt('/workspace/RunQL/queries/Analytics_Prod/revenue.md')).toContain('connection: "Analytics_Prod"');

    const indexFile = readJsonAt<{ queries: Array<{ path: string; connectionName?: string }> }>('/workspace/RunQL/system/queries/queryIndex.json');
    expect(indexFile.queries[0].path).toBe('RunQL/queries/Analytics_Prod/revenue.sql');
    expect(indexFile.queries[0].connectionName).toBe('Analytics_Prod');

    const history = readJsonAt<Array<{ connectionName: string }>>('/workspace/RunQL/system/queries/queryHistory.json');
    expect(history[0].connectionName).toBe('Analytics_Prod');
  });
});

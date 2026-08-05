import * as vscode from 'vscode';
import { HistoryService, HistoryEntry } from '../historyService';

type Entry = { kind: 'dir' } | { kind: 'file'; bytes: Uint8Array };

const fsMap = new Map<string, Entry>();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function norm(p: string): string {
  if (!p) return '/';
  const n = p.replace(/\/+/g, '/').replace(/\/$/, '');
  return n.length > 0 ? n : '/';
}

function ensureDir(p: string): void {
  const n = norm(p);
  if (n === '/') { fsMap.set('/', { kind: 'dir' }); return; }
  fsMap.set('/', { kind: 'dir' });
  let cur = '';
  for (const seg of n.split('/').filter(Boolean)) {
    cur += `/${seg}`;
    if (!fsMap.has(cur)) fsMap.set(cur, { kind: 'dir' });
  }
}

function writeFileAt(p: string, bytes: Uint8Array): void {
  const n = norm(p);
  ensureDir(n.split('/').slice(0, -1).join('/'));
  fsMap.set(n, { kind: 'file', bytes });
}

function readJsonAt<T>(p: string): T {
  const e = fsMap.get(norm(p));
  if (!e || e.kind !== 'file') throw new Error(`missing ${p}`);
  return JSON.parse(decoder.decode(e.bytes));
}

function configureFs(): void {
  (vscode.workspace.workspaceFolders as unknown) = [
    { uri: vscode.Uri.file('/workspace'), name: 'workspace', index: 0 },
  ];
  (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
    get: jest.fn((k: string, fb: unknown) => {
      if (k === 'location') return 'workspace';
      return fb;
    }),
    has: jest.fn().mockReturnValue(true),
    inspect: jest.fn(),
    update: jest.fn(),
  }));
  (vscode.workspace.fs.createDirectory as jest.Mock).mockImplementation(async (uri: vscode.Uri) => {
    ensureDir(uri.path);
  });
  (vscode.workspace.fs.writeFile as jest.Mock).mockImplementation(
    async (uri: vscode.Uri, bytes: Uint8Array) => writeFileAt(uri.path, bytes)
  );
  (vscode.workspace.fs.readFile as jest.Mock).mockImplementation(async (uri: vscode.Uri) => {
    const e = fsMap.get(norm(uri.path));
    if (!e || e.kind !== 'file') throw new Error(`ENOENT ${uri.path}`);
    return e.bytes;
  });
  (vscode.workspace.fs.stat as jest.Mock).mockImplementation(async (uri: vscode.Uri) => {
    const e = fsMap.get(norm(uri.path));
    if (!e) throw new Error(`ENOENT ${uri.path}`);
    return { type: e.kind === 'dir' ? 2 : 1 };
  });
  (vscode.workspace.fs.readDirectory as jest.Mock).mockImplementation(async (uri: vscode.Uri) => {
    const root = norm(uri.path);
    const prefix = root === '/' ? '/' : `${root}/`;
    const names: Array<[string, number]> = [];
    for (const [p, e] of fsMap.entries()) {
      if (p === root || !p.startsWith(prefix)) continue;
      const rem = p.slice(prefix.length);
      if (!rem || rem.includes('/')) continue;
      names.push([rem, e.kind === 'dir' ? 2 : 1]);
    }
    return names;
  });
  (vscode.workspace.fs.delete as jest.Mock).mockImplementation(async (uri: vscode.Uri) => {
    fsMap.delete(norm(uri.path));
  });
}

function seedInitialized(): void {
  // isProjectInitialized() requires <root>/RunQL/{queries,schemas,system} to exist.
  ensureDir('/workspace/RunQL/queries');
  ensureDir('/workspace/RunQL/schemas');
  ensureDir('/workspace/RunQL/system/queries');
}

describe('historyService optimistic concurrency', () => {
  beforeEach(() => {
    fsMap.clear();
    configureFs();
    seedInitialized();
    (HistoryService as unknown as { instance?: unknown }).instance = undefined;
  });

  it('preserves entries added by another window when the current window saves', async () => {
    const svc = HistoryService.getInstance();
    await svc.initialize();

    await svc.addEntry({ query: 'select A', connectionName: 'db' });

    // Simulate another window writing more entries to disk since our load.
    const disk: HistoryEntry[] = readJsonAt('/workspace/RunQL/system/queries/queryHistory.json');
    const other: HistoryEntry = {
      id: 'from-other-window',
      timestamp: Date.now() + 1000,
      query: 'select B',
      connectionName: 'db',
    };
    writeFileAt(
      '/workspace/RunQL/system/queries/queryHistory.json',
      encoder.encode(JSON.stringify([other, ...disk], null, 2))
    );

    // Our next save must merge, not overwrite.
    await svc.addEntry({ query: 'select C', connectionName: 'db' });

    const merged: HistoryEntry[] = readJsonAt('/workspace/RunQL/system/queries/queryHistory.json');
    const ids = merged.map((e) => e.id);
    expect(ids).toContain('from-other-window');
    // Two of our entries land as well (A and C).
    expect(merged.filter((e) => e.query === 'select A')).toHaveLength(1);
    expect(merged.filter((e) => e.query === 'select C')).toHaveLength(1);
  });

  it('later-timestamp wins on same-id conflict', async () => {
    const svc = HistoryService.getInstance();
    await svc.initialize();

    // Seed one entry via the service.
    await svc.addEntry({ query: 'v1', connectionName: 'db' });
    const [ourEntry] = readJsonAt<HistoryEntry[]>(
      '/workspace/RunQL/system/queries/queryHistory.json'
    );
    // Another window writes a NEWER version of the same id.
    const laterVersion: HistoryEntry = {
      ...ourEntry,
      query: 'v2-from-disk',
      timestamp: (ourEntry.timestamp ?? 0) + 5000,
    };
    writeFileAt(
      '/workspace/RunQL/system/queries/queryHistory.json',
      encoder.encode(JSON.stringify([laterVersion], null, 2))
    );

    // Trigger a save with an unrelated new entry — merge should prefer
    // the newer disk version of the shared id.
    await svc.addEntry({ query: 'unrelated', connectionName: 'db' });

    const merged: HistoryEntry[] = readJsonAt('/workspace/RunQL/system/queries/queryHistory.json');
    const same = merged.find((e) => e.id === ourEntry.id);
    expect(same?.query).toBe('v2-from-disk');
  });
});

import * as vscode from 'vscode';
import { maybeRefreshGeneratedDocsOnVersionBump } from '../refreshGeneratedDocs';

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

function readFileAt(p: string): string {
  const e = fsMap.get(norm(p));
  if (!e || e.kind !== 'file') throw new Error(`missing ${p}`);
  return decoder.decode(e.bytes);
}

function fileExistsAt(p: string): boolean {
  return fsMap.has(norm(p));
}

function configureFs(): void {
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

function setStorageMode(mode: 'workspace' | 'user' | 'custom', userPath = '/user-runql'): void {
  (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
    get: jest.fn((k: string, fb: unknown) => {
      if (k === 'location') return mode;
      if (k === 'userPath') return userPath;
      if (k === 'customPath') return '';
      if (k === 'codespacesPath') return '/workspaces/.runql';
      if (k === 'workspaceFolder') return '';
      return fb;
    }),
    has: jest.fn().mockReturnValue(true),
    inspect: jest.fn(),
    update: jest.fn(),
  }));
}

function setFolders(paths: string[]): void {
  (vscode.workspace.workspaceFolders as unknown) = paths.map((p, i) => ({
    uri: vscode.Uri.file(p),
    name: p.split('/').pop() ?? p,
    index: i,
  }));
}

function makeContext(initialLastVersion?: string): vscode.ExtensionContext {
  let stored = initialLastVersion;
  return {
    globalState: {
      get: jest.fn(() => stored),
      update: jest.fn(async (_key: string, value: string) => { stored = value; }),
      keys: jest.fn(() => []),
    },
  } as unknown as vscode.ExtensionContext;
}

describe('maybeRefreshGeneratedDocsOnVersionBump', () => {
  beforeEach(() => {
    fsMap.clear();
    configureFs();
  });

  it('is a no-op when the extension version has not changed', async () => {
    setFolders(['/proj']);
    setStorageMode('user');
    // Simulate a linked folder with a stale README stamp — should NOT be
    // rewritten because version is unchanged.
    writeFileAt('/proj/.runql-link/storage-root.json', encoder.encode('{}'));
    writeFileAt('/proj/README_RUNQL.md', encoder.encode('STALE'));
    const context = makeContext('1.16.0');
    await maybeRefreshGeneratedDocsOnVersionBump(context, '1.16.0');
    expect(readFileAt('/proj/README_RUNQL.md')).toBe('STALE');
  });

  it('refreshes AGENTS.md + README (when unedited) in linked user/custom folders on version bump', async () => {
    setFolders(['/proj']);
    setStorageMode('user');
    // Pre-existing linked marker
    writeFileAt(
      '/proj/.runql-link/storage-root.json',
      encoder.encode(JSON.stringify({
        version: '0.1',
        storageLocation: 'user',
        runqlRoot: '/user-runql',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }))
    );
    // Pre-existing AGENTS.md with a stale bounded RunQL section
    writeFileAt(
      '/proj/AGENTS.md',
      encoder.encode(
        `# Project\n\n<!-- RUNQL:BEGIN -->\nOLD BODY\n<!-- RUNQL:END -->\n`
      )
    );
    const context = makeContext('1.16.0');
    await maybeRefreshGeneratedDocsOnVersionBump(context, '1.17.0');

    // AGENTS.md bounded section refreshed, preamble preserved.
    const agents = readFileAt('/proj/AGENTS.md');
    expect(agents).toContain('# Project');
    expect(agents).toContain('<!-- RUNQL:BEGIN -->');
    expect(agents).not.toContain('OLD BODY');
    expect(agents).toContain('/user-runql');

    // README written with current-mode content.
    expect(fileExistsAt('/proj/README_RUNQL.md')).toBe(true);
    expect(readFileAt('/proj/README_RUNQL.md')).toContain('# RunQL Project');
    expect(readFileAt('/proj/README_RUNQL.md')).toContain('/user-runql');

    // Version stamp recorded so the next activation is a no-op.
    expect(context.globalState.update).toHaveBeenCalledWith(
      'runql.docs.lastActivatedVersion',
      '1.17.0'
    );
  });

  it('skips folders that are not linked to RunQL', async () => {
    setFolders(['/proj-a', '/proj-b']);
    setStorageMode('user');
    // Only /proj-a is linked.
    writeFileAt('/proj-a/.runql-link/storage-root.json', encoder.encode('{}'));
    const context = makeContext();
    await maybeRefreshGeneratedDocsOnVersionBump(context, '1.17.0');

    expect(fileExistsAt('/proj-a/AGENTS.md')).toBe(true);
    expect(fileExistsAt('/proj-a/README_RUNQL.md')).toBe(true);
    expect(fileExistsAt('/proj-b/AGENTS.md')).toBe(false);
    expect(fileExistsAt('/proj-b/README_RUNQL.md')).toBe(false);
  });

  it('overwrites a stale README_RUNQL.md on version bump (RunQL-owned file)', async () => {
    setFolders(['/proj']);
    setStorageMode('user');
    writeFileAt('/proj/.runql-link/storage-root.json', encoder.encode('{}'));
    writeFileAt('/proj/README_RUNQL.md', encoder.encode('STALE CONTENT FROM PRIOR VERSION'));
    const context = makeContext();
    await maybeRefreshGeneratedDocsOnVersionBump(context, '1.17.0');
    const fresh = readFileAt('/proj/README_RUNQL.md');
    expect(fresh).not.toBe('STALE CONTENT FROM PRIOR VERSION');
    expect(fresh).toContain('# RunQL Project');
  });

  it('workspace-mode folder is linked when <folder>/RunQL/queries exists', async () => {
    setFolders(['/proj']);
    setStorageMode('workspace');
    ensureDir('/proj/RunQL/queries');
    const context = makeContext();
    await maybeRefreshGeneratedDocsOnVersionBump(context, '1.17.0');
    expect(fileExistsAt('/proj/AGENTS.md')).toBe(true);
    expect(fileExistsAt('/proj/README_RUNQL.md')).toBe(true);
  });

  it('records the new version even when no linked folders are found', async () => {
    setFolders([]);
    setStorageMode('user');
    const context = makeContext('1.16.0');
    await maybeRefreshGeneratedDocsOnVersionBump(context, '1.17.0');
    expect(context.globalState.update).toHaveBeenCalledWith(
      'runql.docs.lastActivatedVersion',
      '1.17.0'
    );
  });
});

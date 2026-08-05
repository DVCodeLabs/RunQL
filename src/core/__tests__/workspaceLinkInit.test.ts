import * as vscode from 'vscode';
import {
  promptWorkspaceLinkInit,
  initializeFolderLink,
  inspectAllFolders,
  promptWorkspaceOwnerFolder,
} from '../workspaceLinkInit';
import type { RunQLStorageRoot } from '../storageRoot';

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
  if (n === '/') {
    fsMap.set('/', { kind: 'dir' });
    return;
  }
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

function setFolders(paths: string[]): void {
  (vscode.workspace.workspaceFolders as unknown) = paths.map((p, i) => ({
    uri: vscode.Uri.file(p),
    name: p.split('/').pop() ?? p,
    index: i,
  }));
}

function makeRoot(fsPath: string, location: 'user' | 'custom' = 'user'): RunQLStorageRoot {
  return {
    location,
    uri: vscode.Uri.file(fsPath),
    displayPath: fsPath,
    isCodespaces: false,
    isWorkspaceScoped: false,
  };
}

function configureFs(): void {
  (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
    get: jest.fn((_k: string, fallback: unknown) => {
      if (_k === 'location') return 'user';
      if (_k === 'userPath') return '/user-runql';
      if (_k === 'customPath') return '';
      if (_k === 'codespacesPath') return '/workspaces/.runql';
      if (_k === 'workspaceFolder') return '';
      return fallback;
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
  (vscode.workspace.fs.delete as jest.Mock).mockImplementation(async (uri: vscode.Uri) => {
    fsMap.delete(norm(uri.path));
  });
  (vscode.workspace.fs.readDirectory as jest.Mock).mockImplementation(async (uri: vscode.Uri) => {
    const root = norm(uri.path);
    const prefix = root === '/' ? '/' : `${root}/`;
    const names: Array<[string, number]> = [];
    const seen = new Set<string>();
    for (const [p, e] of fsMap.entries()) {
      if (p === root || !p.startsWith(prefix)) continue;
      const rem = p.slice(prefix.length);
      if (!rem || rem.includes('/')) continue;
      if (seen.has(rem)) continue;
      seen.add(rem);
      names.push([rem, e.kind === 'dir' ? 2 : 1]);
    }
    return names;
  });
}

describe('workspaceLinkInit', () => {
  beforeEach(() => {
    fsMap.clear();
    configureFs();
    (vscode.window.showInformationMessage as jest.Mock).mockReset();
    (vscode.window.showQuickPick as jest.Mock).mockReset();
    (vscode.commands.executeCommand as jest.Mock).mockReset();
  });

  it('initializeFolderLink writes all expected marker + guidance files', async () => {
    setFolders(['/proj']);
    const folder = vscode.workspace.workspaceFolders![0];
    await initializeFolderLink(folder, makeRoot('/user-runql'));

    expect(fileExistsAt('/proj/.runql-link/storage-root.json')).toBe(true);
    expect(fileExistsAt('/proj/.runql-link/ref.json')).toBe(true);
    expect(fileExistsAt('/proj/AGENTS.md')).toBe(true);
    expect(fileExistsAt('/proj/README_RUNQL.md')).toBe(true);
    expect(fileExistsAt('/proj/.gitignore')).toBe(true);
    // Consolidation: no more `<workspace>/RunQL/…` markers or root-level
    // `.runql-ref.json` — everything lives under `.runql-link/`.
    expect(fileExistsAt('/proj/RunQL/system/storage-root.json')).toBe(false);
    expect(fileExistsAt('/proj/.runql-ref.json')).toBe(false);

    const ignore = readFileAt('/proj/.gitignore');
    expect(ignore).toContain('.runql-link/');
    expect(ignore).toContain('README_RUNQL.md');
    expect(ignore).not.toContain('AGENTS.md');
    expect(ignore).not.toContain('RunQL/system/storage-root.json');
  });

  it('initializeFolderLink clears a stale skip marker', async () => {
    setFolders(['/proj']);
    writeFileAt(
      '/proj/.runql-link/skip.json',
      encoder.encode('{"version":"0.1","reason":"user_skipped"}')
    );
    const folder = vscode.workspace.workspaceFolders![0];
    await initializeFolderLink(folder, makeRoot('/user-runql'));
    expect(fileExistsAt('/proj/.runql-link/skip.json')).toBe(false);
  });

  it('inspectAllFolders reports linked-current, linked-other, skipped, unlinked correctly', async () => {
    setFolders(['/a', '/b', '/c', '/d']);
    const root = makeRoot('/user-runql');

    // /a already linked to the current root
    writeFileAt(
      '/a/.runql-link/storage-root.json',
      encoder.encode(JSON.stringify({
        version: '0.1',
        storageLocation: 'user',
        runqlRoot: '/user-runql',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }))
    );
    // /b linked to a different root
    writeFileAt(
      '/b/.runql-link/storage-root.json',
      encoder.encode(JSON.stringify({
        version: '0.1',
        storageLocation: 'user',
        runqlRoot: '/other-root',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }))
    );
    // /c skipped for the current root
    writeFileAt(
      '/c/.runql-link/skip.json',
      encoder.encode(JSON.stringify({
        version: '0.1',
        storageLocation: 'user',
        runqlRoot: '/user-runql',
        reason: 'user_skipped',
        createdAt: '2026-01-01T00:00:00.000Z',
      }))
    );
    // /d unlinked (no markers)

    const statuses = await inspectAllFolders(root);
    const byName = Object.fromEntries(statuses.map((s) => [s.folder.name, s.kind]));
    expect(byName).toEqual({
      a: 'linked-current',
      b: 'linked-other',
      c: 'skipped',
      d: 'unlinked',
    });
  });

  it('promptWorkspaceLinkInit initializes only user-selected folders and honors Do Not Ask Again', async () => {
    setFolders(['/a', '/b', '/c']);
    // Sequence: /a Initialize, /b Skip, /c Do Not Ask Again
    (vscode.window.showInformationMessage as jest.Mock)
      .mockResolvedValueOnce('Initialize')
      .mockResolvedValueOnce('Skip')
      .mockResolvedValueOnce('Do Not Ask Again');

    const initialized = await promptWorkspaceLinkInit(makeRoot('/user-runql'));
    expect(initialized.map((f) => f.name).sort()).toEqual(['a']);
    expect(fileExistsAt('/a/.runql-link/storage-root.json')).toBe(true);
    expect(fileExistsAt('/b/.runql-link/storage-root.json')).toBe(false);
    expect(fileExistsAt('/c/.runql-link/storage-root.json')).toBe(false);
    // Skip All / session Skip: no marker persisted for /b.
    expect(fileExistsAt('/b/.runql-link/skip.json')).toBe(false);
    // Do Not Ask Again: persistent skip marker for /c.
    expect(fileExistsAt('/c/.runql-link/skip.json')).toBe(true);
  });

  it('promptWorkspaceLinkInit Initialize All initializes every remaining folder without further prompts', async () => {
    setFolders(['/a', '/b', '/c']);
    (vscode.window.showInformationMessage as jest.Mock)
      .mockResolvedValueOnce('Initialize All');

    const initialized = await promptWorkspaceLinkInit(makeRoot('/user-runql'));
    expect(initialized.map((f) => f.name).sort()).toEqual(['a', 'b', 'c']);
    for (const p of ['/a', '/b', '/c']) {
      expect(fileExistsAt(`${p}/.runql-link/storage-root.json`)).toBe(true);
    }
    // Only one prompt fired despite 3 folders.
    expect(vscode.window.showInformationMessage as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it('promptWorkspaceOwnerFolder single-folder returns that folder without prompting', async () => {
    setFolders(['/solo']);
    const picked = await promptWorkspaceOwnerFolder();
    expect(picked?.uri.path).toBe('/solo');
    expect(vscode.window.showQuickPick as jest.Mock).not.toHaveBeenCalled();
  });

  it('promptWorkspaceOwnerFolder multi-root prompts and persists the pick', async () => {
    setFolders(['/a', '/b']);
    const mockUpdate = jest.fn();
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
      get: jest.fn((k: string, fb: unknown) => {
        if (k === 'workspaceFolder') return '';
        return fb;
      }),
      has: jest.fn().mockReturnValue(true),
      inspect: jest.fn(),
      update: mockUpdate,
    }));
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({
      label: 'b',
      folder: vscode.workspace.workspaceFolders![1],
    });
    const picked = await promptWorkspaceOwnerFolder();
    expect(picked?.uri.path).toBe('/b');
    expect(mockUpdate).toHaveBeenCalledWith('workspaceFolder', 'file:/b', expect.anything());
  });
});

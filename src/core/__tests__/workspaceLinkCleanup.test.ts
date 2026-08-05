import * as vscode from 'vscode';
import { cleanupWorkspaceLinksOnWorkspaceMode } from '../workspaceLinkCleanup';

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

function setStorageMode(
  mode: 'workspace' | 'user' | 'custom',
  opts: { userPath?: string; workspaceFolder?: string } = {}
): void {
  const userPath = opts.userPath ?? '/user-runql';
  const workspaceFolder = opts.workspaceFolder ?? '';
  (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
    get: jest.fn((k: string, fb: unknown) => {
      if (k === 'location') return mode;
      if (k === 'userPath') return userPath;
      if (k === 'customPath') return '';
      if (k === 'codespacesPath') return '/workspaces/.runql';
      if (k === 'workspaceFolder') return workspaceFolder;
      return fb;
    }),
    has: jest.fn().mockReturnValue(true),
    inspect: jest.fn(),
    update: jest.fn(),
  }));
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
  (vscode.workspace.fs.delete as jest.Mock).mockImplementation(
    async (uri: vscode.Uri, options?: { recursive?: boolean }) => {
      const target = norm(uri.path);
      if (options?.recursive) {
        for (const p of Array.from(fsMap.keys())) {
          if (p === target || p.startsWith(`${target}/`)) fsMap.delete(p);
        }
        return;
      }
      fsMap.delete(target);
    }
  );
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

describe('cleanupWorkspaceLinksOnWorkspaceMode', () => {
  beforeEach(() => {
    fsMap.clear();
    configureFs();
  });

  it('deletes .runql-link/ from every open workspace folder and prunes RunQL gitignore lines', async () => {
    setFolders(['/a', '/b']);
    setStorageMode('workspace', { workspaceFolder: vscode.Uri.file('/a').toString() });
    writeFileAt('/a/.runql-link/storage-root.json', encoder.encode('{}'));
    writeFileAt('/a/.runql-link/ref.json', encoder.encode('{}'));
    writeFileAt('/b/.runql-link/storage-root.json', encoder.encode('{}'));
    writeFileAt('/a/.gitignore', encoder.encode('.runql-link/\nnode_modules/\n'));

    const results = await cleanupWorkspaceLinksOnWorkspaceMode();

    expect(results).toHaveLength(2);
    expect(fileExistsAt('/a/.runql-link')).toBe(false);
    expect(fileExistsAt('/b/.runql-link')).toBe(false);
    const ignore = readFileAt('/a/.gitignore');
    expect(ignore).toContain('node_modules/');
    expect(ignore).not.toContain('.runql-link/');
  });

  it('leaves .runql-link/ in place when it contains unexpected files', async () => {
    setFolders(['/a']);
    setStorageMode('workspace');
    writeFileAt('/a/.runql-link/storage-root.json', encoder.encode('{}'));
    writeFileAt('/a/.runql-link/user-notes.txt', encoder.encode('preserve me'));

    const results = await cleanupWorkspaceLinksOnWorkspaceMode();

    expect(results[0].removedLinkDir).toBe(false);
    expect(fileExistsAt('/a/.runql-link/user-notes.txt')).toBe(true);
  });

  it('is a no-op in user/custom mode', async () => {
    setFolders(['/a']);
    setStorageMode('user');
    writeFileAt('/a/.runql-link/storage-root.json', encoder.encode('{}'));

    const results = await cleanupWorkspaceLinksOnWorkspaceMode();

    expect(results).toHaveLength(0);
    expect(fileExistsAt('/a/.runql-link/storage-root.json')).toBe(true);
  });

  it('does not touch AGENTS.md or README_RUNQL.md', async () => {
    setFolders(['/a']);
    setStorageMode('workspace');
    writeFileAt('/a/.runql-link/storage-root.json', encoder.encode('{}'));
    writeFileAt('/a/AGENTS.md', encoder.encode('# Agents\nkeep me\n'));
    writeFileAt('/a/README_RUNQL.md', encoder.encode('# README\nkeep me\n'));

    await cleanupWorkspaceLinksOnWorkspaceMode();

    expect(fileExistsAt('/a/AGENTS.md')).toBe(true);
    expect(fileExistsAt('/a/README_RUNQL.md')).toBe(true);
  });
});

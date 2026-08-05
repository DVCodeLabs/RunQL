import * as vscode from 'vscode';
import {
  ensureAgentsMd,
  ensureReadmeMd,
  ensureRunqlGitignoreEntries,
  pruneRunqlGitignoreEntries,
  removeRunqlLinkFolder,
  writeRunqlRef,
  writeStorageRootMarker,
  clearStorageLinkSkipMarker,
  RUNQL_BEGIN,
  RUNQL_END,
} from '../fsWorkspace';

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
    fsMap.set(cur, { kind: 'dir' });
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
  (vscode.workspace.workspaceFolders as unknown) = [
    { uri: vscode.Uri.file('/workspace'), name: 'workspace', index: 0 },
  ];
  (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
    get: jest.fn((key: string, fallback: unknown) => {
      // Default to user-mode with a stable path so ensureAgentsMd content is deterministic.
      if (key === 'location') return 'user';
      if (key === 'userPath') return '/user-runql';
      if (key === 'customPath') return '';
      if (key === 'codespacesPath') return '/workspaces/.runql';
      if (key === 'workspaceFolder') return '';
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
    for (const [p, e] of fsMap.entries()) {
      if (p === root || !p.startsWith(prefix)) continue;
      const rem = p.slice(prefix.length);
      if (!rem || rem.includes('/')) continue;
      names.push([rem, e.kind === 'dir' ? 2 : 1]);
    }
    return names;
  });
}

const workspaceFolder = (): vscode.WorkspaceFolder => ({
  uri: vscode.Uri.file('/workspace'),
  name: 'workspace',
  index: 0,
});

const userRoot = () =>
  ({
    location: 'user' as const,
    uri: vscode.Uri.file('/user-runql'),
    displayPath: '/user-runql',
    isCodespaces: false,
    isWorkspaceScoped: false,
  });

describe('fsWorkspace', () => {
  beforeEach(() => {
    fsMap.clear();
    configureFs();
  });

  // ---- AGENTS.md marker behavior ----------------------------------------

  it('creates AGENTS.md with a bounded RunQL section when missing', async () => {
    await ensureAgentsMd();
    const content = readFileAt('/workspace/AGENTS.md');
    expect(content).toContain(RUNQL_BEGIN);
    expect(content).toContain(RUNQL_END);
    expect(content).toContain('# RunQL Context');
    // Storage-aware content
    expect(content).toContain('/user-runql');
  });

  it('appends bounded section when AGENTS.md exists without markers', async () => {
    writeFileAt('/workspace/AGENTS.md', encoder.encode('# My Project\nHello.\n'));
    await ensureAgentsMd();
    const content = readFileAt('/workspace/AGENTS.md');
    expect(content.startsWith('# My Project\nHello.')).toBe(true);
    expect(content).toContain(RUNQL_BEGIN);
    expect(content).toContain(RUNQL_END);
    // Preserved the original before the section
    expect(content.indexOf('# My Project')).toBeLessThan(content.indexOf(RUNQL_BEGIN));
  });

  it('updates only the content between markers when exactly one section exists', async () => {
    const preamble = '# My Project\nHello.\n\n';
    const oldSection = `${RUNQL_BEGIN}\n# RunQL Context\n\nOLD BODY\n${RUNQL_END}`;
    const trailing = '\n\n## After\ntrailing text\n';
    writeFileAt('/workspace/AGENTS.md', encoder.encode(preamble + oldSection + trailing));
    await ensureAgentsMd();
    const content = readFileAt('/workspace/AGENTS.md');
    expect(content).toContain('# My Project');
    expect(content).toContain('## After');
    expect(content).toContain('trailing text');
    expect(content).not.toContain('OLD BODY');
    expect(content).toContain('# RunQL Context');
  });

  it('leaves AGENTS.md untouched when RunQL markers are duplicated or malformed', async () => {
    const bad =
      `# My Project\n${RUNQL_BEGIN}\nfirst\n${RUNQL_END}\n${RUNQL_BEGIN}\nsecond\n${RUNQL_END}\n`;
    writeFileAt('/workspace/AGENTS.md', encoder.encode(bad));
    await ensureAgentsMd();
    expect(readFileAt('/workspace/AGENTS.md')).toBe(bad);
  });

  // ---- README_RUNQL.md ---------------------------------------------------

  it('creates README_RUNQL.md when missing', async () => {
    await ensureReadmeMd();
    expect(readFileAt('/workspace/README_RUNQL.md')).toContain('# RunQL Project');
  });

  it('overwrites an existing README_RUNQL.md when the resolved content changes', async () => {
    await ensureReadmeMd();
    const first = readFileAt('/workspace/README_RUNQL.md');
    // Simulate a template change by mutating the config so readmeContent
    // produces different output.
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementationOnce(() => ({
      get: jest.fn((k: string, fb: unknown) => {
        if (k === 'location') return 'user';
        if (k === 'userPath') return '/DIFFERENT-USER-RUNQL';
        return fb;
      }),
      has: jest.fn().mockReturnValue(true),
      inspect: jest.fn(),
      update: jest.fn(),
    }));
    await ensureReadmeMd();
    const second = readFileAt('/workspace/README_RUNQL.md');
    expect(second).not.toBe(first);
    expect(second).toContain('/DIFFERENT-USER-RUNQL');
  });

  it('skips the write when README_RUNQL.md content is already up to date', async () => {
    await ensureReadmeMd();
    const writeSpy = vscode.workspace.fs.writeFile as jest.Mock;
    const callsBefore = writeSpy.mock.calls.length;
    await ensureReadmeMd();
    const readmeWrites = writeSpy.mock.calls
      .slice(callsBefore)
      .filter((c) => (c[0] as vscode.Uri).path === '/workspace/README_RUNQL.md');
    expect(readmeWrites).toHaveLength(0);
  });

  // ---- storage-root.json marker ------------------------------------------

  it('writes storage-root.json with the resolved root and preserves createdAt', async () => {
    const first = await writeStorageRootMarker(workspaceFolder(), userRoot(), '2026-01-01T00:00:00.000Z');
    const contentA = JSON.parse(readFileAt(first.path));
    expect(contentA.storageLocation).toBe('user');
    expect(contentA.runqlRoot).toBe('/user-runql');
    expect(contentA.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(contentA.updatedAt).toBe('2026-01-01T00:00:00.000Z');

    const second = await writeStorageRootMarker(workspaceFolder(), userRoot(), '2026-06-01T00:00:00.000Z');
    const contentB = JSON.parse(readFileAt(second.path));
    expect(contentB.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(contentB.updatedAt).toBe('2026-06-01T00:00:00.000Z');
  });

  // ---- .runql-ref.json mirror --------------------------------------------

  it('writes .runql-ref.json without secrets and with storage-aware paths', async () => {
    const uri = await writeRunqlRef(workspaceFolder(), userRoot(), '2026-01-01T00:00:00.000Z');
    const ref = JSON.parse(readFileAt(uri.path));
    expect(ref.runqlRoot).toBe('/user-runql');
    expect(ref.queriesPath).toBe('/user-runql/queries');
    expect(ref.schemasPath).toBe('/user-runql/schemas');
    expect(ref.connectionsProfilePath).toBe('/user-runql/system/connections.json');
    expect(ref.secrets).toMatch(/SecretStorage/);
    // No secret material of any kind
    const raw = readFileAt(uri.path);
    expect(raw.toLowerCase()).not.toContain('password');
    expect(raw.toLowerCase()).not.toContain('api_key');
  });

  // ---- .gitignore --------------------------------------------------------

  it('appends the consolidated .runql-link/ entry to .gitignore and preserves unrelated content', async () => {
    writeFileAt('/workspace/.gitignore', encoder.encode('# Existing\nnode_modules/\n'));
    await ensureRunqlGitignoreEntries(workspaceFolder());
    const content = readFileAt('/workspace/.gitignore');
    expect(content).toContain('node_modules/');
    expect(content).toContain('.runql-link/');
    expect(content).toContain('README_RUNQL.md');
    // Legacy per-file entries are NOT added (consolidation replaces them).
    expect(content).not.toContain('.runql-ref.json');
    expect(content).not.toContain('RunQL/system/storage-root.json');
    expect(content).not.toContain('AGENTS.md');
  });

  it('is idempotent when .gitignore already contains RunQL entries', async () => {
    writeFileAt(
      '/workspace/.gitignore',
      encoder.encode('.runql-link/\nREADME_RUNQL.md\n')
    );
    const before = readFileAt('/workspace/.gitignore');
    await ensureRunqlGitignoreEntries(workspaceFolder());
    expect(readFileAt('/workspace/.gitignore')).toBe(before);
  });

  it('pruneRunqlGitignoreEntries removes RunQL-owned lines, preserving unrelated content', async () => {
    writeFileAt(
      '/workspace/.gitignore',
      encoder.encode(
        [
          '# Existing',
          'node_modules/',
          '',
          '# RunQL machine-local markers',
          '.runql-link/',
          'README_RUNQL.md',
          '',
          'coverage/',
          '',
        ].join('\n')
      )
    );
    await pruneRunqlGitignoreEntries(workspaceFolder());
    const content = readFileAt('/workspace/.gitignore');
    expect(content).toContain('node_modules/');
    expect(content).toContain('coverage/');
    expect(content).not.toContain('.runql-link/');
    expect(content).not.toContain('README_RUNQL.md');
    expect(content).not.toContain('# RunQL machine-local markers');
  });

  // ---- skip marker cleanup ----------------------------------------------

  it('clearStorageLinkSkipMarker removes the skip marker when present', async () => {
    writeFileAt('/workspace/.runql-link/skip.json', encoder.encode('{}'));
    expect(fileExistsAt('/workspace/.runql-link/skip.json')).toBe(true);
    await clearStorageLinkSkipMarker(workspaceFolder());
    expect(fileExistsAt('/workspace/.runql-link/skip.json')).toBe(false);
  });

  // ---- removeRunqlLinkFolder --------------------------------------------

  it('removeRunqlLinkFolder deletes the folder when it only contains RunQL-owned files', async () => {
    writeFileAt('/workspace/.runql-link/storage-root.json', encoder.encode('{}'));
    writeFileAt('/workspace/.runql-link/ref.json', encoder.encode('{}'));
    const removed = await removeRunqlLinkFolder(workspaceFolder());
    expect(removed).toBe(true);
    expect(fileExistsAt('/workspace/.runql-link/storage-root.json')).toBe(false);
    expect(fileExistsAt('/workspace/.runql-link')).toBe(false);
  });

  it('removeRunqlLinkFolder refuses to delete when unexpected files are present', async () => {
    writeFileAt('/workspace/.runql-link/storage-root.json', encoder.encode('{}'));
    writeFileAt('/workspace/.runql-link/custom-user-file.txt', encoder.encode('keep me'));
    const removed = await removeRunqlLinkFolder(workspaceFolder());
    expect(removed).toBe(false);
    expect(fileExistsAt('/workspace/.runql-link/custom-user-file.txt')).toBe(true);
    expect(fileExistsAt('/workspace/.runql-link/storage-root.json')).toBe(true);
  });

  it('removeRunqlLinkFolder is a no-op when the folder is absent', async () => {
    const removed = await removeRunqlLinkFolder(workspaceFolder());
    expect(removed).toBe(true);
  });

  // ---- markers land in .runql-link/ ------------------------------------

  it('writeStorageRootMarker and writeRunqlRef both live under .runql-link/', async () => {
    const rootUri = await writeStorageRootMarker(workspaceFolder(), userRoot(), '2026-01-01T00:00:00.000Z');
    const refUri = await writeRunqlRef(workspaceFolder(), userRoot(), '2026-01-01T00:00:00.000Z');
    expect(rootUri.path).toBe('/workspace/.runql-link/storage-root.json');
    expect(refUri.path).toBe('/workspace/.runql-link/ref.json');
    expect(fileExistsAt('/workspace/RunQL/system/storage-root.json')).toBe(false);
    expect(fileExistsAt('/workspace/.runql-ref.json')).toBe(false);
  });

  // ---- Marker version guard (R6) ----------------------------------------

  it('writeStorageRootMarker refuses to overwrite a marker with an unsupported newer version', async () => {
    const futureMarker = JSON.stringify({
      version: '0.9',
      storageLocation: 'user',
      runqlRoot: '/user-runql',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      newField: 'preserved',
    });
    writeFileAt('/workspace/.runql-link/storage-root.json', encoder.encode(futureMarker));
    await writeStorageRootMarker(workspaceFolder(), userRoot(), '2026-06-01T00:00:00.000Z');
    // Content untouched
    expect(readFileAt('/workspace/.runql-link/storage-root.json')).toBe(futureMarker);
  });

  it('writeRunqlRef refuses to overwrite a ref with an unsupported newer version', async () => {
    const futureRef = JSON.stringify({
      version: '0.9',
      storageLocation: 'user',
      runqlRoot: '/user-runql',
      queriesPath: '/user-runql/queries',
      schemasPath: '/user-runql/schemas',
      connectionsProfilePath: '/user-runql/system/connections.json',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      secrets: 'noted',
      newField: 'preserved',
    });
    writeFileAt('/workspace/.runql-link/ref.json', encoder.encode(futureRef));
    await writeRunqlRef(workspaceFolder(), userRoot(), '2026-06-01T00:00:00.000Z');
    expect(readFileAt('/workspace/.runql-link/ref.json')).toBe(futureRef);
  });

  // ---- Gitignore header only stripped when RunQL lines removed (R13) ----

  it('pruneRunqlGitignoreEntries leaves a coincidental "# RunQL machine-local markers" comment alone when no RunQL entries are present', async () => {
    writeFileAt(
      '/workspace/.gitignore',
      encoder.encode(
        [
          'node_modules/',
          '',
          '# RunQL machine-local markers',
          '# (see notes/README)',
          '',
        ].join('\n')
      )
    );
    await pruneRunqlGitignoreEntries(workspaceFolder());
    const content = readFileAt('/workspace/.gitignore');
    expect(content).toContain('# RunQL machine-local markers');
    expect(content).toContain('node_modules/');
  });
});

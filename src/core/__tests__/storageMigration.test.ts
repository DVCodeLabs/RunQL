import * as vscode from 'vscode';
import {
  runStorageChangeFlow,
  pruneMigrationBackups,
  pruneExpiredStorageChangeLock,
  acquireStorageChangeLock,
  releaseStorageChangeLock,
  looksLikeRunqlRoot,
  hasRunqlData,
  isSafeToDeleteRoot,
  suppressAutoMigration,
  isAutoMigrationSuppressed,
  executeStorageChangeAction,
} from '../storageMigration';
import type { RunQLStorageRoot } from '../storageRoot';

type Entry = { kind: 'dir' } | { kind: 'file'; bytes: Uint8Array };

const fsMap = new Map<string, Entry>();
const encoder = new TextEncoder();

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

function fileExistsAt(p: string): boolean {
  return fsMap.has(norm(p));
}

function listPaths(): string[] {
  return Array.from(fsMap.keys()).sort();
}

function configureFs(): void {
  (vscode.workspace.workspaceFolders as unknown) = [];
  (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
    get: jest.fn((_key: string, fallback: unknown) => fallback),
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
  (vscode.workspace.fs.rename as jest.Mock).mockImplementation(
    async (
      src: vscode.Uri,
      dst: vscode.Uri,
      options?: { overwrite?: boolean }
    ) => {
      const srcPath = norm(src.path);
      const dstPath = norm(dst.path);
      const srcEntry = fsMap.get(srcPath);
      if (!srcEntry) throw new Error(`ENOENT ${src.path}`);
      if (fsMap.has(dstPath) && !options?.overwrite) {
        const err = new Error(`EEXIST ${dst.path}`);
        (err as unknown as { code: string }).code = 'EEXIST';
        throw err;
      }
      fsMap.set(dstPath, srcEntry);
      fsMap.delete(srcPath);
    }
  );
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

function seedSource(root: string): void {
  ensureDir(root);
  writeFileAt(`${root}/queries/foo.sql`, encoder.encode('select 1'));
  writeFileAt(`${root}/schemas/manifest.json`, encoder.encode('{}'));
  writeFileAt(`${root}/system/connections.json`, encoder.encode('{}'));
}

describe('storageMigration', () => {
  beforeEach(() => {
    fsMap.clear();
    configureFs();
    (vscode.window.showInformationMessage as jest.Mock).mockReset();
    (vscode.window.showWarningMessage as jest.Mock).mockReset();
  });

  // ---- helpers -----------------------------------------------------------

  it('looksLikeRunqlRoot recognizes a root with expected subfolders', async () => {
    seedSource('/old-root');
    expect(await looksLikeRunqlRoot(vscode.Uri.file('/old-root'))).toBe(true);
    expect(await looksLikeRunqlRoot(vscode.Uri.file('/nowhere'))).toBe(false);
  });

  it('hasRunqlData is false for empty / missing dirs and true for populated', async () => {
    expect(await hasRunqlData(vscode.Uri.file('/empty'))).toBe(false);
    seedSource('/populated');
    expect(await hasRunqlData(vscode.Uri.file('/populated'))).toBe(true);
  });

  it('hasRunqlData is false for an empty scaffold (queries/, schemas/, system/ with no files)', async () => {
    // Reproduce the false-positive that broke "Use existing at new
    // location" — the destination had empty scaffold directories from a
    // prior Initialize but no actual data files. Old logic returned
    // true, routing to the conflict flow.
    ensureDir('/scaffold/queries');
    ensureDir('/scaffold/schemas');
    ensureDir('/scaffold/system');
    ensureDir('/scaffold/system/queries');
    ensureDir('/scaffold/system/prompts');
    expect(await hasRunqlData(vscode.Uri.file('/scaffold'))).toBe(false);
  });

  it('hasRunqlData is true when only system/connections.json exists', async () => {
    ensureDir('/connections-only/queries');
    ensureDir('/connections-only/schemas');
    writeFileAt(
      '/connections-only/system/connections.json',
      encoder.encode('{"connections":[]}')
    );
    expect(await hasRunqlData(vscode.Uri.file('/connections-only'))).toBe(true);
  });

  it('hasRunqlData is FALSE when queries/ alone has files (R11 — could be dbt/prisma)', async () => {
    // R11 refined hasRunqlData to require RunQL-specific signals so a
    // user-picked path that happens to contain `queries/` from an
    // unrelated tool doesn't trigger a false "both populated" prompt.
    writeFileAt('/queries-only/queries/foo.sql', encoder.encode('select 1'));
    expect(await hasRunqlData(vscode.Uri.file('/queries-only'))).toBe(false);
  });

  it('hasRunqlData is true when system/queries/queryIndex.json exists', async () => {
    writeFileAt(
      '/index-only/system/queries/queryIndex.json',
      encoder.encode('{"version":"0.1","queries":[]}')
    );
    expect(await hasRunqlData(vscode.Uri.file('/index-only'))).toBe(true);
  });

  it('hasRunqlData is true when system/queries/queryHistory.json exists', async () => {
    writeFileAt(
      '/history-only/system/queries/queryHistory.json',
      encoder.encode('[]')
    );
    expect(await hasRunqlData(vscode.Uri.file('/history-only'))).toBe(true);
  });

  it('hasRunqlData recognizes schemas/<connection>/manifest.json (RunQL-specific)', async () => {
    writeFileAt(
      '/schemas-only/schemas/Analytics/manifest.json',
      encoder.encode('{}')
    );
    expect(await hasRunqlData(vscode.Uri.file('/schemas-only'))).toBe(true);
  });

  it('hasRunqlData is FALSE when schemas/ has files without a per-connection manifest.json', async () => {
    // A `schema.json` isn't a RunQL-specific filename; RunQL requires
    // `<connection>/manifest.json` to consider it a bundle.
    writeFileAt(
      '/nested2/schemas/Analytics/public/schema.json',
      encoder.encode('{}')
    );
    expect(await hasRunqlData(vscode.Uri.file('/nested2'))).toBe(false);
  });

  it('isSafeToDeleteRoot rejects unsafe roots', () => {
    expect(isSafeToDeleteRoot(vscode.Uri.file('/'))).toBe(false);
    (vscode.workspace.workspaceFolders as unknown) = [
      { uri: vscode.Uri.file('/proj'), name: 'proj', index: 0 },
    ];
    expect(isSafeToDeleteRoot(vscode.Uri.file('/proj'))).toBe(false);
    expect(isSafeToDeleteRoot(vscode.Uri.file('/proj/RunQL'))).toBe(true);
  });

  // ---- prompt lock ------------------------------------------------------

  it('acquireStorageChangeLock returns undefined when a fresh lock owned by another window exists', async () => {
    const host = makeRoot('/host');
    ensureDir('/host/system');
    // Simulate an existing lock from another window
    const existing = {
      version: '0.1',
      oldRoot: '/a',
      newRoot: '/b',
      windowId: 'other-window',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    writeFileAt('/host/system/storage-change.lock.json', encoder.encode(JSON.stringify(existing)));

    const attempt = await acquireStorageChangeLock(host, '/a', '/b');
    expect(attempt).toBeUndefined();
  });

  it('acquireStorageChangeLock replaces an expired lock', async () => {
    const host = makeRoot('/host');
    ensureDir('/host/system');
    const expired = {
      version: '0.1',
      oldRoot: '/a',
      newRoot: '/b',
      windowId: 'other-window',
      createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      expiresAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    };
    writeFileAt('/host/system/storage-change.lock.json', encoder.encode(JSON.stringify(expired)));

    const uri = await acquireStorageChangeLock(host, '/a', '/b');
    expect(uri).toBeDefined();
    await releaseStorageChangeLock(uri);
    // Lock file should be gone after release.
    expect(fileExistsAt('/host/system/storage-change.lock.json')).toBe(false);
  });

  // ---- flows -----------------------------------------------------------

  it('empty-destination Move copies + verifies + deletes source with backup', async () => {
    seedSource('/old');
    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValueOnce('Move');

    const outcome = await runStorageChangeFlow({
      previousRoot: makeRoot('/old'),
      nextRoot: makeRoot('/new'),
      trigger: 'command',
    });

    expect(outcome).toBe('moved');
    expect(fileExistsAt('/new/queries/foo.sql')).toBe(true);
    expect(fileExistsAt('/new/schemas/manifest.json')).toBe(true);
    expect(fileExistsAt('/new/system/connections.json')).toBe(true);
    expect(fileExistsAt('/old/queries/foo.sql')).toBe(false);
    // Backup was written under /new/system/migration_backup/storage-root-<ts>/
    const backupSlot = listPaths().find((p) => /^\/new\/system\/migration_backup\/storage-root-.+\/queries\/foo\.sql$/.test(p));
    expect(backupSlot).toBeDefined();
  });

  it('executeStorageChangeAction move deletes the source even when the resolver still points at it (settings-change-later path)', async () => {
    // Reproduces the bug the reorder introduced: the command flow runs
    // executeStorageChangeAction BEFORE updating settings, so
    // tryResolveRunQLRoot() still points at previousRoot at delete
    // time. The move must still delete the source — the safety guards
    // (looksLikeRunqlRoot + isSafeToDeleteRoot) protect against
    // wrong-thing deletion; the stale `authoritativeDiffers` check was
    // removed.
    //
    // Configure the resolver mock to actively return `previousRoot` so
    // the (removed) `authoritativeDiffers` guard would have been FALSE
    // for this call — that way if someone reintroduces the guard, this
    // test catches it. Without this config, the default mock's
    // resolver returns undefined and `authoritativeDiffers` would be
    // trivially TRUE, making the test toothless.
    seedSource('/legacy-custom');
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
      get: jest.fn((k: string, fb: unknown) => {
        if (k === 'location') return 'user';
        if (k === 'userPath') return '/legacy-custom';
        if (k === 'codespacesPath') return '/workspaces/.runql';
        if (k === 'customPath') return '';
        if (k === 'workspaceFolder') return '';
        return fb;
      }),
      has: jest.fn().mockReturnValue(true),
      inspect: jest.fn(),
      update: jest.fn(),
    }));

    const outcome = await executeStorageChangeAction(
      { previousRoot: makeRoot('/legacy-custom'), nextRoot: makeRoot('/new-workspace-runql') },
      'move'
    );

    expect(outcome).toBe('moved');
    expect(fileExistsAt('/new-workspace-runql/queries/foo.sql')).toBe(true);
    expect(fileExistsAt('/legacy-custom/queries/foo.sql')).toBe(false);
    expect(fileExistsAt('/legacy-custom')).toBe(false);
  });

  it('empty-destination Copy leaves source intact', async () => {
    seedSource('/old');
    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValueOnce('Copy');

    const outcome = await runStorageChangeFlow({
      previousRoot: makeRoot('/old'),
      nextRoot: makeRoot('/new'),
      trigger: 'command',
    });

    expect(outcome).toBe('copied');
    expect(fileExistsAt('/new/queries/foo.sql')).toBe(true);
    expect(fileExistsAt('/old/queries/foo.sql')).toBe(true);
  });

  it('empty-destination Start empty creates the standard subfolders and skips the copy', async () => {
    seedSource('/old');
    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValueOnce(
      'Start empty at new location'
    );

    const outcome = await runStorageChangeFlow({
      previousRoot: makeRoot('/old'),
      nextRoot: makeRoot('/new'),
      trigger: 'command',
    });

    expect(outcome).toBe('started-empty');
    // Source untouched
    expect(fileExistsAt('/old/queries/foo.sql')).toBe(true);
    // Destination has empty tree
    expect(fileExistsAt('/new/queries')).toBe(true);
    expect(fileExistsAt('/new/schemas')).toBe(true);
    expect(fileExistsAt('/new/system/queries')).toBe(true);
    expect(fileExistsAt('/new/queries/foo.sql')).toBe(false);
  });

  it('cancel invokes revertSetting and returns cancelled', async () => {
    seedSource('/old');
    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValueOnce(undefined);
    const revert = jest.fn().mockResolvedValue(undefined);
    const outcome = await runStorageChangeFlow({
      previousRoot: makeRoot('/old'),
      nextRoot: makeRoot('/new'),
      trigger: 'command',
      revertSetting: revert,
    });
    expect(outcome).toBe('cancelled');
    expect(revert).toHaveBeenCalled();
  });

  it('conflict flow (both source & dest populated) offers replace-after-backup', async () => {
    seedSource('/old');
    seedSource('/new');
    writeFileAt('/new/queries/existing.sql', encoder.encode('-- kept only in backup'));

    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValueOnce(
      'Replace existing at new location (backup is run first)'
    );

    const outcome = await runStorageChangeFlow({
      previousRoot: makeRoot('/old'),
      nextRoot: makeRoot('/new'),
      trigger: 'command',
    });

    expect(outcome).toBe('replaced');
    expect(fileExistsAt('/new/queries/foo.sql')).toBe(true);
    // The destination-only file no longer lives at the destination…
    expect(fileExistsAt('/new/queries/existing.sql')).toBe(false);
    // …but survives in a backup slot inside the source (safe from the
    // destructive replace on the destination).
    const backupHit = listPaths().find((p) => /^\/old\/system\/migration_backup\/storage-root-.+\/queries\/existing\.sql$/.test(p));
    expect(backupHit).toBeDefined();
  });

  it('no-op when source has no data', async () => {
    const outcome = await runStorageChangeFlow({
      previousRoot: makeRoot('/empty-src'),
      nextRoot: makeRoot('/dest'),
      trigger: 'command',
    });
    expect(outcome).toBe('no-source-data');
  });

  // ---- pruning ---------------------------------------------------------

  it('pruneMigrationBackups keeps the newest 5 and any within 30 days', async () => {
    const root = makeRoot('/root');
    const now = Date.now();
    const oldMs = now - 60 * 24 * 60 * 60_000; // 60 days old
    const recentMs = now - 5 * 24 * 60 * 60_000; // 5 days old

    const stamp = (ms: number) => new Date(ms).toISOString().replace(/[:.]/g, '-');
    // 6 old backups (>30 days) — only newest 5 kept by count; the 6th is
    // pruned because it's both outside top-5 and >30 days old.
    for (let i = 0; i < 6; i++) {
      const name = `storage-root-${stamp(oldMs - i * 60_000)}`;
      writeFileAt(`/root/system/migration_backup/${name}/marker`, encoder.encode(''));
    }
    // 2 recent backups (<30 days) — both kept by retention window.
    for (let i = 0; i < 2; i++) {
      const name = `storage-root-${stamp(recentMs - i * 60_000)}`;
      writeFileAt(`/root/system/migration_backup/${name}/marker`, encoder.encode(''));
    }
    // An unrelated file that must never be pruned.
    writeFileAt('/root/system/migration_backup/keep-me.txt', encoder.encode('unrelated'));

    const { pruned } = await pruneMigrationBackups(root);
    // With 8 total (6 old + 2 recent), the top-5 by mtime keeps 2 recent +
    // 3 old; the remaining 3 old backups are >30 days out, so they get
    // pruned.
    expect(pruned).toHaveLength(3);
    // Unrelated file untouched.
    expect(fileExistsAt('/root/system/migration_backup/keep-me.txt')).toBe(true);
  });

  // ---- Expired-lock pruning (R9) --------------------------------------

  it('pruneExpiredStorageChangeLock deletes locks whose expiresAt is in the past', async () => {
    const root = makeRoot('/root');
    const expired = {
      version: '0.1',
      oldRoot: '/a',
      newRoot: '/b',
      windowId: 'other-window',
      createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      expiresAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    };
    writeFileAt(
      '/root/system/storage-change.lock.json',
      encoder.encode(JSON.stringify(expired))
    );
    const removed = await pruneExpiredStorageChangeLock(root);
    expect(removed).toBe(true);
    expect(fileExistsAt('/root/system/storage-change.lock.json')).toBe(false);
  });

  it('pruneExpiredStorageChangeLock leaves an active lock alone', async () => {
    const root = makeRoot('/root');
    const active = {
      version: '0.1',
      oldRoot: '/a',
      newRoot: '/b',
      windowId: 'other-window',
      createdAt: new Date(Date.now()).toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    };
    writeFileAt(
      '/root/system/storage-change.lock.json',
      encoder.encode(JSON.stringify(active))
    );
    const removed = await pruneExpiredStorageChangeLock(root);
    expect(removed).toBe(false);
    expect(fileExistsAt('/root/system/storage-change.lock.json')).toBe(true);
  });

  it('pruneExpiredStorageChangeLock is a no-op when no lock file exists', async () => {
    const root = makeRoot('/root');
    expect(await pruneExpiredStorageChangeLock(root)).toBe(false);
  });

  // ---- suppressAutoMigration guard (double-prompt on cancel) ----------

  it('suppressAutoMigration is a nestable depth counter', () => {
    expect(isAutoMigrationSuppressed()).toBe(false);
    const releaseA = suppressAutoMigration();
    expect(isAutoMigrationSuppressed()).toBe(true);
    const releaseB = suppressAutoMigration();
    expect(isAutoMigrationSuppressed()).toBe(true);
    releaseA();
    // Still suppressed because releaseB hasn't run.
    expect(isAutoMigrationSuppressed()).toBe(true);
    releaseB();
    expect(isAutoMigrationSuppressed()).toBe(false);
  });

  it('suppressAutoMigration release is idempotent', () => {
    const release = suppressAutoMigration();
    expect(isAutoMigrationSuppressed()).toBe(true);
    release();
    release(); // second call must not go negative
    expect(isAutoMigrationSuppressed()).toBe(false);
  });

  // ---- AGENTS.md refresh after storage-change flow (R2) ----------------

  it('runStorageChangeFlow refreshes AGENTS.md in linked workspace folders (skips unlinked)', async () => {
    seedSource('/old');
    (vscode.workspace.workspaceFolders as unknown) = [
      { uri: vscode.Uri.file('/proj'), name: 'proj', index: 0 },
    ];
    // Existing AGENTS.md with a stale RunQL section that mentions the OLD root.
    writeFileAt(
      '/proj/AGENTS.md',
      encoder.encode(
        `# My Project\n\n<!-- RUNQL:BEGIN -->\n# RunQL Context\n\nRunQL storage root:\n\n/old\n<!-- RUNQL:END -->\n`
      )
    );
    // Seed the link marker so findLinkedFolders (R2 filter) considers
    // /proj linked to the current storage root.
    writeFileAt(
      '/proj/.runql-link/storage-root.json',
      encoder.encode(JSON.stringify({
        version: '0.1',
        storageLocation: 'user',
        runqlRoot: '/new',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }))
    );
    // Point the resolver at /new so the refresh writes /new into the section.
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
      get: jest.fn((k: string, fb: unknown) => {
        if (k === 'location') return 'user';
        if (k === 'userPath') return '/new';
        if (k === 'customPath') return '';
        if (k === 'codespacesPath') return '/workspaces/.runql';
        if (k === 'workspaceFolder') return '';
        return fb;
      }),
      has: jest.fn().mockReturnValue(true),
      inspect: jest.fn(),
      update: jest.fn(),
    }));
    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValueOnce('Copy');

    await runStorageChangeFlow({
      previousRoot: makeRoot('/old'),
      nextRoot: makeRoot('/new'),
      trigger: 'command',
    });

    const agents = new TextDecoder().decode(fsMap.get('/proj/AGENTS.md')!.kind === 'file' ? (fsMap.get('/proj/AGENTS.md') as { bytes: Uint8Array }).bytes : new Uint8Array());
    // Bounded section updated to the new root, preamble preserved.
    expect(agents).toContain('# My Project');
    expect(agents).toContain('<!-- RUNQL:BEGIN -->');
    expect(agents).toContain('/new');
    expect(agents).not.toContain('storage root:\n\n/old');
  });
});

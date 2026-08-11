import * as vscode from 'vscode';
import {
  loadConnectionProfiles,
  saveConnectionProfile,
  initConnectionStore,
  deleteConnection,
} from '../connectionStore';
import type { ConnectionProfile } from '../../core/types';

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

function configureFs(): void {
  (vscode.workspace.workspaceFolders as unknown) = [
    { uri: vscode.Uri.file('/workspace'), name: 'workspace', index: 0 },
  ];
  (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
    get: jest.fn((key: string, fallback: unknown) => {
      if (key === 'location') return 'workspace';
      if (key === 'userPath') return '~/.runql';
      if (key === 'codespacesPath') return '/workspaces/.runql';
      if (key === 'customPath') return '';
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
  (vscode.workspace.fs.delete as jest.Mock).mockImplementation(async (uri: vscode.Uri) => {
    fsMap.delete(norm(uri.path));
  });
}

function makeProfile(overrides: Partial<ConnectionProfile>): ConnectionProfile {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: overrides.id ?? 'p-1',
    name: overrides.name ?? 'Prod',
    dialect: 'postgres',
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    ...overrides,
  } as ConnectionProfile;
}

function seedConnectionsFile(profiles: ConnectionProfile[]): void {
  const payload = {
    version: '0.1',
    generatedAt: '2026-01-01T00:00:00.000Z',
    connections: profiles,
  };
  writeFileAt(
    '/workspace/RunQL/system/connections.json',
    encoder.encode(JSON.stringify(payload, null, 2))
  );
}

function loadConnectionsFile(): ConnectionProfile[] {
  const parsed = JSON.parse(readFileAt('/workspace/RunQL/system/connections.json'));
  return parsed.connections as ConnectionProfile[];
}

const fakeContext = {
  secrets: {
    get: jest.fn(),
    store: jest.fn(),
    delete: jest.fn(),
    onDidChange: jest.fn(),
  },
} as unknown as vscode.ExtensionContext;

describe('connections.json optimistic concurrency', () => {
  beforeEach(() => {
    fsMap.clear();
    configureFs();
    initConnectionStore(fakeContext);
    (vscode.window.showWarningMessage as jest.Mock).mockReset();
  });

  it('preserves unrelated connections added by another window during a save', async () => {
    // Window A loaded this initial state.
    const initial = makeProfile({ id: 'p-1', name: 'Prod' });
    seedConnectionsFile([initial]);
    const loaded = await loadConnectionProfiles();
    expect(loaded).toHaveLength(1);

    // Window B adds a second connection while A holds its edit in memory.
    seedConnectionsFile([initial, makeProfile({ id: 'p-2', name: 'Staging' })]);

    // Window A now saves an edit of p-1 with its pre-B baseline.
    const edited = { ...initial, host: 'db.example.com' };
    await saveConnectionProfile(edited);

    const disk = loadConnectionsFile();
    const ids = disk.map((c) => c.id).sort();
    expect(ids).toEqual(['p-1', 'p-2']);
    expect(disk.find((c) => c.id === 'p-1')?.host).toBe('db.example.com');
    expect(disk.find((c) => c.id === 'p-2')?.name).toBe('Staging');
  });

  it('surfaces a conflict prompt when the same connection was modified in another window', async () => {
    // Window A's baseline
    const baseline = makeProfile({ id: 'p-1', name: 'Prod', updatedAt: '2026-01-01T00:00:00.000Z' });
    seedConnectionsFile([baseline]);
    const loaded = await loadConnectionProfiles();
    const inMemory = loaded[0];

    // Window B updated the same id after A loaded.
    const laterFromB = makeProfile({
      id: 'p-1',
      name: 'Prod',
      host: 'other.example.com',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    seedConnectionsFile([laterFromB]);

    // User picks "Cancel" on the conflict prompt. Modal dialogs
    // auto-add a Cancel button that resolves to undefined; we no
    // longer list an explicit 'Cancel' action (that showed twice).
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce(undefined);
    await expect(
      saveConnectionProfile({ ...inMemory, host: 'a.example.com' })
    ).rejects.toThrow(/cancel/i);
    const warnMock = vscode.window.showWarningMessage as jest.Mock;
    expect(warnMock).toHaveBeenCalled();
    // Regression guard: the action list must NOT contain a literal
    // 'Cancel' — the modal already provides one.
    const actionArgs = warnMock.mock.calls[0].slice(2);
    expect(actionArgs).not.toContain('Cancel');

    // Disk kept window B's version untouched.
    expect(loadConnectionsFile()[0].host).toBe('other.example.com');
  });

  it('keep-disk-version returns without overwriting disk', async () => {
    const baseline = makeProfile({ id: 'p-1', name: 'Prod', updatedAt: '2026-01-01T00:00:00.000Z' });
    seedConnectionsFile([baseline]);
    const [inMemory] = await loadConnectionProfiles();
    seedConnectionsFile([
      makeProfile({ id: 'p-1', name: 'Prod', host: 'disk.example.com', updatedAt: '2026-01-02T00:00:00.000Z' }),
    ]);

    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Keep Disk Version');
    await saveConnectionProfile({ ...inMemory, host: 'ignored.example.com' });

    expect(loadConnectionsFile()[0].host).toBe('disk.example.com');
  });

  it('delete reloads before writing so a concurrent add survives', async () => {
    const a = makeProfile({ id: 'p-1', name: 'Prod' });
    const b = makeProfile({ id: 'p-2', name: 'Staging' });
    seedConnectionsFile([a]);
    await loadConnectionProfiles();
    seedConnectionsFile([a, b]);

    await deleteConnection('p-1');

    const disk = loadConnectionsFile();
    expect(disk.map((c) => c.id)).toEqual(['p-2']);
  });

  // ---- P2-M8: coverage for the highest-risk concurrency paths ----

  it('prompts on save when the in-memory profile has no baselineUpdatedAt (pre-1.16 profiles)', async () => {
    // Simulate a legacy profile that never had `updatedAt`. Previous
    // logic gated the conflict prompt on `if (diskProfile && baselineUpdatedAt)`
    // so this scenario silently overwrote — which is exactly the data-
    // loss path R7 fixed.
    const diskLegacy = makeProfile({ id: 'p-1', name: 'Prod', host: 'disk.example.com' });
    // Remove updatedAt from both sides to simulate the pre-1.16 shape.
    delete (diskLegacy as Partial<ConnectionProfile>).updatedAt;
    seedConnectionsFile([diskLegacy]);
    const inMemory = { ...makeProfile({ id: 'p-1', name: 'Prod' }) };
    delete (inMemory as Partial<ConnectionProfile>).updatedAt;

    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce(undefined);
    await expect(
      saveConnectionProfile({ ...inMemory, host: 'ours.example.com' })
    ).rejects.toThrow(/cancel/i);
    // Prompt did fire — no silent overwrite.
    expect(vscode.window.showWarningMessage as jest.Mock).toHaveBeenCalled();
  });

  it('Keep Current Window Version overwrites the disk with the in-memory profile', async () => {
    // The destructive branch: user actively chose to blow away the
    // disk-side change. Verify the resulting on-disk record is exactly
    // our in-memory version with a fresh `updatedAt`, not a mistaken
    // merge or a stale field bleed from the disk record.
    const baseline = makeProfile({
      id: 'p-1',
      name: 'Prod',
      host: 'old.example.com',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    seedConnectionsFile([baseline]);
    const [inMemory] = await loadConnectionProfiles();
    // Another window modified the same id AFTER we loaded.
    seedConnectionsFile([
      makeProfile({
        id: 'p-1',
        name: 'Prod',
        host: 'disk.example.com',
        updatedAt: '2026-01-02T00:00:00.000Z',
      }),
    ]);

    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce(
      'Keep Current Window Version'
    );
    await saveConnectionProfile({ ...inMemory, host: 'ours.example.com' });

    const disk = loadConnectionsFile();
    expect(disk).toHaveLength(1);
    expect(disk[0].id).toBe('p-1');
    expect(disk[0].host).toBe('ours.example.com');
    // updatedAt was bumped by the save (strictly later than baseline's
    // updatedAt) — not left at the disk's older or newer value.
    expect(
      Date.parse(disk[0].updatedAt ?? '') > Date.parse('2026-01-01T00:00:00.000Z')
    ).toBe(true);
  });

  it("advances the caller's baseline `updatedAt` after a successful save", async () => {
    // If the caller keeps saving from the same in-memory reference
    // (e.g. the SecureQL adapter's fire-and-forget `persistProfile`
    // after `refreshSecureQLApprovalPolicyForRun` already saved),
    // the caller's `updatedAt` must match what we just wrote to
    // disk. Otherwise our own last write looks like a foreign edit
    // to the next save and triggers a spurious conflict prompt.
    const original = makeProfile({
      id: 'p-1',
      name: 'Prod',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    seedConnectionsFile([original]);
    const [inMemory] = await loadConnectionProfiles();
    const before = inMemory.updatedAt;

    const edited = { ...inMemory, host: 'new.example.com' };
    await saveConnectionProfile(edited);

    // Save advanced the caller's baseline to the freshly written
    // timestamp — strictly newer than before, and matching what's
    // now on disk.
    expect(edited.updatedAt).not.toBe(before);
    expect(Date.parse(edited.updatedAt!) > Date.parse(before!)).toBe(true);
    const disk = loadConnectionsFile();
    expect(disk[0].updatedAt).toBe(edited.updatedAt);

    // A second save from the same in-memory profile must NOT
    // trigger a conflict prompt, since disk was only bumped by us.
    (vscode.window.showWarningMessage as jest.Mock).mockClear();
    await saveConnectionProfile({ ...edited, host: 'newer.example.com' });
    expect(vscode.window.showWarningMessage as jest.Mock).not.toHaveBeenCalled();
    expect(loadConnectionsFile()[0].host).toBe('newer.example.com');
  });
});

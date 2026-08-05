import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  expandTilde,
  isCodespaces,
  resolveRunQLRoot,
  tryResolveRunQLRoot,
  validateCustomPath,
  pickWorkspaceOwnerFolder,
  checkCustomPathWritable,
  resolveStoredPath,
  RunQLStorageError,
} from '../storageRoot';

interface ConfigState {
  location: 'workspace' | 'user' | 'custom';
  userPath: string;
  codespacesPath: string;
  customPath: string;
  workspaceFolder: string;
}

// `path.resolve` and `path.join` emit native separators — backslashes on
// Windows, forward slashes elsewhere. These tests care about semantic
// path equality, not the separator character. Normalize both sides
// before comparing so a single assertion works on both platforms.
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function setStorageConfig(state: Partial<ConfigState>): void {
  const full: ConfigState = {
    location: state.location ?? 'workspace',
    userPath: state.userPath ?? '~/.runql',
    codespacesPath: state.codespacesPath ?? '/workspaces/.runql',
    customPath: state.customPath ?? '',
    workspaceFolder: state.workspaceFolder ?? '',
  };
  (vscode.workspace.getConfiguration as jest.Mock).mockImplementation((section?: string) => {
    if (section === 'runql.storage') {
      return {
        get: jest.fn((key: string, fallback: unknown) => {
          const val = (full as unknown as Record<string, unknown>)[key];
          return val === undefined || val === null ? fallback : val;
        }),
        has: jest.fn().mockReturnValue(true),
        inspect: jest.fn(),
        update: jest.fn(),
      };
    }
    return {
      get: jest.fn(),
      has: jest.fn(),
      inspect: jest.fn(),
      update: jest.fn(),
    };
  });
}

function setWorkspaceFolders(paths: string[]): void {
  (vscode.workspace.workspaceFolders as unknown) = paths.map((p) => ({
    uri: vscode.Uri.file(p),
    name: p.split('/').pop() ?? p,
    index: 0,
  }));
}

const ORIGINAL_CODESPACES = process.env.CODESPACES;

describe('storageRoot', () => {
  beforeEach(() => {
    setStorageConfig({});
    setWorkspaceFolders([]);
    delete process.env.CODESPACES;
  });

  afterAll(() => {
    if (ORIGINAL_CODESPACES === undefined) delete process.env.CODESPACES;
    else process.env.CODESPACES = ORIGINAL_CODESPACES;
  });

  describe('expandTilde', () => {
    it('returns empty input unchanged', () => {
      expect(expandTilde('')).toBe('');
    });
    it('expands "~" to os.homedir()', () => {
      expect(expandTilde('~')).toBe(os.homedir());
    });
    it('expands "~/foo" to <home>/foo', () => {
      expect(expandTilde('~/foo')).toContain(os.homedir());
      expect(expandTilde('~/foo').endsWith('foo')).toBe(true);
    });
    it('leaves non-tilde absolute paths alone', () => {
      expect(expandTilde('/absolute/path')).toBe('/absolute/path');
    });
  });

  describe('isCodespaces', () => {
    it('is false when CODESPACES is unset', () => {
      delete process.env.CODESPACES;
      expect(isCodespaces()).toBe(false);
    });
    it('is true when CODESPACES === "true"', () => {
      process.env.CODESPACES = 'true';
      expect(isCodespaces()).toBe(true);
    });
    it('is false for other truthy values', () => {
      process.env.CODESPACES = '1';
      expect(isCodespaces()).toBe(false);
    });
  });

  describe('workspace mode', () => {
    it('resolves to <workspace>/RunQL when a single folder is open', () => {
      setWorkspaceFolders(['/workspace']);
      const root = resolveRunQLRoot();
      expect(root.location).toBe('workspace');
      expect(root.uri.path).toBe('/workspace/RunQL');
      expect(root.isWorkspaceScoped).toBe(true);
    });

    it('throws no-workspace when no folder is open', () => {
      expect(() => resolveRunQLRoot()).toThrow(RunQLStorageError);
    });

    it('multi-root without persisted owner throws multi-root-owner-missing', () => {
      setWorkspaceFolders(['/a', '/b']);
      expect(() => resolveRunQLRoot()).toThrow(/Multi-root/);
    });

    it('multi-root with persisted owner returns that folder', () => {
      setWorkspaceFolders(['/a', '/b']);
      setStorageConfig({
        location: 'workspace',
        workspaceFolder: vscode.Uri.file('/b').toString(),
      });
      const owner = pickWorkspaceOwnerFolder();
      expect(owner?.uri.path).toBe('/b');
      const root = resolveRunQLRoot();
      expect(root.uri.path).toBe('/b/RunQL');
    });
  });

  describe('user mode', () => {
    it('resolves to expanded userPath on desktop', () => {
      setStorageConfig({ location: 'user', userPath: '~/.runql' });
      const root = resolveRunQLRoot();
      expect(root.location).toBe('user');
      expect(toPosix(root.uri.path)).toBe(toPosix(`${os.homedir()}/.runql`));
      expect(root.isWorkspaceScoped).toBe(false);
    });

    it('resolves to codespacesPath when CODESPACES=true', () => {
      process.env.CODESPACES = 'true';
      setStorageConfig({ location: 'user' });
      const root = resolveRunQLRoot();
      expect(toPosix(root.uri.path)).toBe('/workspaces/.runql');
      expect(root.isCodespaces).toBe(true);
    });
  });

  describe('custom mode', () => {
    it('rejects empty path', () => {
      setStorageConfig({ location: 'custom', customPath: '' });
      expect(() => resolveRunQLRoot()).toThrow(/Custom RunQL storage path/);
    });

    it('rejects a relative path', () => {
      const r = validateCustomPath('relative/path');
      expect(r.error).toBeDefined();
      expect(r.error?.code).toBe('invalid-custom-path');
    });

    it('rejects the filesystem root', () => {
      const r = validateCustomPath('/');
      expect(r.error?.code).toBe('unsafe-custom-path');
    });

    it('rejects Windows drive roots', () => {
      expect(validateCustomPath('C:\\').error?.code).toBe('unsafe-custom-path');
      expect(validateCustomPath('D:/').error?.code).toBe('unsafe-custom-path');
    });

    it("rejects the user's home directory", () => {
      const r = validateCustomPath(os.homedir());
      expect(r.error?.code).toBe('unsafe-custom-path');
    });

    it('rejects /workspaces in a Codespaces environment', () => {
      process.env.CODESPACES = 'true';
      const r = validateCustomPath('/workspaces');
      expect(r.error?.code).toBe('unsafe-custom-path');
    });

    it('rejects a workspace folder root', () => {
      setWorkspaceFolders(['/proj']);
      const r = validateCustomPath('/proj');
      expect(r.error?.code).toBe('unsafe-custom-path');
    });

    it('accepts a safe absolute path', () => {
      const r = validateCustomPath('/opt/runql-data');
      expect(r.error).toBeUndefined();
      expect(toPosix(r.fsPath!)).toBe('/opt/runql-data');
    });

    it('accepts an expanded tilde path', () => {
      const r = validateCustomPath('~/runql-data');
      expect(r.error).toBeUndefined();
      expect(toPosix(r.fsPath!)).toBe(toPosix(`${os.homedir()}/runql-data`));
    });

    it('resolveRunQLRoot returns the custom URI when valid', () => {
      setStorageConfig({ location: 'custom', customPath: '/opt/runql' });
      const root = resolveRunQLRoot();
      expect(root.location).toBe('custom');
      expect(toPosix(root.uri.path)).toBe('/opt/runql');
    });
  });

  describe('tryResolveRunQLRoot', () => {
    it('returns undefined on unresolvable settings', () => {
      // workspace mode with no folder open
      expect(tryResolveRunQLRoot()).toBeUndefined();
    });

    it('returns the root on valid settings', () => {
      setStorageConfig({ location: 'user' });
      expect(tryResolveRunQLRoot()?.location).toBe('user');
    });
  });

  describe('symlink resolution (R5)', () => {
    // Use real fs for these — the resolver's realpath call is a Node
    // sync call that ignores the vscode mock.
    let tmpBase: string;
    beforeEach(() => {
      tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'rq-symlink-'));
    });
    afterEach(() => {
      try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('rejects a symlink that resolves to the home directory', () => {
      const link = path.join(tmpBase, 'link-to-home');
      let symlinkable = true;
      try {
        fs.symlinkSync(os.homedir(), link, 'dir');
      } catch {
        symlinkable = false;
      }
      if (!symlinkable) {
        // The platform doesn't allow symlink creation (Windows without
        // dev-mode, restricted CI). Mark the test as skipped instead of
        // returning silently — a bare return counts as passing with
        // zero assertions and would hide a genuine break of the guard.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as unknown as { pending?: (msg: string) => void }).pending?.(
          'symlink creation not permitted on this platform'
        );
        return;
      }
      // Require the assertion below to actually run when we DID create
      // the symlink; catches "silently passed with 0 assertions" if the
      // code path ever short-circuits earlier.
      expect.assertions(1);
      const r = validateCustomPath(link);
      expect(r.error?.code).toBe('unsafe-custom-path');
    });
  });

  describe('checkCustomPathWritable (R4)', () => {
    // These tests hit the real filesystem via vscode.workspace.fs mocks.
    // For a proper writability probe we'd need real fs, but the mock's
    // createDirectory/writeFile succeed by default — good enough to
    // confirm the happy path routes through the check without throwing.
    it('returns undefined for a writable target (mock filesystem)', async () => {
      (vscode.workspace.fs.createDirectory as jest.Mock).mockResolvedValue(undefined);
      (vscode.workspace.fs.writeFile as jest.Mock).mockResolvedValue(undefined);
      (vscode.workspace.fs.delete as jest.Mock).mockResolvedValue(undefined);
      const err = await checkCustomPathWritable('/opt/runql-data');
      expect(err).toBeUndefined();
    });

    it('surfaces a RunQLStorageError when createDirectory fails', async () => {
      (vscode.workspace.fs.createDirectory as jest.Mock).mockRejectedValue(new Error('EACCES'));
      const err = await checkCustomPathWritable('/opt/runql-data');
      expect(err?.code).toBe('invalid-custom-path');
      expect(err?.message).toContain('EACCES');
    });

    it('surfaces a RunQLStorageError when writing a probe fails', async () => {
      (vscode.workspace.fs.createDirectory as jest.Mock).mockResolvedValue(undefined);
      (vscode.workspace.fs.writeFile as jest.Mock).mockRejectedValue(new Error('ENOSPC'));
      const err = await checkCustomPathWritable('/opt/runql-data');
      expect(err?.code).toBe('invalid-custom-path');
      expect(err?.message).toContain('ENOSPC');
    });
  });

  describe('resolveStoredPath path-traversal guard (R1)', () => {
    beforeEach(() => {
      setStorageConfig({ location: 'user', userPath: '/user-runql' });
      setWorkspaceFolders([]);
    });

    it('resolves legitimate root-relative paths', () => {
      const uri = resolveStoredPath('queries/Prod/foo.sql');
      expect(toPosix(uri!.path)).toBe('/user-runql/queries/Prod/foo.sql');
    });

    it('resolves legitimate legacy `RunQL/…` paths', () => {
      const uri = resolveStoredPath('RunQL/queries/Prod/foo.sql');
      expect(toPosix(uri!.path)).toBe('/user-runql/queries/Prod/foo.sql');
    });

    it('refuses paths containing `..` segments', () => {
      expect(resolveStoredPath('queries/../../../etc/passwd')).toBeUndefined();
      expect(resolveStoredPath('queries/foo/../../../evil.sql')).toBeUndefined();
      expect(resolveStoredPath('RunQL/queries/../../../etc/passwd')).toBeUndefined();
      expect(resolveStoredPath('..')).toBeUndefined();
      expect(resolveStoredPath('../etc/passwd')).toBeUndefined();
    });

    it('refuses `..` in workspace-relative fallback paths too', () => {
      setWorkspaceFolders(['/workspace']);
      expect(resolveStoredPath('../etc/passwd')).toBeUndefined();
      expect(resolveStoredPath('some/dir/../../../evil.sql')).toBeUndefined();
    });
  });
});

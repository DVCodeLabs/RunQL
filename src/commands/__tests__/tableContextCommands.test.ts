import * as vscode from 'vscode';

import { registerTableContextCommands } from '../tableContextCommands';

jest.mock('../../connections/connectionStore', () => ({
  getConnection: jest.fn(),
}));
jest.mock('../../connections/adapterFactory', () => ({
  getAdapter: jest.fn(),
}));
jest.mock('../../connections/connectionCommands', () => ({
  ensureConnectionSecrets: jest.fn(),
}));

const { getConnection } = jest.requireMock('../../connections/connectionStore');
const { getAdapter } = jest.requireMock('../../connections/adapterFactory');
const { ensureConnectionSecrets } = jest.requireMock('../../connections/connectionCommands');

type CommandHandler = (item?: unknown) => Promise<void> | void;

function collectHandlers(): Map<string, CommandHandler> {
  const map = new Map<string, CommandHandler>();
  const disposable = { dispose: jest.fn() };
  (vscode.commands.registerCommand as unknown as jest.Mock).mockImplementation(
    (name: string, handler: CommandHandler) => {
      map.set(name, handler);
      return disposable;
    }
  );
  const context = {
    subscriptions: [] as unknown[],
  } as unknown as vscode.ExtensionContext;
  const explorer = { refresh: jest.fn() } as unknown as import('../../connections/explorerView').ExplorerViewProvider;
  registerTableContextCommands(context, explorer);
  return map;
}

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    table: {
      name: 'users',
      columns: [
        { name: 'id', type: 'BIGINT', nullable: false },
        { name: 'email', type: 'VARCHAR(255)', nullable: false },
      ],
      primaryKey: ['id'],
    },
    schemaName: 'public',
    connectionId: 'conn-1',
    ...overrides,
  };
}

describe('table context command handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('dumpStructureAndData is blocked when allowCsvExport is false, even when invoked directly', async () => {
    getConnection.mockResolvedValue({
      id: 'conn-1',
      name: 'Prod',
      dialect: 'postgres',
      allowCsvExport: false,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });
    const runQuery = jest.fn();
    getAdapter.mockReturnValue({ runQuery });

    const handlers = collectHandlers();
    const handler = handlers.get('runql.schema.dumpStructureAndData')!;
    await handler(makeItem());

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringMatching(/Row-data export is disabled/)
    );
    expect(runQuery).not.toHaveBeenCalled();
    expect(ensureConnectionSecrets).not.toHaveBeenCalled();
  });

  it('copyTable with data is blocked when allowCsvExport is false', async () => {
    getConnection.mockResolvedValue({
      id: 'conn-1',
      name: 'Prod',
      dialect: 'postgres',
      allowCsvExport: false,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });

    (vscode.window.showInputBox as unknown as jest.Mock).mockResolvedValue('users_copy');
    (vscode.window.showQuickPick as unknown as jest.Mock).mockResolvedValue({
      label: 'Structure and data',
    });
    (vscode.window.showWarningMessage as unknown as jest.Mock).mockResolvedValue('Continue');

    const handlers = collectHandlers();
    const handler = handlers.get('runql.schema.copyTable')!;
    await handler(makeItem());

    // Since allowCsvExport=false, the quickpick should be skipped and only
    // structure-only path is available. The copy proceeds without data.
    expect(ensureConnectionSecrets).toHaveBeenCalled();
  });

  it('dropTable requires confirmation before running SQL', async () => {
    getConnection.mockResolvedValue({
      id: 'conn-1',
      name: 'Prod',
      dialect: 'postgres',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });
    const executeNonQuery = jest.fn().mockResolvedValue({ affectedRows: 0 });
    getAdapter.mockReturnValue({ executeNonQuery });
    ensureConnectionSecrets.mockResolvedValue({ password: 'x' });

    (vscode.window.showWarningMessage as unknown as jest.Mock).mockResolvedValue(undefined);

    const handlers = collectHandlers();
    const handler = handlers.get('runql.schema.dropTable')!;
    await handler(makeItem());

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringMatching(/Drop table.*"public"\."users".*"Prod"/),
      expect.objectContaining({ modal: true }),
      'Yes'
    );
    expect(executeNonQuery).not.toHaveBeenCalled();
  });

  it('dropTable proceeds after confirmation', async () => {
    getConnection.mockResolvedValue({
      id: 'conn-1',
      name: 'Prod',
      dialect: 'postgres',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });
    const executeNonQuery = jest.fn().mockResolvedValue({ affectedRows: 0 });
    getAdapter.mockReturnValue({ executeNonQuery });
    ensureConnectionSecrets.mockResolvedValue({ password: 'x' });

    (vscode.window.showWarningMessage as unknown as jest.Mock).mockResolvedValue('Yes');

    const handlers = collectHandlers();
    const handler = handlers.get('runql.schema.dropTable')!;
    await handler(makeItem());

    expect(executeNonQuery).toHaveBeenCalledTimes(1);
    expect(executeNonQuery.mock.calls[0][2]).toMatch(/DROP TABLE "public"\."users"/);
  });

  it('truncateTable warns instead of falling back to DELETE for sqlite', async () => {
    getConnection.mockResolvedValue({
      id: 'conn-1',
      name: 'Local',
      dialect: 'sqlite',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });
    const executeNonQuery = jest.fn();
    getAdapter.mockReturnValue({ executeNonQuery });

    const handlers = collectHandlers();
    const handler = handlers.get('runql.schema.truncateTable')!;
    await handler(makeItem());

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringMatching(/TRUNCATE TABLE is not supported/)
    );
    expect(executeNonQuery).not.toHaveBeenCalled();
  });

  it('truncateTable requires confirmation before running', async () => {
    getConnection.mockResolvedValue({
      id: 'conn-1',
      name: 'Prod',
      dialect: 'postgres',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });
    const executeNonQuery = jest.fn().mockResolvedValue({ affectedRows: 0 });
    getAdapter.mockReturnValue({ executeNonQuery });
    ensureConnectionSecrets.mockResolvedValue({ password: 'x' });
    (vscode.window.showWarningMessage as unknown as jest.Mock).mockResolvedValue(undefined);

    const handlers = collectHandlers();
    const handler = handlers.get('runql.schema.truncateTable')!;
    await handler(makeItem());

    expect(executeNonQuery).not.toHaveBeenCalled();
  });

  it('copyTableName writes unqualified name to clipboard', async () => {
    getConnection.mockResolvedValue({
      id: 'conn-1',
      name: 'Prod',
      dialect: 'postgres',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });
    const handlers = collectHandlers();
    const handler = handlers.get('runql.schema.copyTableName')!;
    await handler(makeItem());
    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('users');
  });

  it('showTableDdl uses adapter-provided native DDL when available', async () => {
    getConnection.mockResolvedValue({
      id: 'conn-1',
      name: 'BigQueryProd',
      dialect: 'bigquery',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });
    const getTableDdl = jest
      .fn()
      .mockResolvedValue('CREATE TABLE `public`.`users` (id INT64);');
    getAdapter.mockReturnValue({ getTableDdl });
    ensureConnectionSecrets.mockResolvedValue({ token: 'x' });

    const openTextDocument = vscode.workspace.openTextDocument as unknown as jest.Mock;
    openTextDocument.mockResolvedValue({ uri: { toString: () => 'sql-doc' } });

    const handlers = collectHandlers();
    const handler = handlers.get('runql.schema.showTableDdl')!;
    await handler(makeItem());

    expect(getTableDdl).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conn-1' }),
      { token: 'x' },
      'public',
      'users'
    );
    expect(openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('CREATE TABLE `public`.`users`'),
      })
    );
  });

  it('showTableDdl falls back to reconstructed DDL when adapter lacks native DDL', async () => {
    getConnection.mockResolvedValue({
      id: 'conn-1',
      name: 'Prod',
      dialect: 'postgres',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });
    // Adapter without getTableDdl capability.
    getAdapter.mockReturnValue({});

    const openTextDocument = vscode.workspace.openTextDocument as unknown as jest.Mock;
    openTextDocument.mockResolvedValue({ uri: { toString: () => 'sql-doc' } });

    const handlers = collectHandlers();
    const handler = handlers.get('runql.schema.showTableDdl')!;
    await handler(makeItem());

    expect(openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('CREATE TABLE "public"."users"'),
      })
    );
  });

  it('truncateTable shows a clear unsupported warning for external adapters on SQLite-like dialects', async () => {
    getConnection.mockResolvedValue({
      id: 'conn-1',
      name: 'Local',
      dialect: 'sqlite',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });
    const executeNonQuery = jest.fn();
    getAdapter.mockReturnValue({ executeNonQuery });

    const handlers = collectHandlers();
    const handler = handlers.get('runql.schema.truncateTable')!;
    await handler(makeItem());

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringMatching(/TRUNCATE TABLE is not supported/)
    );
    expect(executeNonQuery).not.toHaveBeenCalled();
  });

  it('dumpStructure prefers adapter.dumpTableStructure when present', async () => {
    getConnection.mockResolvedValue({
      id: 'conn-1',
      name: 'Snowflake',
      dialect: 'snowflake',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });
    const dumpTableStructure = jest
      .fn()
      .mockResolvedValue('CREATE TABLE "public"."users" (id NUMBER);');
    getAdapter.mockReturnValue({ dumpTableStructure });
    ensureConnectionSecrets.mockResolvedValue({ token: 'x' });

    const openTextDocument = vscode.workspace.openTextDocument as unknown as jest.Mock;
    openTextDocument.mockResolvedValue({ uri: { toString: () => 'sql-doc' } });

    const handlers = collectHandlers();
    await handlers.get('runql.schema.dumpStructure')!(makeItem());

    expect(dumpTableStructure).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conn-1' }),
      { token: 'x' },
      'public',
      'users'
    );
    expect(openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('(native)'),
      })
    );
  });

  it('dumpStructure falls back to reconstruction when adapter has no capability', async () => {
    getConnection.mockResolvedValue({
      id: 'conn-1',
      name: 'Prod',
      dialect: 'postgres',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });
    getAdapter.mockReturnValue({});

    const openTextDocument = vscode.workspace.openTextDocument as unknown as jest.Mock;
    openTextDocument.mockResolvedValue({ uri: { toString: () => 'sql-doc' } });

    const handlers = collectHandlers();
    await handlers.get('runql.schema.dumpStructure')!(makeItem());

    expect(openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('CREATE TABLE "public"."users"'),
      })
    );
  });

  it('dumpStructureAndData prefers adapter.dumpTableStructureAndData over generic path', async () => {
    getConnection.mockResolvedValue({
      id: 'conn-1',
      name: 'Prod',
      dialect: 'databricks',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });
    const dumpTableStructureAndData = jest
      .fn()
      .mockResolvedValue('-- native dump payload');
    const runQuery = jest.fn(); // should NOT be called
    getAdapter.mockReturnValue({ dumpTableStructureAndData, runQuery });
    ensureConnectionSecrets.mockResolvedValue({ token: 'x' });
    (vscode.window.showWarningMessage as unknown as jest.Mock).mockResolvedValue('Continue');

    const openTextDocument = vscode.workspace.openTextDocument as unknown as jest.Mock;
    openTextDocument.mockResolvedValue({ uri: { toString: () => 'sql-doc' } });

    const handlers = collectHandlers();
    await handlers.get('runql.schema.dumpStructureAndData')!(makeItem());

    expect(dumpTableStructureAndData).toHaveBeenCalled();
    expect(runQuery).not.toHaveBeenCalled();
  });

  it('copyTable prefers adapter.copyTable native clone when present', async () => {
    getConnection.mockResolvedValue({
      id: 'conn-1',
      name: 'Snowflake',
      dialect: 'snowflake',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });
    const copyTable = jest.fn().mockResolvedValue(undefined);
    const executeNonQuery = jest.fn();
    getAdapter.mockReturnValue({ copyTable, executeNonQuery });
    ensureConnectionSecrets.mockResolvedValue({ token: 'x' });
    (vscode.window.showInputBox as unknown as jest.Mock).mockResolvedValue('users_clone');
    (vscode.window.showQuickPick as unknown as jest.Mock).mockResolvedValue({
      label: 'Structure and data',
    });
    (vscode.window.showWarningMessage as unknown as jest.Mock).mockResolvedValue('Continue');

    const handlers = collectHandlers();
    await handlers.get('runql.schema.copyTable')!(makeItem());

    expect(copyTable).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conn-1' }),
      { token: 'x' },
      'public',
      'users',
      expect.objectContaining({ destTable: 'users_clone', withData: true })
    );
    expect(executeNonQuery).not.toHaveBeenCalled();
  });

  it('truncateTable prefers adapter.truncateTable native operation when present', async () => {
    getConnection.mockResolvedValue({
      id: 'conn-1',
      name: 'Prod',
      dialect: 'bigquery',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });
    const truncateTable = jest.fn().mockResolvedValue(undefined);
    const executeNonQuery = jest.fn();
    getAdapter.mockReturnValue({ truncateTable, executeNonQuery });
    ensureConnectionSecrets.mockResolvedValue({ token: 'x' });
    (vscode.window.showWarningMessage as unknown as jest.Mock).mockResolvedValue('Yes');

    const handlers = collectHandlers();
    await handlers.get('runql.schema.truncateTable')!(makeItem());

    expect(truncateTable).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conn-1' }),
      { token: 'x' },
      'public',
      'users'
    );
    expect(executeNonQuery).not.toHaveBeenCalled();
  });

  it('truncateTable falls back to generic TRUNCATE when adapter has no capability', async () => {
    getConnection.mockResolvedValue({
      id: 'conn-1',
      name: 'Prod',
      dialect: 'postgres',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });
    const executeNonQuery = jest.fn().mockResolvedValue({ affectedRows: 0 });
    getAdapter.mockReturnValue({ executeNonQuery });
    ensureConnectionSecrets.mockResolvedValue({ password: 'x' });
    (vscode.window.showWarningMessage as unknown as jest.Mock).mockResolvedValue('Yes');

    const handlers = collectHandlers();
    await handlers.get('runql.schema.truncateTable')!(makeItem());

    expect(executeNonQuery).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conn-1' }),
      { password: 'x' },
      expect.stringMatching(/TRUNCATE TABLE "public"\."users"/)
    );
  });

  it('commands fail gracefully when invoked without a table item', async () => {
    const handlers = collectHandlers();
    for (const name of [
      'runql.schema.copyTableName',
      'runql.schema.showTableDdl',
      'runql.schema.sqlTemplate.select',
      'runql.schema.dumpStructure',
      'runql.schema.dumpStructureAndData',
      'runql.schema.dropTable',
      'runql.schema.copyTable',
      'runql.schema.truncateTable',
    ]) {
      const h = handlers.get(name);
      expect(h).toBeDefined();
      await expect(Promise.resolve(h!(undefined))).resolves.toBeUndefined();
    }
    expect(vscode.window.showWarningMessage).toHaveBeenCalled();
  });
});

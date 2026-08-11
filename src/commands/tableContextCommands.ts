import * as vscode from 'vscode';

import { ExplorerItem, ExplorerViewProvider } from '../connections/explorerView';
import { getAdapter } from '../connections/adapterFactory';
import { getConnection } from '../connections/connectionStore';
import { DbAdapter } from '../connections/adapters/adapter';
import {
  ConnectionProfile,
  ConnectionSecrets,
  DbDialect,
  TableModel,
} from '../core/types';
import { resolveEffectiveSqlDialect } from '../core/sqlUtils';
import { buildDropTableSql } from '../core/createTableSql';
import {
  buildCopyTableSql,
  buildDdlFromModel,
  buildDeleteTemplate,
  buildDumpStructureSql,
  buildInsertRowSql,
  buildInsertTemplate,
  buildQualifiedTableName,
  buildSelectTemplate,
  buildTruncateSql,
  buildUpdateTemplate,
} from '../core/tableTemplates';

interface TableTarget {
  profile: ConnectionProfile;
  dialect: DbDialect;
  schemaName?: string;
  tableName: string;
  table?: TableModel;
  fqn: string;
  adapter: DbAdapter;
}

// ─── Fallback validity per dialect ──────────────────────────────────────────
// The spec requires: adapter capability → generic fallback (only when
// dialect-valid) → clear unsupported warning. These sets encode the
// "dialect-valid" gate for each fallback. Every dialect listed in the spec's
// required coverage (postgres, mysql/mariadb, duckdb, snowflake, databricks,
// bigquery, mssql) is intentionally included where the fallback is safe.

const DIALECTS_WITH_VALID_DDL_FALLBACK: Set<DbDialect> = new Set([
  'postgres',
  'mysql',
  'sqlite',
  'duckdb',
  'snowflake',
  'databricks',
  'bigquery',
  'mssql',
]);

const DIALECTS_WITH_VALID_COPY_FALLBACK: Set<DbDialect> = new Set([
  'postgres',
  'mysql',
  'sqlite',
  'duckdb',
  'snowflake',
  'databricks',
  'bigquery',
  'mssql',
]);

const DIALECTS_WITH_VALID_TRUNCATE_FALLBACK: Set<DbDialect> = new Set([
  'postgres',
  'mysql',
  'duckdb',
  'snowflake',
  'databricks',
  'bigquery',
  'mssql',
  // sqlite deliberately excluded — no TRUNCATE support.
]);

async function resolveTableTarget(item?: ExplorerItem): Promise<TableTarget | null> {
  if (!item) {
    vscode.window.showWarningMessage('Select a table in the Explorer to run this command.');
    return null;
  }
  const tableName = item.table?.name;
  const schemaName = item.schemaName;
  if (!tableName) {
    vscode.window.showWarningMessage('Could not determine the selected table.');
    return null;
  }
  const connectionId = item.connectionId || item.introspection?.connectionId;
  if (!connectionId) {
    vscode.window.showErrorMessage('No connection found for this table.');
    return null;
  }
  const profile = (await getConnection(connectionId)) as ConnectionProfile | undefined;
  if (!profile) {
    vscode.window.showErrorMessage(`Connection not found (${connectionId}).`);
    return null;
  }
  const dialect = (resolveEffectiveSqlDialect(profile) || profile.dialect || 'duckdb') as DbDialect;
  const fqn = buildQualifiedTableName(dialect, schemaName, tableName);
  const adapter = getAdapter(profile.dialect);
  return { profile, dialect, schemaName, tableName, table: item.table, fqn, adapter };
}

export function isRowDataExportBlocked(profile: ConnectionProfile): boolean {
  return profile.allowCsvExport === false;
}

async function openSqlDocument(sql: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ content: sql, language: 'sql' });
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function confirmDestructive(
  action: string,
  target: TableTarget
): Promise<boolean> {
  const message = `${action} ${target.fqn} on connection "${target.profile.name}"? This cannot be undone.`;
  const answer = await vscode.window.showWarningMessage(message, { modal: true }, 'Yes');
  return answer === 'Yes';
}

async function ensureSecretsOrFail(profile: ConnectionProfile): Promise<ConnectionSecrets | null> {
  const { ensureConnectionSecrets } = require('../connections/connectionCommands');
  const secrets = (await ensureConnectionSecrets(profile)) as ConnectionSecrets | undefined;
  if (!secrets) {
    vscode.window.showErrorMessage('Credentials were not provided.');
    return null;
  }
  return secrets;
}

async function runNonQuery(
  adapter: DbAdapter,
  profile: ConnectionProfile,
  secrets: ConnectionSecrets,
  sql: string
): Promise<void> {
  if (typeof adapter.executeNonQuery === 'function') {
    await adapter.executeNonQuery(profile, secrets, sql);
    return;
  }
  if (typeof adapter.runQuery === 'function') {
    await adapter.runQuery(profile, secrets, sql, { maxRows: 0 });
    return;
  }
  throw new Error('Connection adapter does not support updates.');
}

function warnUnsupported(op: string, target: TableTarget): void {
  vscode.window.showWarningMessage(
    `${op} is not supported for connection "${target.profile.name}" (dialect: ${target.dialect}). No action was taken.`
  );
}

export function registerTableContextCommands(
  context: vscode.ExtensionContext,
  explorerProvider: ExplorerViewProvider
): void {
  context.subscriptions.push(
    // ─── Copy Name ─────────────────────────────────────────────────────────
    vscode.commands.registerCommand('runql.schema.copyTableName', async (item?: ExplorerItem) => {
      const target = await resolveTableTarget(item);
      if (!target) return;
      await vscode.env.clipboard.writeText(target.tableName);
      void vscode.window.setStatusBarMessage(`RunQL: copied "${target.tableName}"`, 2000);
    }),

    // ─── Show Table DDL ────────────────────────────────────────────────────
    // Resolution order: adapter.getTableDdl → reconstruction from introspection
    // (valid for all listed dialects) → unsupported warning.
    vscode.commands.registerCommand('runql.schema.showTableDdl', async (item?: ExplorerItem) => {
      const target = await resolveTableTarget(item);
      if (!target) return;

      if (typeof target.adapter.getTableDdl === 'function') {
        const secrets = await ensureSecretsOrFail(target.profile);
        if (!secrets) return;
        try {
          const nativeDdl = await target.adapter.getTableDdl(
            target.profile,
            secrets,
            target.schemaName,
            target.tableName
          );
          if (nativeDdl && nativeDdl.trim().length > 0) {
            await openSqlDocument(`-- DDL for ${target.fqn} (native)\n${nativeDdl}\n`);
            return;
          }
        } catch (err) {
          vscode.window.showWarningMessage(
            `Adapter DDL failed for ${target.fqn}: ${(err as Error).message}. Falling back to reconstructed DDL.`
          );
        }
      }

      if (
        DIALECTS_WITH_VALID_DDL_FALLBACK.has(target.dialect) &&
        target.table &&
        target.table.columns &&
        target.table.columns.length > 0
      ) {
        const ddl = buildDdlFromModel(target.dialect, target.schemaName, target.table);
        await openSqlDocument(`-- DDL for ${target.fqn}\n${ddl}\n`);
        return;
      }

      warnUnsupported('Show Table DDL', target);
    }),

    // ─── SQL Templates ─────────────────────────────────────────────────────
    vscode.commands.registerCommand('runql.schema.sqlTemplate.select', async (item?: ExplorerItem) => {
      const target = await resolveTableTarget(item);
      if (!target) return;
      const sql = buildSelectTemplate(
        { dialect: target.dialect, schemaName: target.schemaName, tableName: target.tableName },
        { columns: target.table?.columns, limit: 100 }
      );
      await openSqlDocument(sql);
    }),

    vscode.commands.registerCommand('runql.schema.sqlTemplate.insert', async (item?: ExplorerItem) => {
      const target = await resolveTableTarget(item);
      if (!target) return;
      const sql = buildInsertTemplate(
        { dialect: target.dialect, schemaName: target.schemaName, tableName: target.tableName },
        { columns: target.table?.columns }
      );
      await openSqlDocument(sql);
    }),

    vscode.commands.registerCommand('runql.schema.sqlTemplate.update', async (item?: ExplorerItem) => {
      const target = await resolveTableTarget(item);
      if (!target) return;
      const sql = buildUpdateTemplate(
        { dialect: target.dialect, schemaName: target.schemaName, tableName: target.tableName },
        { columns: target.table?.columns, primaryKey: target.table?.primaryKey }
      );
      await openSqlDocument(sql);
    }),

    vscode.commands.registerCommand('runql.schema.sqlTemplate.delete', async (item?: ExplorerItem) => {
      const target = await resolveTableTarget(item);
      if (!target) return;
      const sql = buildDeleteTemplate(
        { dialect: target.dialect, schemaName: target.schemaName, tableName: target.tableName },
        { columns: target.table?.columns, primaryKey: target.table?.primaryKey }
      );
      await openSqlDocument(sql);
    }),

    // ─── Dump Structure ────────────────────────────────────────────────────
    // Resolution order: adapter.dumpTableStructure → reconstruction (valid for
    // all listed dialects when columns are known) → unsupported warning.
    vscode.commands.registerCommand('runql.schema.dumpStructure', async (item?: ExplorerItem) => {
      const target = await resolveTableTarget(item);
      if (!target) return;

      if (typeof target.adapter.dumpTableStructure === 'function') {
        const secrets = await ensureSecretsOrFail(target.profile);
        if (!secrets) return;
        try {
          const nativeDump = await target.adapter.dumpTableStructure(
            target.profile,
            secrets,
            target.schemaName,
            target.tableName
          );
          if (nativeDump && nativeDump.trim().length > 0) {
            await openSqlDocument(`-- Structure dump for ${target.fqn} (native)\n${nativeDump}\n`);
            return;
          }
        } catch (err) {
          vscode.window.showWarningMessage(
            `Adapter dump failed for ${target.fqn}: ${(err as Error).message}. Falling back to reconstructed DDL.`
          );
        }
      }

      if (
        DIALECTS_WITH_VALID_DDL_FALLBACK.has(target.dialect) &&
        target.table &&
        target.table.columns &&
        target.table.columns.length > 0
      ) {
        const sql = buildDumpStructureSql(target.dialect, target.schemaName, target.table);
        await openSqlDocument(`-- Structure dump for ${target.fqn}\n${sql}\n`);
        return;
      }

      warnUnsupported('Dump Structure', target);
    }),

    // ─── Dump Structure And Data ───────────────────────────────────────────
    // SecureQL guard runs first. Then: adapter.dumpTableStructureAndData →
    // generic fallback (structure DDL + SELECT-and-INSERT rows) → unsupported.
    vscode.commands.registerCommand('runql.schema.dumpStructureAndData', async (item?: ExplorerItem) => {
      const target = await resolveTableTarget(item);
      if (!target) return;
      if (isRowDataExportBlocked(target.profile)) {
        vscode.window.showErrorMessage(
          `Row-data export is disabled for connection "${target.profile.name}".`
        );
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Export structure and all row data for ${target.fqn}? This may read every row in the table.`,
        { modal: true },
        'Continue'
      );
      if (confirm !== 'Continue') return;

      if (typeof target.adapter.dumpTableStructureAndData === 'function') {
        const secrets = await ensureSecretsOrFail(target.profile);
        if (!secrets) return;
        try {
          const nativeDump = await target.adapter.dumpTableStructureAndData(
            target.profile,
            secrets,
            target.schemaName,
            target.tableName
          );
          if (nativeDump && nativeDump.trim().length > 0) {
            await openSqlDocument(
              `-- Structure and data dump for ${target.fqn} (native)\n${nativeDump}\n`
            );
            return;
          }
        } catch (err) {
          vscode.window.showWarningMessage(
            `Adapter dump failed for ${target.fqn}: ${(err as Error).message}. Falling back to generic dump.`
          );
        }
      }

      if (
        !DIALECTS_WITH_VALID_DDL_FALLBACK.has(target.dialect) ||
        !target.table ||
        !target.table.columns ||
        target.table.columns.length === 0
      ) {
        warnUnsupported('Dump Structure And Data', target);
        return;
      }

      const structure = buildDumpStructureSql(target.dialect, target.schemaName, target.table);
      const secrets = await ensureSecretsOrFail(target.profile);
      if (!secrets) return;

      let inserts = '';
      try {
        const result = await target.adapter.runQuery(target.profile, secrets, `SELECT * FROM ${target.fqn}`, { maxRows: 0 });
        const rows = (result as { rows?: Array<Record<string, unknown>> }).rows || [];
        inserts = rows
          .map((r) => buildInsertRowSql(target.dialect, target.schemaName, target.table!, r))
          .join('\n');
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to read rows from ${target.fqn}: ${(err as Error).message}`
        );
        return;
      }

      await openSqlDocument(
        `-- Structure and data dump for ${target.fqn}\n${structure}\n\n${inserts}\n`
      );
    }),

    // ─── Generate Mock Data ────────────────────────────────────────────────
    vscode.commands.registerCommand('runql.schema.generateMockData', async (item?: ExplorerItem) => {
      const target = await resolveTableTarget(item);
      if (!target) return;
      if (!target.table || !target.table.columns || target.table.columns.length === 0) {
        vscode.window.showWarningMessage(
          `Cannot generate mock data for ${target.fqn}: no column metadata available.`
        );
        return;
      }
      const rowsRaw = await vscode.window.showInputBox({
        prompt: `How many mock rows for ${target.fqn}?`,
        value: '10',
        validateInput: (v) => {
          const n = Number(v);
          return Number.isInteger(n) && n > 0 && n <= 10000 ? null : 'Enter an integer 1-10000';
        },
      });
      if (!rowsRaw) return;
      const rowCount = Number(rowsRaw);
      const sample = generateMockInserts(target.dialect, target.schemaName, target.table, rowCount);
      const preview = `-- Preview: ${rowCount} mock row(s) for ${target.fqn}\n-- Review before executing against your database.\n${sample}\n`;
      await openSqlDocument(preview);
    }),

    // ─── Drop ──────────────────────────────────────────────────────────────
    vscode.commands.registerCommand('runql.schema.dropTable', async (item?: ExplorerItem) => {
      const target = await resolveTableTarget(item);
      if (!target) return;
      if (!(await confirmDestructive('Drop table', target))) return;
      const batch = buildDropTableSql({
        dialect: target.dialect,
        schemaName: target.schemaName,
        tableName: target.tableName,
      });
      const secrets = await ensureSecretsOrFail(target.profile);
      if (!secrets) return;
      try {
        for (const s of batch.statements) {
          await runNonQuery(target.adapter, target.profile, secrets, s);
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to drop ${target.fqn}: ${(err as Error).message}`);
        return;
      }
      void vscode.window.showInformationMessage(`Dropped ${target.fqn}.`);
      explorerProvider.refresh();
    }),

    // ─── Copy Table ────────────────────────────────────────────────────────
    // Resolution order: adapter.copyTable → generic CTAS/LIKE/SELECT INTO
    // fallback (valid for all listed dialects) → unsupported warning.
    vscode.commands.registerCommand('runql.schema.copyTable', async (item?: ExplorerItem) => {
      const target = await resolveTableTarget(item);
      if (!target) return;
      const destName = await vscode.window.showInputBox({
        prompt: `Copy ${target.tableName} to (new table name):`,
        value: `${target.tableName}_copy`,
      });
      if (!destName) return;

      const blockedForData = isRowDataExportBlocked(target.profile);
      const withDataChoice = blockedForData
        ? 'Structure only'
        : await vscode.window.showQuickPick(
            [
              { label: 'Structure only', description: 'Empty copy of the table' },
              { label: 'Structure and data', description: 'Copy rows too' },
            ],
            { placeHolder: 'What to copy?' }
          );
      if (!withDataChoice) return;

      const withData = typeof withDataChoice === 'string'
        ? false
        : withDataChoice.label === 'Structure and data';

      if (withData && blockedForData) {
        vscode.window.showErrorMessage(
          `Row-data copy is disabled for connection "${target.profile.name}". Only structure-only copy is allowed.`
        );
        return;
      }

      const confirmCopy = await vscode.window.showWarningMessage(
        `Copy ${target.fqn} to "${destName}" on connection "${target.profile.name}"? If a table named "${destName}" already exists the database will reject the copy — this command does not overwrite existing tables.`,
        { modal: true },
        'Continue'
      );
      if (confirmCopy !== 'Continue') return;

      const secrets = await ensureSecretsOrFail(target.profile);
      if (!secrets) return;

      if (typeof target.adapter.copyTable === 'function') {
        try {
          await target.adapter.copyTable(
            target.profile,
            secrets,
            target.schemaName,
            target.tableName,
            { destSchema: target.schemaName, destTable: destName, withData }
          );
          void vscode.window.showInformationMessage(`Copied ${target.fqn} → ${destName}.`);
          explorerProvider.refresh();
          return;
        } catch (err) {
          vscode.window.showErrorMessage(
            `Failed to copy ${target.fqn}: ${(err as Error).message}`
          );
          return;
        }
      }

      if (!DIALECTS_WITH_VALID_COPY_FALLBACK.has(target.dialect)) {
        warnUnsupported('Copy Table', target);
        return;
      }

      const statements = buildCopyTableSql({
        dialect: target.dialect,
        sourceSchema: target.schemaName,
        sourceTable: target.tableName,
        destSchema: target.schemaName,
        destTable: destName,
        withData,
      });
      try {
        for (const s of statements) {
          await runNonQuery(target.adapter, target.profile, secrets, s);
        }
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to copy ${target.fqn}: ${(err as Error).message}`
        );
        return;
      }
      void vscode.window.showInformationMessage(`Copied ${target.fqn} → ${destName}.`);
      explorerProvider.refresh();
    }),

    // ─── Truncate Table ────────────────────────────────────────────────────
    // Resolution order: adapter.truncateTable → generic TRUNCATE TABLE (only
    // when the effective dialect supports it) → unsupported warning.
    vscode.commands.registerCommand('runql.schema.truncateTable', async (item?: ExplorerItem) => {
      const target = await resolveTableTarget(item);
      if (!target) return;

      if (typeof target.adapter.truncateTable === 'function') {
        if (!(await confirmDestructive('Truncate table', target))) return;
        const secrets = await ensureSecretsOrFail(target.profile);
        if (!secrets) return;
        try {
          await target.adapter.truncateTable(
            target.profile,
            secrets,
            target.schemaName,
            target.tableName
          );
          void vscode.window.showInformationMessage(`Truncated ${target.fqn}.`);
          return;
        } catch (err) {
          vscode.window.showErrorMessage(
            `Failed to truncate ${target.fqn}: ${(err as Error).message}`
          );
          return;
        }
      }

      if (!DIALECTS_WITH_VALID_TRUNCATE_FALLBACK.has(target.dialect)) {
        vscode.window.showWarningMessage(
          `TRUNCATE TABLE is not supported by dialect "${target.dialect}". No action was taken.`
        );
        return;
      }

      const truncate = buildTruncateSql(target.dialect, target.schemaName, target.tableName);
      if (!truncate.supported) {
        vscode.window.showWarningMessage(
          `TRUNCATE TABLE is not supported by dialect "${target.dialect}". No action was taken.`
        );
        return;
      }
      if (!(await confirmDestructive('Truncate table', target))) return;
      const secrets = await ensureSecretsOrFail(target.profile);
      if (!secrets) return;
      try {
        await runNonQuery(target.adapter, target.profile, secrets, truncate.sql);
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to truncate ${target.fqn}: ${(err as Error).message}`
        );
        return;
      }
      void vscode.window.showInformationMessage(`Truncated ${target.fqn}.`);
    })
  );
}

function generateMockInserts(
  dialect: DbDialect,
  schemaName: string | undefined,
  table: TableModel,
  rowCount: number
): string {
  const lines: string[] = [];
  for (let i = 0; i < rowCount; i++) {
    const row: Record<string, unknown> = {};
    for (const c of table.columns || []) {
      row[c.name] = mockValueForColumn(c, i);
    }
    lines.push(buildInsertRowSql(dialect, schemaName, table, row));
  }
  return lines.join('\n');
}

function mockValueForColumn(
  col: { name: string; type?: string; nullable?: boolean },
  index: number
): unknown {
  const type = (col.type || '').toLowerCase();
  if (/int|bigint|smallint/.test(type)) return index + 1;
  if (/numeric|decimal|number|float|double|real/.test(type)) return Number((index + 1) * 1.1);
  if (/bool/.test(type)) return index % 2 === 0;
  if (/date|time|timestamp/.test(type)) return null;
  return `${col.name}_${index + 1}`;
}

import { DbDialect, TableModel } from './types';
import { quoteIdentifier } from './sqlUtils';

export interface TableRef {
  schemaName?: string;
  tableName: string;
  dialect: DbDialect;
}

export interface TemplateOptions {
  columns?: Array<{ name: string; type?: string; nullable?: boolean }>;
  primaryKey?: string[];
  limit?: number;
}

export function buildQualifiedTableName(
  dialect: DbDialect,
  schemaName: string | undefined,
  tableName: string
): string {
  if (!schemaName) {
    return quoteIdentifier(dialect, tableName);
  }
  if (dialect === 'snowflake' && schemaName.includes('.')) {
    const parts = schemaName
      .split('.')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (parts.length >= 2) {
      const database = parts[0];
      const schema = parts.slice(1).join('.');
      return `${quoteIdentifier(dialect, database)}.${quoteIdentifier(dialect, schema)}.${quoteIdentifier(dialect, tableName)}`;
    }
  }
  return `${quoteIdentifier(dialect, schemaName)}.${quoteIdentifier(dialect, tableName)}`;
}

function limitClause(dialect: DbDialect, n: number): { prefix: string; suffix: string } {
  switch (dialect) {
    case 'mssql':
      return { prefix: `TOP ${n} `, suffix: '' };
    case 'oracle':
      return { prefix: '', suffix: ` FETCH FIRST ${n} ROWS ONLY` };
    default:
      return { prefix: '', suffix: ` LIMIT ${n}` };
  }
}

function placeholderForColumn(col: { name: string; type?: string; nullable?: boolean }): string {
  const type = (col.type || '').toLowerCase();
  if (/int|numeric|decimal|number|float|double|real|bigint|smallint/.test(type)) {
    return '0';
  }
  if (/bool/.test(type)) {
    return 'FALSE';
  }
  if (/date|time|timestamp/.test(type)) {
    return 'NULL';
  }
  return `''`;
}

export function buildSelectTemplate(ref: TableRef, opts: TemplateOptions = {}): string {
  const fqn = buildQualifiedTableName(ref.dialect, ref.schemaName, ref.tableName);
  const cols = (opts.columns || []).map((c) => quoteIdentifier(ref.dialect, c.name));
  const projection = cols.length > 0 ? cols.join(', ') : '*';
  const limit = typeof opts.limit === 'number' && opts.limit > 0 ? opts.limit : 100;
  const { prefix, suffix } = limitClause(ref.dialect, limit);
  return `SELECT ${prefix}${projection} FROM ${fqn}${suffix};`;
}

export function buildInsertTemplate(ref: TableRef, opts: TemplateOptions = {}): string {
  const fqn = buildQualifiedTableName(ref.dialect, ref.schemaName, ref.tableName);
  const cols = opts.columns || [];
  if (cols.length === 0) {
    return `INSERT INTO ${fqn} (/* columns */) VALUES (/* values */);`;
  }
  const colList = cols.map((c) => quoteIdentifier(ref.dialect, c.name)).join(', ');
  const valList = cols.map((c) => placeholderForColumn(c)).join(', ');
  return `INSERT INTO ${fqn} (${colList}) VALUES (${valList});`;
}

export function buildUpdateTemplate(ref: TableRef, opts: TemplateOptions = {}): string {
  const fqn = buildQualifiedTableName(ref.dialect, ref.schemaName, ref.tableName);
  const cols = opts.columns || [];
  const pk = opts.primaryKey || [];
  const pkSet = new Set(pk);
  const setCols = cols.filter((c) => !pkSet.has(c.name));
  if (setCols.length === 0) {
    return `UPDATE ${fqn} SET /* column = value */ WHERE /* condition */;`;
  }
  const setClause = setCols
    .map((c) => `${quoteIdentifier(ref.dialect, c.name)} = ${placeholderForColumn(c)}`)
    .join(', ');
  const whereClause =
    pk.length > 0
      ? pk
          .map((k) => {
            const col = cols.find((c) => c.name === k);
            return `${quoteIdentifier(ref.dialect, k)} = ${col ? placeholderForColumn(col) : `''`}`;
          })
          .join(' AND ')
      : '/* condition */';
  return `UPDATE ${fqn} SET ${setClause} WHERE ${whereClause};`;
}

export function buildDeleteTemplate(ref: TableRef, opts: TemplateOptions = {}): string {
  const fqn = buildQualifiedTableName(ref.dialect, ref.schemaName, ref.tableName);
  const pk = opts.primaryKey || [];
  const cols = opts.columns || [];
  const whereClause =
    pk.length > 0
      ? pk
          .map((k) => {
            const col = cols.find((c) => c.name === k);
            return `${quoteIdentifier(ref.dialect, k)} = ${col ? placeholderForColumn(col) : `''`}`;
          })
          .join(' AND ')
      : '/* condition */';
  return `DELETE FROM ${fqn} WHERE ${whereClause};`;
}

export function buildDdlFromModel(
  dialect: DbDialect,
  schemaName: string | undefined,
  table: TableModel
): string {
  const fqn = buildQualifiedTableName(dialect, schemaName, table.name);
  const cols = (table.columns || []).map((c) => {
    const parts = [quoteIdentifier(dialect, c.name), c.type || 'TEXT'];
    if (c.nullable === false) parts.push('NOT NULL');
    return '  ' + parts.join(' ');
  });
  const pk =
    table.primaryKey && table.primaryKey.length > 0
      ? [`  PRIMARY KEY (${table.primaryKey.map((n) => quoteIdentifier(dialect, n)).join(', ')})`]
      : [];
  const body = [...cols, ...pk].join(',\n');
  return `CREATE TABLE ${fqn} (\n${body}\n);`;
}

export function buildTruncateSql(
  dialect: DbDialect,
  schemaName: string | undefined,
  tableName: string
): { sql: string; supported: boolean } {
  const fqn = buildQualifiedTableName(dialect, schemaName, tableName);
  // SQLite has no TRUNCATE TABLE. Every other dialect in the required coverage
  // (postgres, mysql/mariadb, duckdb, snowflake, databricks, bigquery, mssql)
  // supports TRUNCATE TABLE natively.
  if (dialect === 'sqlite') {
    return { sql: '', supported: false };
  }
  return { sql: `TRUNCATE TABLE ${fqn};`, supported: true };
}

export function buildCopyTableSql(params: {
  dialect: DbDialect;
  sourceSchema?: string;
  sourceTable: string;
  destSchema?: string;
  destTable: string;
  withData: boolean;
}): string[] {
  const { dialect, sourceSchema, sourceTable, destSchema, destTable, withData } = params;
  const src = buildQualifiedTableName(dialect, sourceSchema, sourceTable);
  const dst = buildQualifiedTableName(dialect, destSchema || sourceSchema, destTable);
  if (withData) {
    switch (dialect) {
      case 'mysql':
        return [
          `CREATE TABLE ${dst} LIKE ${src};`,
          `INSERT INTO ${dst} SELECT * FROM ${src};`
        ];
      case 'mssql':
        return [`SELECT * INTO ${dst} FROM ${src};`];
      case 'postgres':
      case 'duckdb':
      case 'sqlite':
      case 'snowflake':
      case 'bigquery':
      case 'databricks':
      default:
        // Standard CREATE TABLE AS SELECT is supported by all remaining
        // required dialects (postgres, duckdb, snowflake, bigquery, databricks)
        // and by sqlite.
        return [`CREATE TABLE ${dst} AS SELECT * FROM ${src};`];
    }
  }
  switch (dialect) {
    case 'mysql':
      return [`CREATE TABLE ${dst} LIKE ${src};`];
    case 'mssql':
      return [`SELECT * INTO ${dst} FROM ${src} WHERE 1 = 0;`];
    default:
      // Structure-only CTAS with an unsatisfiable WHERE is portable across the
      // remaining supported dialects (postgres, duckdb, snowflake, bigquery,
      // databricks, sqlite).
      return [`CREATE TABLE ${dst} AS SELECT * FROM ${src} WHERE 1 = 0;`];
  }
}

export function buildDumpStructureSql(
  dialect: DbDialect,
  schemaName: string | undefined,
  table: TableModel
): string {
  return buildDdlFromModel(dialect, schemaName, table);
}

export function buildInsertRowSql(
  dialect: DbDialect,
  schemaName: string | undefined,
  table: TableModel,
  row: Record<string, unknown>
): string {
  const fqn = buildQualifiedTableName(dialect, schemaName, table.name);
  const cols = (table.columns || []).map((c) => c.name);
  const colList = cols.map((c) => quoteIdentifier(dialect, c)).join(', ');
  const values = cols
    .map((c) => sqlLiteral(row[c], dialect))
    .join(', ');
  return `INSERT INTO ${fqn} (${colList}) VALUES (${values});`;
}

function sqlLiteral(value: unknown, dialect: DbDialect): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') {
    return dialect === 'mysql' ? (value ? '1' : '0') : value ? 'TRUE' : 'FALSE';
  }
  const s = String(value).replace(/'/g, "''");
  return `'${s}'`;
}

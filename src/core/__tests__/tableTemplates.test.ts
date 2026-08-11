import {
  buildCopyTableSql,
  buildDdlFromModel,
  buildDeleteTemplate,
  buildDumpStructureSql,
  buildInsertTemplate,
  buildSelectTemplate,
  buildTruncateSql,
  buildUpdateTemplate,
} from '../tableTemplates';
import { DbDialect, TableModel } from '../types';

const usersTable: TableModel = {
  name: 'users',
  columns: [
    { name: 'id', type: 'BIGINT', nullable: false },
    { name: 'email', type: 'VARCHAR(255)', nullable: false },
    { name: 'created_at', type: 'TIMESTAMP', nullable: true },
  ],
  primaryKey: ['id'],
};

describe('buildSelectTemplate quoting per dialect', () => {
  const ref = (dialect: DbDialect) => ({ dialect, schemaName: 'public', tableName: 'users' });

  interface DialectCase {
    dialect: DbDialect;
    fqn: string;
    idQuote: (name: string) => string;
    rowLimit: 'TOP' | 'LIMIT';
  }

  const CASES: DialectCase[] = [
    { dialect: 'postgres', fqn: '"public"."users"', idQuote: (n) => `"${n}"`, rowLimit: 'LIMIT' },
    { dialect: 'mysql', fqn: '`public`.`users`', idQuote: (n) => `\`${n}\``, rowLimit: 'LIMIT' },
    // MariaDB is normalized to mysql by resolveEffectiveSqlDialect; the effective
    // dialect passed to templates is 'mysql'. This case documents that behavior.
    { dialect: 'mysql', fqn: '`public`.`users`', idQuote: (n) => `\`${n}\``, rowLimit: 'LIMIT' },
    { dialect: 'duckdb', fqn: '"public"."users"', idQuote: (n) => `"${n}"`, rowLimit: 'LIMIT' },
    { dialect: 'snowflake', fqn: '"public"."users"', idQuote: (n) => `"${n}"`, rowLimit: 'LIMIT' },
    { dialect: 'databricks', fqn: '`public`.`users`', idQuote: (n) => `\`${n}\``, rowLimit: 'LIMIT' },
    { dialect: 'bigquery', fqn: '`public`.`users`', idQuote: (n) => `\`${n}\``, rowLimit: 'LIMIT' },
    { dialect: 'mssql', fqn: '[public].[users]', idQuote: (n) => `[${n}]`, rowLimit: 'TOP' },
  ];

  test.each(CASES)('SELECT template for %o', ({ dialect, fqn, idQuote, rowLimit }) => {
    const sql = buildSelectTemplate(ref(dialect), { columns: usersTable.columns, limit: 25 });
    expect(sql).toContain(fqn);
    expect(sql).toContain(idQuote('id'));
    if (rowLimit === 'TOP') {
      expect(sql).toMatch(/SELECT TOP 25/);
      expect(sql).not.toMatch(/LIMIT/);
    } else {
      expect(sql).toMatch(/LIMIT 25/);
      expect(sql).not.toMatch(/TOP/);
    }
  });

  test.each(CASES)('INSERT template for %o', ({ dialect, fqn, idQuote }) => {
    const sql = buildInsertTemplate(ref(dialect), { columns: usersTable.columns });
    expect(sql).toContain(`INSERT INTO ${fqn}`);
    expect(sql).toContain(idQuote('id'));
    expect(sql).toContain(idQuote('email'));
    expect(sql).toContain('VALUES');
  });

  test.each(CASES)('UPDATE template for %o', ({ dialect, fqn, idQuote }) => {
    const sql = buildUpdateTemplate(ref(dialect), {
      columns: usersTable.columns,
      primaryKey: ['id'],
    });
    expect(sql).toContain(`UPDATE ${fqn}`);
    expect(sql).toContain(`${idQuote('email')} =`);
    expect(sql).toContain(`WHERE ${idQuote('id')} =`);
  });

  test.each(CASES)('DELETE template for %o', ({ dialect, fqn, idQuote }) => {
    const sql = buildDeleteTemplate(ref(dialect), {
      columns: usersTable.columns,
      primaryKey: ['id'],
    });
    expect(sql).toContain(`DELETE FROM ${fqn}`);
    expect(sql).toContain(`WHERE ${idQuote('id')} =`);
  });

  it('falls back to * when no columns are known', () => {
    const sql = buildSelectTemplate(ref('postgres'), {});
    expect(sql).toContain('SELECT * FROM "public"."users"');
  });
});

describe('INSERT/UPDATE/DELETE template quoting', () => {
  it('INSERT includes column list and placeholder values', () => {
    const sql = buildInsertTemplate(
      { dialect: 'postgres', schemaName: 'public', tableName: 'users' },
      { columns: usersTable.columns }
    );
    expect(sql).toContain('INSERT INTO "public"."users"');
    expect(sql).toContain('"id"');
    expect(sql).toContain('VALUES');
  });

  it('UPDATE excludes PK from SET and uses PK in WHERE', () => {
    const sql = buildUpdateTemplate(
      { dialect: 'mysql', schemaName: 'public', tableName: 'users' },
      { columns: usersTable.columns, primaryKey: ['id'] }
    );
    expect(sql).toContain('UPDATE `public`.`users`');
    expect(sql).toContain('`email` =');
    expect(sql).toContain('WHERE `id` =');
    expect(sql).not.toMatch(/SET[^W]*`id`\s*=/);
  });

  it('DELETE uses PK columns in WHERE', () => {
    const sql = buildDeleteTemplate(
      { dialect: 'snowflake', schemaName: 'PUBLIC', tableName: 'USERS' },
      { columns: usersTable.columns, primaryKey: ['id'] }
    );
    expect(sql).toMatch(/DELETE FROM "PUBLIC"\."USERS" WHERE "id" =/);
  });

  it('DELETE without PK falls back to generic WHERE', () => {
    const sql = buildDeleteTemplate(
      { dialect: 'duckdb', schemaName: 'public', tableName: 'users' },
      { columns: usersTable.columns }
    );
    expect(sql).toContain('WHERE /* condition */');
  });
});

describe('buildDdlFromModel', () => {
  it('generates DDL including PK', () => {
    const ddl = buildDdlFromModel('postgres', 'public', usersTable);
    expect(ddl).toContain('CREATE TABLE "public"."users"');
    expect(ddl).toContain('"id" BIGINT NOT NULL');
    expect(ddl).toContain('PRIMARY KEY ("id")');
  });
});

describe('buildDumpStructureSql', () => {
  it('emits CREATE TABLE only', () => {
    const sql = buildDumpStructureSql('postgres', 'public', usersTable);
    expect(sql).toContain('CREATE TABLE');
    expect(sql).not.toMatch(/INSERT INTO/);
  });
});

describe('buildTruncateSql', () => {
  it.each([
    ['postgres' as DbDialect, '"public"."users"'],
    ['mysql' as DbDialect, '`public`.`users`'],
    ['duckdb' as DbDialect, '"public"."users"'],
    ['snowflake' as DbDialect, '"public"."users"'],
    ['databricks' as DbDialect, '`public`.`users`'],
    ['bigquery' as DbDialect, '`public`.`users`'],
    ['mssql' as DbDialect, '[public].[users]'],
  ])('returns TRUNCATE for %s', (dialect, expectedFqn) => {
    const r = buildTruncateSql(dialect, 'public', 'users');
    expect(r.supported).toBe(true);
    expect(r.sql).toBe(`TRUNCATE TABLE ${expectedFqn};`);
  });

  it('returns unsupported for sqlite', () => {
    const r = buildTruncateSql('sqlite', 'main', 'users');
    expect(r.supported).toBe(false);
  });
});

describe('buildCopyTableSql', () => {
  it.each([
    ['postgres' as DbDialect, /CREATE TABLE .* AS SELECT \* FROM .* WHERE 1 = 0/],
    ['duckdb' as DbDialect, /CREATE TABLE .* AS SELECT \* FROM .* WHERE 1 = 0/],
    ['snowflake' as DbDialect, /CREATE TABLE .* AS SELECT \* FROM .* WHERE 1 = 0/],
    ['bigquery' as DbDialect, /CREATE TABLE .* AS SELECT \* FROM .* WHERE 1 = 0/],
    ['databricks' as DbDialect, /CREATE TABLE .* AS SELECT \* FROM .* WHERE 1 = 0/],
  ])('structure-only CTAS for %s', (dialect, pattern) => {
    const stmts = buildCopyTableSql({
      dialect,
      sourceSchema: 'public',
      sourceTable: 'users',
      destTable: 'users_copy',
      withData: false,
    });
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toMatch(pattern);
  });

  it('mysql structure-only uses LIKE', () => {
    const stmts = buildCopyTableSql({
      dialect: 'mysql',
      sourceSchema: 'db',
      sourceTable: 'users',
      destTable: 'users_copy',
      withData: false,
    });
    expect(stmts[0]).toMatch(/CREATE TABLE `db`\.`users_copy` LIKE `db`\.`users`;/);
  });

  it('mssql structure-only uses SELECT INTO WHERE 1=0', () => {
    const stmts = buildCopyTableSql({
      dialect: 'mssql',
      sourceSchema: 'dbo',
      sourceTable: 'users',
      destTable: 'users_copy',
      withData: false,
    });
    expect(stmts[0]).toMatch(/SELECT \* INTO \[dbo\]\.\[users_copy\] FROM \[dbo\]\.\[users\] WHERE 1 = 0;/);
  });

  it.each([
    ['postgres' as DbDialect],
    ['duckdb' as DbDialect],
    ['snowflake' as DbDialect],
    ['bigquery' as DbDialect],
    ['databricks' as DbDialect],
  ])('structure-and-data CTAS for %s', (dialect) => {
    const stmts = buildCopyTableSql({
      dialect,
      sourceSchema: 'public',
      sourceTable: 'users',
      destTable: 'users_copy',
      withData: true,
    });
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toMatch(/CREATE TABLE .* AS SELECT \* FROM/);
    expect(stmts[0]).not.toMatch(/WHERE 1 = 0/);
  });

  it('mysql structure-and-data uses LIKE + INSERT SELECT', () => {
    const stmts = buildCopyTableSql({
      dialect: 'mysql',
      sourceSchema: 'db',
      sourceTable: 'users',
      destTable: 'users_copy',
      withData: true,
    });
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toMatch(/LIKE/);
    expect(stmts[1]).toMatch(/INSERT INTO .* SELECT \* FROM/);
  });

  it('mssql structure-and-data uses SELECT INTO', () => {
    const stmts = buildCopyTableSql({
      dialect: 'mssql',
      sourceSchema: 'dbo',
      sourceTable: 'users',
      destTable: 'users_copy',
      withData: true,
    });
    expect(stmts[0]).toMatch(/SELECT \* INTO \[dbo\]\.\[users_copy\] FROM \[dbo\]\.\[users\];/);
  });
});

describe('MariaDB normalization to mysql', () => {
  it('MariaDB profiles use MySQL quoting via resolveEffectiveSqlDialect', () => {
    // Import inline to avoid circular test dependencies at file scope.
    const { resolveEffectiveSqlDialect } = require('../sqlUtils');
    const profile = {
      id: 'x',
      name: 'MariaDB Test',
      dialect: 'mysql',
      sqlDialect: 'mariadb',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    };
    const dialect = resolveEffectiveSqlDialect(profile);
    expect(dialect).toBe('mysql');
    const sql = buildSelectTemplate(
      { dialect, schemaName: 'db', tableName: 'users' },
      { columns: usersTable.columns }
    );
    expect(sql).toContain('`db`.`users`');
  });
});

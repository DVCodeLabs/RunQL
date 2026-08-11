import { ConnectionProfile, ConnectionSecrets, QueryResult, QueryRunOptions, SchemaIntrospection, DbDialect, NonQueryResult } from '../../core/types';

/**
 * Options for a copyTable capability call.
 */
export interface CopyTableOptions {
    destSchema?: string;
    destTable: string;
    /** Copy row data as well as structure. */
    withData: boolean;
}

export interface DbAdapter {
    readonly dialect: DbDialect;

    testConnection(profile: ConnectionProfile, secrets: ConnectionSecrets): Promise<void>;

    runQuery(
        profile: ConnectionProfile,
        secrets: ConnectionSecrets,
        sql: string,
        options: QueryRunOptions
    ): Promise<QueryResult>;

    executeNonQuery(
        profile: ConnectionProfile,
        secrets: ConnectionSecrets,
        sql: string
    ): Promise<NonQueryResult>;

    introspectSchema(
        profile: ConnectionProfile,
        secrets: ConnectionSecrets
    ): Promise<SchemaIntrospection>;

    exportTable?(
        profile: ConnectionProfile,
        secrets: ConnectionSecrets,
        schema: string,
        table: string,
        format: 'csv' | 'json',
        outputUri: import('vscode').Uri
    ): Promise<void>;

    // ─── Optional table-operation capabilities ────────────────────────────────
    // Client command handlers call these first, before falling back to shared
    // dialect-correct SQL. Adapters that leave these unimplemented get the
    // generic fallback path in RunQL-Client. See
    // src/specs/table-item-context-menu.md for the resolution order.

    /**
     * Return database-native DDL for the table. Preferred over reconstructing
     * DDL from introspection metadata because dialect-native DDL preserves
     * defaults, generated columns, partitioning, clustering, and comments that
     * the introspection model does not carry.
     *
     * Example native primitives:
     *  - Snowflake:   SELECT GET_DDL('TABLE', ...)
     *  - Databricks:  SHOW CREATE TABLE ...
     *  - DuckDB:      SELECT sql FROM duckdb_tables()
     *  - BigQuery:    tables.get REST API
     *  - MSSQL:       sys.sql_modules / scripting
     */
    getTableDdl?(
        profile: ConnectionProfile,
        secrets: ConnectionSecrets,
        schema: string | undefined,
        table: string
    ): Promise<string>;

    /**
     * Return a SQL script that recreates the table structure only. Prefer
     * adapter-native output when it captures details reconstruction cannot
     * (defaults, constraints, storage options).
     */
    dumpTableStructure?(
        profile: ConnectionProfile,
        secrets: ConnectionSecrets,
        schema: string | undefined,
        table: string
    ): Promise<string>;

    /**
     * Return a SQL script that recreates the table structure and inserts its
     * current rows. Must respect the connection's export policy — an adapter
     * that would otherwise export data on a no-export connection must throw
     * with a clear message rather than silently exporting.
     */
    dumpTableStructureAndData?(
        profile: ConnectionProfile,
        secrets: ConnectionSecrets,
        schema: string | undefined,
        table: string
    ): Promise<string>;

    /**
     * Create a copy of a table using adapter-native semantics. Preferred over
     * generic CTAS because engines like Snowflake, Databricks, and BigQuery
     * have zero-copy / metadata clone primitives that are dramatically faster
     * and preserve constraints/indexes.
     */
    copyTable?(
        profile: ConnectionProfile,
        secrets: ConnectionSecrets,
        sourceSchema: string | undefined,
        sourceTable: string,
        options: CopyTableOptions
    ): Promise<void>;

    /**
     * Truncate a table using adapter-native semantics. Adapters that cannot
     * truncate (engine version too old, FK constraints in the way) must throw
     * a clear error rather than silently falling back to DELETE.
     */
    truncateTable?(
        profile: ConnectionProfile,
        secrets: ConnectionSecrets,
        schema: string | undefined,
        table: string
    ): Promise<void>;
}

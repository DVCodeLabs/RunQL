# Database Adapters

RunQL supports multiple database dialects via adapters.

## Adapter Status

| Adapter | Status | Notes |
| --- | --- | --- |
| DuckDB | Wired | Connection + query + introspection flow |
| PostgreSQL | Wired | Connection + query + introspection flow |
| MySQL | Wired | Connection + query + introspection flow |
| Snowflake | External | Supported via optional connector extension (`runql-snowflake`) |

## DuckDB

- Supports local file path or DuckDB connection string
- Supports query execution, introspection, CSV export, and ERD flows

## PostgreSQL

- Use for remote operational/warehouse query workflows
- Supports test connection and schema introspection

## MySQL

- Same operational flow as Postgres within the extension
- Supports introspection and table-level workflows

## Snowflake

- Snowflake support is provided by the optional `runql-snowflake` connector extension.
- Core RunQL exposes a provider/adapter API so external connectors can register schemas and runtime adapters consistently.

## Typical Workflow

1. Add connection
2. Test connection
3. Introspect schema
4. Run SQL and inspect results
5. Export needed data as CSV

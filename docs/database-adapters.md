# Database Adapters

RunQL supports multiple database dialects through built-in adapters and provider extensions.

## Adapter Status

| Adapter | Status | Notes |
| --- | --- | --- |
| PostgreSQL | Built in | Connection, query, introspection, CSV export, schema backup, SSL, DB Admin mode, and SSH tunnel flow |
| MySQL | Built in | Connection, query, introspection, CSV export, schema backup, SSL, DB Admin mode, and SSH tunnel flow |
| MariaDB | Built in | Connection, query, introspection, CSV export, schema backup, SSL, DB Admin mode, and SSH tunnel flow |
| SecureQL | Built in | SecureQL API-backed connection, query, introspection, permissions, query approvals, and effective SQL dialect detection |
| DuckDB | External/legacy | Not registered as a built-in adapter in the current core client |
| Snowflake | External | Supported by connector extensions that register a provider and adapter |
| MS SQL Server | External | Supported by connector extensions that register a provider and adapter |

## PostgreSQL

- Supports host, port, database, username/password, SSL, and optional SSH tunnel settings.
- Supports test connection, query execution, schema introspection, table preview, CSV export, schema backup, and ERD flows.
- Supports Data Access and DB Admin connection types.

## MySQL and MariaDB

- Supports host, port, username/password, SSL, and optional SSH tunnel settings.
- Supports the same core workflow as PostgreSQL: test connection, query execution, schema introspection, table preview, CSV export, schema backup, and ERD flows.
- Supports Data Access and DB Admin connection types.

## SecureQL

- Uses a SecureQL base URL and API key.
- Validates the API key and can auto-detect server-controlled connection metadata.
- Uses the target database's effective SQL dialect for formatting, generated metadata, and AI prompt context.
- Enforces SecureQL-provided permissions such as CSV export and data editing controls.
- Supports SecureQL query approval flows for protected queries.
- Refreshes SecureQL connection IDs and metadata when API keys change.

## External Connectors

- Core RunQL exposes a provider/adapter API so connector extensions can register schemas and runtime adapters consistently.
- Unsupported dialects produce an error asking the user to install or enable the provider extension for that dialect.
- Snowflake and DuckDB should be provided by connector extensions in the current core-client model.

### DB Admin Connection Types

Provider extensions can opt into the standard Data Access / DB Admin connection type UI:

```ts
supports: {
  dbAdminConnectionType: true
}
```

When enabled, RunQL injects the standard `connectionType` field if the provider did not define one, stores the selected value on `ConnectionProfile.connectionType`, hides the standard `database` or `schema` field in `db_admin` mode when no custom visibility rule exists, and preserves the value through connection reuse.

Adapters remain responsible for DB-specific behavior. For example, an MS SQL Server adapter should check `profile.connectionType === 'db_admin'` and introspect predefined SQL Server admin surfaces such as catalog views and `INFORMATION_SCHEMA`, using whatever internal/default connection target is appropriate for SQL Server.

Existing provider extensions that do not set `supports.dbAdminConnectionType` continue to behave as data-access-only connectors. The current Snowflake and DuckDB connector extensions do not opt in to DB Admin mode. Snowflake should only enable it after the adapter defines admin-mode connection defaults and introspection surfaces, such as account, role, database, schema, and usage metadata that the active Snowflake role can read. DuckDB generally does not need a separate DB Admin mode unless the connector adds a distinct system-catalog or maintenance workflow.

### SSH Tunnel Support

Provider extensions can opt into the standard SSH tunnel tab:

```ts
supports: {
  sshTunnel: true
}
```

RunQL injects the common SSH fields and uses shared tunnel handling for connectors that opt in. Adapters should keep their normal connection logic focused on the database endpoint RunQL provides.

## Schema Bundles

Introspection writes per-connection, per-schema bundles under:

- `RunQL/schemas/<connection>/manifest.json`
- `RunQL/schemas/<connection>/<schema>/schema.json`
- `RunQL/schemas/<connection>/<schema>/description.json`
- `RunQL/schemas/<connection>/<schema>/custom.relationships.json`
- `RunQL/schemas/<connection>/<schema>/erd.json`
- `RunQL/schemas/<connection>/<schema>/erd.layout.json`

Legacy flat schema files, legacy per-connection bundles, and legacy `RunQL/system/erd/` files are migrated into schema-level bundle folders and backed up under `RunQL/system/migration_backup/`.

Deleted schemas from a successful refreshes are archived under `RunQL/schemas/deleted/`. Query and schema folders are also archived or renamed when connections are deleted or renamed.

## Typical Workflow

1. Add DB connection
2. Test connection
3. Introspect schema
4. Explore tables, views, routines, keys, and indexes
5. Run SQL and inspect results
6. Save reusable queries with companion Markdown docs
7. Export needed data as CSV

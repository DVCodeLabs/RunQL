# Feature Highlights

## SQL Execution + Results

- Run SQL directly from the editor
- Results render in the dedicated `RunQL: Results` panel
- Export result sets to CSV
- Build charts from result data

## Connection Management

- Add, edit, test, remove, and select connections
- Built-in support for PostgreSQL, MySQL, and SecureQL
- Provider/adapter extension points for additional databases
- Optional SSH tunnel settings for built-in PostgreSQL and MySQL connections

## Schema Introspection

- Introspect schemas and tables per connection
- Persist schema bundles in `RunQL/schemas/<connection>/`
- Use snapshots for autocomplete and ERD generation
- Compare schemas and tables from introspection snapshots

## ERD

- Render ERD for active connection or selected schema
- Save ERD artifacts in the matching schema bundle as `erd.json` and `erd.layout.json`

## Optional AI Helpers

- Generate Markdown docs for SQL files
- Generate inline SQL comments
- Configure provider/model/endpoint via `runql.ai.*`

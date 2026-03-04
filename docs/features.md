# Feature Highlights

## SQL Execution + Results

- Run SQL directly from the editor
- Results render in the dedicated `RunQL: Results` panel
- Export result sets to CSV
- Build charts from result data

## Connection Management

- Add, edit, test, remove, and select connections
- Support for DuckDB, PostgreSQL, and MySQL in core
- Provider/adapter extension points for additional databases

## Schema Introspection

- Introspect schemas and tables per connection
- Persist snapshots in `RunQL/schemas/`
- Use snapshots for autocomplete and ERD generation

## ERD

- Render ERD for active connection or selected schema
- Save ERD artifacts under `RunQL/system/erd/`

## Optional AI Helpers

- Generate Markdown docs for SQL files
- Generate inline SQL comments
- Configure provider/model/endpoint via `runql.ai.*`

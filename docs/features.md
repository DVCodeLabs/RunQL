# Feature Highlights

## SQL Execution + Results

- Run SQL directly from the editor
- Run the current statement from the editor
- Run queries with or without the configured row limit
- Results render in the dedicated `RunQL: Results` panel
- Export result sets to CSV
- Build charts from result data
- Edit data inline when connection and safety checks allow it
- Copy full cell contents or partial cell text from the results grid
- Run `SHOW`, `DESCRIBE`, and `EXPLAIN` without row-limit wrapping

## SQL Authoring

- Show RunQL CodeLens actions at the top of SQL files
- Select the active connection from the SQL editor tab
- Show production, staging, dev, and reporting connection tags in the editor, Explorer, and status bar
- Create schema snapshots for table, view, column, and alias-aware autocomplete
- Insert routine calls from procedures and functions in the Explorer

## Saved Queries + Markdown

- Create new SQL files
- Save SQL files as query bundles with companion Markdown metadata
- Open, rename, delete, and refresh saved queries
- Search saved queries by SQL, metadata, tags, and companion docs
- Group saved queries by recency in the Saved Queries view
- View and edit companion Markdown docs in the `RunQL: Markdown` panel
- Find similar saved queries from SQL files
- Preserve schema/catalog context with saved queries

## Connection Management

- Add, edit, test, remove, and select connections
- Built-in support for PostgreSQL, MySQL, and SecureQL
- Provider/adapter extension points for additional databases
- Reuse existing connection details when adding a new connection
- Define a connection as Data Access or DB Admin for safety when working with your dbs.
- Use connection tags such as production, staging, dev, and reporting
- Optional SSH tunnel settings for connectors that support them
- Shared SSH tunnel handling across supported connectors

## Workspace Storage

- Store RunQL files in the project workspace, user home directory, or a custom path
- Use a RunQL workspace across multiple projects (user home or custom path)
- Use `/workspaces/.runql` by default in GitHub Codespaces
- Open, change, and move the active RunQL storage folder
- Link project folders to user or custom RunQL storage roots
- Generate workspace guidance files for RunQL-aware agents and contributors

## Schema Introspection

- Introspect schemas and tables per connection
- Persist schema bundles in `RunQL/schemas/<connection>/<schema>/`
- Maintain per-connection schema manifests
- Use snapshots for autocomplete and ERD generation
- Compare schemas and tables from introspection snapshots
- Automatically Archive schema and query folders when connections are deleted
- Automatically Rename schema and query folders when connections are renamed
- Show procedures and functions

## Explorer Table Actions

- Query the top 100 rows from a table
- Create and edit tables from the Explorer
- Copy table names and show table DDL
- Generate `SELECT`, `INSERT`, `UPDATE`, and `DELETE` templates
- Dump table structure or structure plus data
- Generate mock data for supported tables
- Copy, drop, or truncate tables
- Back up schema structure from the Explorer

## ERD

- Render ERD for active connection or selected schema
- Save ERD artifacts in the matching schema bundle as `erd.json` and `erd.layout.json`

## Query History

- Track query history in the `RunQL: Query History` panel
- Reopen queries from history

## SecureQL

- Connect through SecureQL with schema introspection and query execution
- Respect SecureQL CSV export and data-edit permissions
- Request and track approvals for protected queries
- Recognize permission commands in SecureQL approval prechecks

## Optional AI Helpers

- Generate Markdown docs for SQL files
- Generate inline SQL comments
- Generate schema descriptions with AI
- Send schema context with AI prompts
- Use GitHub Copilot / VS Code AI, Claude Code, Codex, or direct API providers
- Configure provider/model/endpoint via `runql.ai.*`
- Use OpenAI, Anthropic, Azure OpenAI, Ollama, or OpenAI-compatible endpoints
- Customize prompt templates in `RunQL/system/prompts/`

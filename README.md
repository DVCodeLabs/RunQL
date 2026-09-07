# RunQL

[![Tests](https://github.com/DVCodeLabs/RunQL/actions/workflows/test.yml/badge.svg)](https://github.com/DVCodeLabs/RunQL/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![VS Code](https://img.shields.io/badge/vscode-%5E1.96.0-007ACC)](https://code.visualstudio.com/)

SQL workflows, saved queries, connections, and ERD tooling in VS Code.

## Project Overview

RunQL keeps SQL authoring, execution, saved-query documentation, schema introspection, and ERD visualization in one workspace flow.

- Run SQL with a dedicated results panel, guarded result editing, and query history
- Manage and introspect connections (PostgreSQL, MySQL, MariaDB, SecureQL, and registered connector extensions)
- Save SQL query bundles with companion Markdown metadata
- Export query/table results as CSV
- Generate multi-schema and ERD bundle artifacts as JSON you can commit
- Store your files in the workspace, user home, or a custom folder
- Optionally generate docs/comments with AI providers you control

RunQL is offline-first by default. External DB connections and hosted AI providers require network access when used.

## Key Features

### SQL Execution + Results UI
- Run active SQL with a keybinding (`Shift+Cmd+R` on macOS in SQL editors)
- Run the current statement with `Shift+Cmd+Enter` on macOS
- Run queries with or without the configured row limit
- View tabular results in the `RunQL: Results` panel
- Export CSV, build charts, and edit supported result sets inline

### Connections + Introspection
- Add/test/select connections and introspect schemas
- Reuse connection details, tag environments, and choose Data Access or DB Admin mode
- Persist schema bundles as JSON under `RunQL/schemas/<connection>/<schema>/`
- Use introspection for autocomplete, table actions, and ERD generation

### Saved Queries + Markdown
- Save SQL files into organized connection-scoped folders automatically
- Search saved queries by SQL, metadata, tags, and companion docs
- View and edit companion Markdown docs in the `RunQL: Markdown` panel

### Explorer Table Actions
- Preview top rows, create/edit tables, and show table DDL
- Generate SELECT, INSERT, UPDATE, and DELETE templates
- Dump structure, generate mock data, copy, drop, or truncate tables

### ERD
- Generate ERDs for active connections or specific schemas
- Save ERD artifacts in each schema bundle as `erd.json` and `erd.layout.json`

### Optional AI Integration
- Generate companion Markdown docs, inline SQL comments, and schema descriptions
- Use GitHub Copilot / VS Code AI, Claude Code, Codex, OpenAI, Anthropic, Azure OpenAI, Ollama, or OpenAI-compatible endpoints
- Keep AI optional; extension works without it

## Installation

### VS Code Marketplace
- Search for `RunQL` in the Extensions view and install.

### CLI (after Marketplace publish)
```bash
code --install-extension RunQL-VSCode-Extension.runql
```

### Manual VSIX
- Build a platform-specific package and install via:
```bash
npm ci
npx vsce package --target darwin-arm64  # use your platform
code --install-extension runql-*.vsix
```

## Quick Start

### 1. Open a workspace folder
RunQL can store its files in the project workspace, your user-level RunQL folder, or a custom path.

The default project layout includes queries, per-connection/per-schema bundles, and generated system artifacts.

### 2. Run your first SQL query
- Create/open a `.sql` file
- Select a connection
- Run query with `Shift+Cmd+R`

![Run SQL and inspect results](media/marketplace/screenshots/quickstart-run-sql.gif)

### 3. Introspect and explore schema
- Run `RunQL: Refresh All Schemas`
- Expand the Explorer tree
- Preview tables, generate SQL templates, or use `RunQL: View ERD (Selected Schema)` when needed

### 4. Save reusable queries
- Use `RunQL: Save Query` or `Shift+Cmd+S` on macOS in a SQL editor
- Review saved queries in the Saved Queries and Query Search views
- Add notes to the companion Markdown doc when useful

## Configuration Guide

Common settings (VS Code settings key prefix: `runql.`):

- `runql.query.maxRowsLimit`: hard result limit for SELECT queries (`0` disables limit)
- `runql.results.editing.enabled`: enable guarded inline editing for supported result sets
- `runql.ai.source`: `automatic|githubCopilot|aiExtension|directApi|off`
- `runql.ai.apiProvider`: direct API provider selection when `runql.ai.source = directApi`
- `runql.ai.model`: AI model selection
- `runql.ai.apiBaseUrl`: custom base URL for Azure OpenAI, OpenAI-compatible APIs, or non-default Ollama setups
- `runql.ai.sendSchemaContext`: include schema context in AI prompts
- `runql.format.enabled`: enable SQL formatting
- `runql.ui.showRoutines`: show procedures/functions in the Explorer
- `runql.sqlCodelens.enabled`: show RunQL actions at the top of SQL files
- `runql.storage.location`: choose `workspace`, `user`, or `custom` storage

Full reference: [`docs/configuration.md`](docs/configuration.md)

## Documentation

- [`docs/getting-started.md`](docs/getting-started.md)
- [`docs/features.md`](docs/features.md)
- [`docs/erd-guide.md`](docs/erd-guide.md)
- [`docs/database-adapters.md`](docs/database-adapters.md)
- [`docs/ai-providers.md`](docs/ai-providers.md)
- [`docs/troubleshooting.md`](docs/troubleshooting.md)
- [`docs/security.md`](docs/security.md)

## Contributing

Contributions are welcome. Please read:

- [`CONTRIBUTING.md`](CONTRIBUTING.md)
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)
- [`SECURITY.md`](SECURITY.md)

## License

This project is licensed under the MIT License. See [`LICENSE`](LICENSE).

# RunQL

[![Tests](https://github.com/DVCodeLabs/RunQL/actions/workflows/test.yml/badge.svg)](https://github.com/DVCodeLabs/RunQL/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![VS Code](https://img.shields.io/badge/vscode-%5E1.96.0-007ACC)](https://code.visualstudio.com/)

SQL workflows, connections, and ERD tooling in VS Code.

## Project Overview

RunQL keeps SQL authoring, execution, schema introspection, and ERD visualization in one workspace flow.

- Run SQL with a dedicated results panel
- Manage and introspect connections (PostgreSQL, MySQL, SecureQL, and registered connector extensions)
- Export query/table results as CSV
- Generate schema and ERD bundle artifacts as JSON you can commit
- Optionally generate docs/comments with AI providers you control

RunQL is offline-first by default. External DB connections and hosted AI providers require network access when used.

## Key Features

### SQL Execution + Results UI
- Run active SQL with a keybinding (`Shift+Cmd+R` on macOS in SQL editors)
- View tabular results in the `RunQL: Results` panel
- Export CSV and trigger chart generation hooks

### Connections + Introspection
- Add/test/select connections and introspect schemas
- Persist schema bundles as JSON under `RunQL/schemas/<connection>/`
- Use introspection for autocomplete and ERD generation

### ERD
- Generate ERDs for active connections or specific schemas
- Save ERD artifacts in each schema bundle as `erd.json` and `erd.layout.json`

### Optional AI Integration
- Generate companion Markdown docs and inline SQL comments
- Use VS Code LM API, OpenAI, Anthropic, Azure OpenAI, Ollama, or OpenAI-compatible endpoints
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
RunQL initializes a `RunQL/` structure for queries, per-connection schema bundles, and generated system artifacts.

### 2. Run your first SQL query
- Create/open a `.sql` file
- Select a connection
- Run query with `Shift+Cmd+R`

![Run SQL and inspect results](media/marketplace/screenshots/quickstart-run-sql.png)

### 3. Introspect and explore schema
- Run `RunQL: Refresh All Schemas`
- Expand the Explorer tree
- Use `RunQL: View ERD (Selected Schema)` when needed

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

# Marketplace Listing Copy

Use this document as the source of truth for VS Code Marketplace listing text.

## Extension Name

`RunQL`

## Short Description (`package.json -> description`)

`SQL workflows, connections, and ERD tooling in VS Code.`

## Marketplace Tagline (first paragraph of README)

RunQL is a VS Code extension for SQL workflows: run SQL, manage connections, introspect schemas, and generate ERD artifacts you can commit and review.

## Value Proposition Bullets

- Offline-first by default for local iteration loops
- Connection management for DuckDB, PostgreSQL, and MySQL
- Dedicated results panel with CSV export and chart hooks
- ERD generation from schema introspection snapshots
- Optional AI docs/comments with provider flexibility

## Key Features Section Copy

### SQL Execution + Results
Run active SQL from VS Code and inspect results in a dedicated panel. Export CSV and trigger chart hooks from result sets.

### Connections + Introspection
Manage DuckDB/Postgres/MySQL connections, introspect schemas, and persist snapshots for autocomplete and reviewable project context.

### ERD
Generate ERD artifacts as JSON files under `RunQL/system/` for traceability, code review, and onboarding.

### Optional AI
Generate query docs and inline SQL comments with configurable providers (or skip AI entirely).

## Positioning Snippet (vs dbt-core)

RunQL is a SQL development loop inside VS Code for ad hoc analysis and schema exploration.  
dbt-core remains the warehouse-first governance and deployment layer.  
Use RunQL to iterate quickly; promote stable logic into downstream production frameworks as needed.

## Suggested Keywords

`duckdb, sql, vscode, analytics engineering, erd, postgres, mysql`

## Release Notes Template (Marketplace)

Use this for each release entry.

```md
## RunQL vX.Y.Z

### Added
- ...

### Improved
- ...

### Fixed
- ...

### Docs
- ...

### Notes
- Offline-first behavior remains default.
- AI features remain optional and provider-configurable.
```

## v0.0.1 Release Notes Draft

```md
## RunQL v0.0.1

### Added
- SQL execution with dedicated results panel.
- Connection management and schema introspection (DuckDB, PostgreSQL, MySQL).
- ERD generation and ERD artifact persistence.
- Query history and saved query indexing.
- Optional AI helpers for Markdown docs and inline SQL comments.

### Docs
- New getting-started, feature, configuration, adapters, AI, ERD, troubleshooting, and security docs.
```

## Screenshot Captions (Marketplace)

- `quickstart-run-sql.png`: Run SQL and inspect results in VS Code

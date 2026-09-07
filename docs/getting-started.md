# Getting Started

This guide walks through first use of RunQL in a normal folder-based project.

## 1) Install

Install from VS Code Marketplace or via CLI:

```bash
code --install-extension RunQL-VSCode-Extension.runql
```

## 2) Choose Storage Location

RunQL can store queries, schema snapshots, connection profiles, and local system files in one of three modes:

- Project workspace: `RunQL/`
- User home: `~/.runql` on macOS/Linux, `%USERPROFILE%\.runql` on Windows, or `/workspaces/.runql` in GitHub Codespaces
- Custom path: an explicit folder you control

Use the Welcome page or `RunQL: Change Storage Location` to change the storage root. Use `RunQL: Open Storage Folder` when you need to inspect the active root.

## 3) Open or Initialize a Workspace Folder

In workspace storage mode, RunQL initializes a `RunQL/` folder structure for:

- `RunQL/queries/<connection>/`
- `RunQL/schemas/<connection>/<schema>/`
- `RunQL/system/`

Query files and schema bundles are designed to be committed and reviewed with your project. `RunQL/system/` contains generated indexes, prompts, migrations, and migration backups; teams usually review it before deciding what to commit.

When using user or custom storage mode, RunQL can link a project folder to the shared storage root and generate workspace guidance files so that the same SQL files and connections can be used across multiple projects.

## 4) Run Your First Query

1. Create or open a `.sql` file
2. Select a connection
3. Run `RunQL: Run Query` (default keybinding: `Shift+Cmd+R` in SQL editors)
4. Review results in `RunQL: Results`

![Run SQL in editor and inspect results](../media/marketplace/screenshots/quickstart-run-sql.gif)

Use `RunQL: Run Current Statement` for the statement under the cursor, or `RunQL: Run Query (No Limit)` when the configured row limit should be bypassed.

## 5) Save Queries

Use `RunQL: Save Query` or `Shift+Cmd+S` on macOS from a SQL editor to save a query bundle.

Saved query bundles include:

- A `.sql` file
- A companion `.md` file with title, tags, connection metadata, schema context, and notes

Saved queries appear in the Saved Queries view and can be searched from the Query Search view.

## 6) Introspect Schemas

1. Run `RunQL: Refresh All Schemas`
2. Expand the Explorer tree
3. Open table previews directly from the tree
4. Generate SQL templates, show DDL, create/edit tables, or back up schema structure from Explorer actions

## 7) Generate ERD

Run `RunQL: View ERD (Active Connection)` or `RunQL: View ERD (Selected Schema)` to render schema structure and save ERD artifacts.

ERD output is stored in the matching schema bundle:

- `RunQL/schemas/<connection>/<schema>/erd.json`
- `RunQL/schemas/<connection>/<schema>/erd.layout.json`

## 8) Optional AI Helpers

RunQL can generate query Markdown docs, inline SQL comments, and schema descriptions.

YOu can use GitHub Copilot / VS Code AI, Claude Code, Codex, direct API providers, or you can turn AI off.

## Offline Notes

RunQL is offline-first by default. External connections and hosted AI providers require network when used.

# Getting Started

This guide walks through first use of RunQL in a normal folder-based project.

## 1) Install

Install from VS Code Marketplace or via CLI:

```bash
code --install-extension RunQL-VSCode-Extension.runql
```

## 2) Open a Workspace Folder

RunQL initializes a `RunQL/` folder structure for:

- `RunQL/queries/`
- `RunQL/schemas/<connection>/`
- `RunQL/system/`

Query files and schema bundles are designed to be committed and reviewed with your project. `RunQL/system/` contains generated indexes, prompts, migrations, and migration backups; teams usually review it before deciding what to commit.

## 3) Run Your First Query

1. Create or open a `.sql` file
2. Select a connection
3. Run `RunQL: Run Query` (default keybinding: `Shift+Cmd+R` in SQL editors)
4. Review results in `RunQL: Results`

![Run SQL in editor and inspect results](../media/marketplace/screenshots/quickstart-run-sql.png)

## 4) Introspect Schemas

1. Run `RunQL: Refresh All Schemas`
2. Expand the Explorer tree
3. Open table previews directly from the tree

## 5) Generate ERD

Run `RunQL: View ERD (Active Connection)` or `RunQL: View ERD (Selected Schema)` to render schema structure and save ERD artifacts.

ERD output is stored in the matching schema bundle:

- `RunQL/schemas/<connection>/erd.json`
- `RunQL/schemas/<connection>/erd.layout.json`

## Offline Notes

RunQL is offline-first by default. External connections and hosted AI providers require network when used.

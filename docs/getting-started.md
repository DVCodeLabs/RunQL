# Getting Started

This guide walks through first use of RunQL in a normal folder-based project.

## 1) Install

Install from VS Code Marketplace or via CLI:

```bash
code --install-extension runql.runql
```

## 2) Open a Workspace Folder

RunQL initializes a `RunQL/` folder structure for:

- `RunQL/queries/`
- `RunQL/schemas/`
- `RunQL/system/`

These artifacts are designed to be committed and reviewed with your project.

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

## Offline Notes

RunQL is offline-first by default. External connections and hosted AI providers require network when used.

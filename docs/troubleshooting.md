# Troubleshooting

## Installation Issues

### Extension not loading
- Confirm VS Code version meets engine requirement (`^1.96.0`).
- Reload VS Code window after install/update.

### Commands not visible
- Ensure a workspace folder is open.
- Open command palette and search `RunQL:` commands.
- Run `RunQL: Open Welcome` if project initialization or storage setup is unclear.

## Storage Issues

### RunQL files are not where expected
- Check `runql.storage.location`.
- Use `RunQL: Open Storage Folder` to open the active storage root.
- Use `RunQL: Change Storage Location` to switch between workspace, user, or custom storage.

### Custom storage path is rejected
- Use an absolute path after `~` expansion.
- Do not use the filesystem root, a Windows drive root, the home directory itself, `/workspaces` itself in Codespaces, or a VS Code workspace folder root.
- Choose a folder RunQL can create and write to.

### Multi-root workspace picks the wrong folder
- Check `runql.storage.workspaceFolder`.
- Re-run `RunQL: Change Storage Location` and select the intended workspace owner.

## Connection Issues

### Test connection fails
- Verify host/port/database/user credentials.
- Check network access for remote DBs.
- Retry with minimal connection options.

### Introspection fails
- Validate DB permissions for metadata queries.
- Retry connection test, then introspection.
- Check Output/Developer console logs.
- For DB Admin connections, confirm the database user can read admin metadata views.

## Query Execution Issues

### Query returns too few rows
- Check `runql.query.maxRowsLimit`.
- Use run-without-limit command path when appropriate.

### Results panel is empty
- Ensure query completed successfully.
- Re-run query in the active SQL editor.

### Result editing is unavailable
- Check `runql.results.editing.enabled`.
- Confirm the connection allows data editing.
- Ensure the result set includes enough table/key metadata for safe save-back.

### SecureQL query waits for approval
- Use the approval controls in the `RunQL: Results` panel.
- Check status again if approval was granted outside the IDE.
- Re-run the approved query before the approval expires.

### Table preview opens with wrong connection
- Select the intended connection in Explorer first.
- Re-run table preview from that schema tree item.

## Saved Query Issues

### Saved query is missing
- Refresh the Saved Queries view.
- Rebuild the Query Search index.
- Check the active RunQL storage root and `RunQL/queries/<connection>/`.

### Companion Markdown is missing or stale
- Use `RunQL: View Markdown Documentation` from the SQL editor.
- Use `RunQL: Save Query` again and choose overwrite or save copy when prompted.
- Delete saved queries from RunQL so the SQL file, Markdown file, index, and view stay aligned.

## ERD Issues

### ERD view is empty
- Run schema introspection first.
- Ensure the selected schema contains tables.
- Re-open `RunQL: View ERD (Active Connection)` or `RunQL: View ERD (Selected Schema)`.

### ERD artifacts are hard to find
- Use `RunQL: Open Storage Folder`.
- Check `RunQL/schemas/<connection>/<schema>/erd.json`.
- Check `RunQL/system/migration_backup/` for migrated legacy files.

## AI Issues

### No model/provider available
- Set `runql.ai.source` first, then configure `runql.ai.model` and any matching `runql.ai.apiProvider` or `runql.ai.apiBaseUrl` settings.
- For Claude Code or Codex, set `runql.ai.source = aiExtension` and use `RunQL: Select AI Extension`.
- For local providers, verify API base URL and local model availability.
- For hosted providers, verify credentials and network access.

### Unexpected AI output
- Inspect and tune templates under `RunQL/system/prompts/`.
- Reduce or adjust schema context settings if prompts are too large.

## Where to Get Help

- Open an issue for reproducible bugs.
- Use discussions for questions/workflow guidance.
- Report vulnerabilities privately via `SECURITY.md`.

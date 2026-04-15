# Troubleshooting

## Installation Issues

### Extension not loading
- Confirm VS Code version meets engine requirement (`^1.96.0`).
- Reload VS Code window after install/update.

### Commands not visible
- Ensure a workspace folder is open.
- Open command palette and search `RunQL:` commands.

## Connection Issues

### Test connection fails
- Verify host/port/database/user credentials.
- Check network access for remote DBs.
- Retry with minimal connection options.

### Introspection fails
- Validate DB permissions for metadata queries.
- Retry connection test, then introspection.
- Check Output/Developer console logs.

## Query Execution Issues

### Query returns too few rows
- Check `runql.query.maxRowsLimit`.
- Use run-without-limit command path when appropriate.

### Results panel is empty
- Ensure query completed successfully.
- Re-run query in the active SQL editor.

### Table preview opens with wrong connection
- Select the intended connection in Explorer first.
- Re-run table preview from that schema tree item.

## ERD Issues

### ERD view is empty
- Run schema introspection first.
- Ensure the selected schema contains tables.
- Re-open `RunQL: View ERD (Active Connection)` or `RunQL: View ERD (Selected Schema)`.

## AI Issues

### No model/provider available
- Set `runql.ai.source` first, then configure `runql.ai.model` and any matching `runql.ai.apiProvider` or `runql.ai.apiBaseUrl` settings.
- For local providers, verify API base URL and local model availability.
- For hosted providers, verify credentials and network access.

### Unexpected AI output
- Inspect and tune templates under `RunQL/system/prompts/`.
- Reduce or adjust schema context settings if prompts are too large.

## Where to Get Help

- Open an issue for reproducible bugs.
- Use discussions for questions/workflow guidance.
- Report vulnerabilities privately via `SECURITY.md`.

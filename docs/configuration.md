# Configuration Guide

RunQL settings use the `runql.` prefix in VS Code.

## Query and Results

### `runql.query.maxRowsLimit`
- Type: number
- Default: `10000`
- Description: hard LIMIT for rows returned by SELECT queries. Set `0` for no LIMIT, or use the Run Query (No Limit) command path when appropriate.

### `runql.results.editing.enabled`
- Type: boolean
- Default: `true`
- Description: enable inline editing and save-back in result sets when the active connection and result safety checks allow it.

## Storage

### `runql.storage.location`
- Type: string enum
- Values: `workspace`, `user`, `custom`
- Default: `workspace`
- Description: choose where RunQL stores queries, schema snapshots, connection profiles, and local system files.

### `runql.storage.userPath`
- Type: string
- Default: `~/.runql`
- Description: user-level storage path outside GitHub Codespaces. `~` expands to the current OS user's home directory.

### `runql.storage.codespacesPath`
- Type: string
- Default: `/workspaces/.runql`
- Description: user-level storage path when running inside GitHub Codespaces.

### `runql.storage.customPath`
- Type: string
- Default: empty
- Description: custom storage path used when `runql.storage.location = custom`.

### `runql.storage.workspaceFolder`
- Type: string
- Default: empty
- Description: workspace folder URI that owns the workspace-local RunQL directory in multi-root workspace mode.

## AI

### `runql.ai.source`
- Type: string enum
- Values: `automatic`, `githubCopilot`, `aiExtension`, `directApi`, `off`
- Default: `githubCopilot`
- Description: choose how RunQL should access AI.

### `runql.ai.extension`
- Type: string enum
- Values: empty, `claudeExtension`, `codexExtension`
- Default: empty
- Description: preferred installed extension when `runql.ai.source` is `aiExtension`. RunQL can hand supported prompts to Claude Code or Codex when available.

### `runql.ai.apiProvider`
- Type: string enum
- Values: empty, `openai`, `anthropic`, `azureOpenAI`, `ollama`, `openaiCompatible`
- Default: empty
- Description: direct API provider used when `runql.ai.source` is `directApi`.

### `runql.ai.model`
- Type: string
- Default: `gpt-4.1`
- Description: model or deployment name for GitHub Copilot / VS Code AI and direct API providers.

### `runql.ai.apiBaseUrl`
- Type: string
- Default: empty
- Description: base URL for providers that need a custom server address; required for `azureOpenAI` and `openaiCompatible`.

### `runql.ai.sendSchemaContext`
- Type: boolean
- Default: `true`
- Description: include schema/metadata context in prompts.

### `runql.ai.maxSchemaChars`
- Type: number
- Default: `150000`
- Description: approximate schema context character cap.

## Formatting

### `runql.format.enabled`
- Type: boolean
- Default: `true`

### `runql.format.indentSize`
- Type: number
- Default: `2`

### `runql.format.keywordCase`
- Type: string enum
- Values: `upper`, `lower`, `preserve`
- Default: `upper`

### `runql.format.dialectFallback`
- Type: string enum
- Values: `postgresql`, `mysql`, `sql`
- Default: `sql`
- Description: fallback SQL formatter dialect when no active connection is selected.

## Explorer UI

### `runql.ui.showRoutines`
- Type: boolean
- Default: `true`
- Description: show procedures and functions in the Explorer when introspection metadata is available.

### `runql.ui.showRoutineParameters`
- Type: boolean
- Default: `true`
- Description: show routine signature details in Explorer labels/tooltips when available.

## SQL CodeLens

### `runql.sqlCodelens.enabled`
- Type: boolean
- Default: `true`
- Description: display RunQL actions and connection selector in SQL files.

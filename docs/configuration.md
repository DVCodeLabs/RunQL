# Configuration Guide

RunQL settings use the `runql.` prefix in VS Code.

## Query and Results

### `runql.query.maxRowsLimit`
- Type: number
- Default: `1000`
- Description: hard LIMIT for rows returned by SELECT queries. Set `0` to disable.

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
- Description: preferred installed extension when `runql.ai.source` is `aiExtension`.

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

## SQL CodeLens

### `runql.sqlCodelens.enabled`
- Type: boolean
- Default: `true`
- Description: display RunQL actions and connection selector in SQL files.

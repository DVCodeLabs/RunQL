# Configuration Guide

RunQL settings use the `runql.` prefix in VS Code.

## Query and Results

### `runql.query.maxRowsLimit`
- Type: number
- Default: `1000`
- Description: hard LIMIT for rows returned by SELECT queries. Set `0` to disable.

## AI

### `runql.ai.provider`
- Type: string enum
- Values: `none`, `vscode`, `openai`, `anthropic`, `azureOpenAI`, `ollama`, `openaiCompatible`
- Default: `vscode`

### `runql.ai.model`
- Type: string
- Default: `gpt-4o`
- Description: provider-specific model identifier.

### `runql.ai.endpoint`
- Type: string
- Default: empty
- Description: custom endpoint for compatible or self-hosted providers.

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

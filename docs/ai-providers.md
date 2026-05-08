# AI Provider Setup

AI features in RunQL are optional. The extension works without AI configured.

## The Main Settings

### `runql.ai.source`
This is the primary setting. It answers: "How should RunQL access AI?"

Choose one of these:

- `githubCopilot` (`GitHub Copilot / VS Code AI`): use the AI already available in VS Code, typically GitHub Copilot.
- `aiExtension` (`AI Extension`): send supported AI tasks to another installed extension such as Claude Code or Codex.
- `directApi` (`Direct API`): call your own provider or local model server.
- `automatic` (`Automatic`): let RunQL choose the best available option for the current editor.
- `off` (`Off`): disable AI features and use Copy Prompt instead.

### `runql.ai.extension`
This only matters when `runql.ai.source = aiExtension`.

Use it to choose:

- `claudeExtension` (`Claude Code`)
- `codexExtension` (`Codex`)

If left on automatic, RunQL will choose from supported installed extensions.

### `runql.ai.apiProvider`
This only matters when `runql.ai.source = directApi`.

Choose one of these:

- `openai` (`OpenAI`)
- `anthropic` (`Anthropic`)
- `azureOpenAI` (`Azure OpenAI`)
- `ollama` (`Ollama`)
- `openaiCompatible` (`OpenAI-Compatible`)

### `runql.ai.model`
This is used when the selected AI source supports model selection.

Use it for:

- `GitHub Copilot / VS Code AI`
- `Direct API`

It is ignored for:

- `AI Extension`

It is optional for:

- `Ollama`

### `runql.ai.apiBaseUrl`
This is the base URL for providers that need a custom server address.

Required for:

- `Azure OpenAI`
- `OpenAI-Compatible`

Optional override for:

- `OpenAI`
- `Anthropic`
- `Ollama`

Not used for:

- `GitHub Copilot / VS Code AI`
- `AI Extension`

## Common Setup Patterns

### Use the IDE's built-in AI experience

Set:

- `runql.ai.source = githubCopilot`

You usually do not need `runql.ai.apiBaseUrl`.

### Use Claude Code or Codex

Set:

- `runql.ai.source = aiExtension`
- `runql.ai.extension` if you want to force Claude Code or Codex instead of automatic selection

This path is best for supported edit and generation tasks that RunQL can hand off directly to another extension.

### Use OpenAI, Anthropic, or Azure directly

Set:

- `runql.ai.source = directApi`
- `runql.ai.apiProvider`
- `runql.ai.model`
- API key in secret storage

Also set `runql.ai.apiBaseUrl` for Azure OpenAI.

### Use Ollama

Set:

- `runql.ai.source = directApi`
- `runql.ai.apiProvider = ollama`

Optionally set:

- `runql.ai.apiBaseUrl` if Ollama is not running at `http://localhost:11434`
- `runql.ai.model` if you want to pin a specific model name

### Use another OpenAI-compatible server

Set:

- `runql.ai.source = directApi`
- `runql.ai.apiProvider = openaiCompatible`
- `runql.ai.model`
- `runql.ai.apiBaseUrl`

## AI Features

- Query Markdown documentation generation
- Inline SQL comments generation
- Optional chart mapping suggestions

## Prompt Templates

RunQL stores templates in:

- `RunQL/system/prompts/markdownDoc.txt`
- `RunQL/system/prompts/inlineComments.txt`
- `RunQL/system/prompts/describeSchema.txt`

You can customize these to enforce team writing conventions.

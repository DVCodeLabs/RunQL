# AI Provider Setup

AI features in RunQL are optional. The extension works without AI providers.

## Supported Providers

- VS Code LM API (`vscode`)
- OpenAI (`openai`)
- Anthropic (`anthropic`)
- Azure OpenAI (`azureOpenAI`)
- Ollama (`ollama`)
- OpenAI-compatible endpoint (`openaiCompatible`)

## Provider Selection

Set:

- `runql.ai.provider`
- `runql.ai.model`
- `runql.ai.endpoint` (when required)

Use `RunQL: Select AI Model` to choose from available model options.

## Common Setup Patterns

## `vscode`
- Best for users already using a VS Code agent/chat model ecosystem.
- No external endpoint required in common cases.

## `ollama`
- Use local models for offline/private flows.
- Set endpoint if not default (`http://localhost:11434`).

## Hosted APIs
- OpenAI/Anthropic/Azure OpenAI require network and credentials.
- Prefer secure secret storage, not plain-text committed settings.

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

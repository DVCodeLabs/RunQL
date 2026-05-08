# Security and Secrets Guide

This guide describes how to operate RunQL safely in local-first and team environments.

## Default Security Posture

- RunQL is offline-first by default.
- Core workflows can run without cloud services.
- Local artifacts are persisted in your workspace under `RunQL/`.

## Credential Handling

- Do not commit credentials, API keys, or passwords.
- Prefer VS Code secret storage and environment-based secret injection.
- Review settings before sharing workspace files.

## AI Provider Safety

- Use `runql.ai.source = off` for fully offline/no-AI environments.
- For hosted providers, treat API base URLs and credentials as sensitive.
- For local models (for example, Ollama), verify local endpoint controls.

## Artifact Review Before Commit

Review these paths before pushing:

- `RunQL/schemas/<connection>/schema.json`
- `RunQL/schemas/<connection>/description.json`
- `RunQL/schemas/<connection>/custom.relationships.json`
- `RunQL/schemas/<connection>/erd.json`
- `RunQL/schemas/<connection>/erd.layout.json`
- `RunQL/system/prompts/`
- `RunQL/system/migration_backup/`
- Query Markdown docs

These files are intended to be reviewable artifacts, but should still be checked for sensitive data.

## Vulnerability Reporting

For security issues, follow private disclosure in [`../SECURITY.md`](../SECURITY.md).

# Security and Secrets Guide

This guide describes how to operate RunQL safely in local-first and team environments.

## Default Security Posture

- RunQL is offline-first by default.
- Core workflows can run without cloud services.
- Local artifacts are persisted in the configured RunQL storage root.
- Storage can be workspace-local, user-level, or custom.

## Credential Handling

- Do not commit credentials, API keys, or passwords.
- Prefer VS Code secret storage and environment-based secret injection.
- Treat SSH passwords, pasted private keys, and key passphrases as secrets.
- Review settings before sharing workspace files.

## AI Provider Safety

- Use `runql.ai.source = off` for fully offline/no-AI environments.
- For hosted providers, treat API base URLs and credentials as sensitive.
- For local models (for example, Ollama), verify local endpoint controls.

## Artifact Review Before Commit

Review these paths before pushing:

- `RunQL/schemas/<connection>/manifest.json`
- `RunQL/schemas/<connection>/<schema>/schema.json`
- `RunQL/schemas/<connection>/<schema>/description.json`
- `RunQL/schemas/<connection>/<schema>/custom.relationships.json`
- `RunQL/schemas/<connection>/<schema>/erd.json`
- `RunQL/schemas/<connection>/<schema>/erd.layout.json`
- `RunQL/queries/<connection>/`
- `RunQL/system/connections.json`
- `RunQL/system/prompts/`
- `RunQL/system/migration_backup/`
- Query Markdown docs

These files are intended to be reviewable artifacts, but should still be checked for sensitive data.

## SecureQL Controls

- RunQL respects SecureQL-provided CSV export and data editing permissions.
- Protected queries can require SecureQL approval before execution.

## Optional Welcome Signal

- The Welcome and What's New pages can show an optional "Using RunQL Today?" button.
- After a successful query run, RunQL can show the same optional prompt once per day as a toast.
- Clicking the button or toast action sends an empty `POST` request to the configured `runql.welcome.sendUsSomeLoveUrl`.
- Official builds default to `https://runql.com/api/send-us-some-love`.
- No RunQL workspace, query, schema, connection, or version data is sent.
- Set `runql.welcome.sendUsSomeLove = false` or clear `runql.welcome.sendUsSomeLoveUrl` to hide the button and skip the toast.
- Set `runql.welcome.sendUsSomeLoveToast = false` to keep the Welcome button but turn off the daily toast.

## Vulnerability Reporting

For security issues, follow private disclosure in [`../SECURITY.md`](../SECURITY.md).

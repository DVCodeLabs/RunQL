# ERD Guide

RunQL can generate ERDs from introspected schemas and save artifacts in your workspace.

## Commands

- `RunQL: View ERD (Active Connection)`
- `RunQL: View ERD (Selected Schema)`

## Prerequisites

1. Add/select a connection
2. Run schema introspection
3. Open ERD command from command palette or view actions

## Output Artifacts

ERD files are persisted in:

- `RunQL/schemas/<connection>/erd.json`
- `RunQL/schemas/<connection>/erd.layout.json`

The same bundle also contains schema-sidecar files such as:

- `RunQL/schemas/<connection>/schema.json`
- `RunQL/schemas/<connection>/description.json`
- `RunQL/schemas/<connection>/custom.relationships.json`

These files are useful for:

- Code review context
- Onboarding
- Historical schema snapshots tied to a commit

## Troubleshooting

- Empty ERD: refresh introspection first
- Missing tables: check schema filters/system-schema visibility
- Stale graph: rerun introspection and regenerate ERD
- Missing legacy ERD file: check the matching schema bundle; old `RunQL/system/erd/` files are migrated into bundles and backed up under `RunQL/system/migration_backup/`

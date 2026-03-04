# ERD Guide

RunQL can generate ERDs from introspected schemas and save artifacts in your workspace.

## Commands

- `RunQL: View ERD (Active Connection)`
- `RunQL: View ERD (Data Work DB)`
- `RunQL: View ERD (Selected Schema)`

## Prerequisites

1. Add/select a connection
2. Run schema introspection
3. Open ERD command from command palette or view actions

## Output Artifacts

ERD files are persisted in:

- `RunQL/system/erd/<connection-name>.erd.json`

These files are useful for:

- Code review context
- Onboarding
- Historical schema snapshots tied to a commit

## Troubleshooting

- Empty ERD: refresh introspection first
- Missing tables: check schema filters/system-schema visibility
- Stale graph: rerun introspection and regenerate ERD


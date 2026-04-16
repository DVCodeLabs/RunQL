import * as vscode from 'vscode';
import { loadConnectionProfiles } from '../connections/connectionStore';
import { resolveEffectiveSqlDialect } from '../core/sqlUtils';

export interface ResolvedConnectionInfo {
    connectionId?: string;
    connectionName: string;
    dialect: string;
}

export async function resolveConnectionInfo(
    context: vscode.ExtensionContext,
    doc: vscode.TextDocument
): Promise<ResolvedConnectionInfo> {
    const docKey = doc.uri.toString();
    const docConnections = context.workspaceState.get<Record<string, string>>('runql.docConnections.v1', {});
    const docConnId = docConnections[docKey];
    const activeId = context.workspaceState.get<string>('runql.activeConnectionId');
    const connectionId = docConnId || activeId;

    let connectionName = 'none';
    let dialect = 'unknown';

    if (connectionId) {
        const profiles = await loadConnectionProfiles();
        const profile = profiles.find((p) => p.id === connectionId);
        if (profile) {
            connectionName = profile.name;
            dialect = resolveEffectiveSqlDialect(profile);
        }
    }

    return { connectionId, connectionName, dialect };
}

import * as vscode from "vscode";
import { DPDocConnectionStore } from "./sqlCodelens";
import { loadConnectionProfiles } from "../connections/connectionStore";
import { queryIndex } from "../queryLibrary/queryIndex";
import { resolveEffectiveSqlDialect } from "../core/sqlUtils";
import { loadSchemas } from "../schema/schemaStore";
import type { QuerySchemaContext, SchemaModel } from "../core/types";

async function updateQueryMdConnection(docUri: vscode.Uri, connectionName: string, connectionId?: string, dialect?: string) {
    if (!docUri.fsPath.endsWith(".sql")) return;
    const mdPath = docUri.fsPath.replace(/\.sql$/i, ".md");
    const mdUri = vscode.Uri.file(mdPath);

    let raw: Uint8Array;
    try {
        raw = await vscode.workspace.fs.readFile(mdUri);
    } catch {
        return;
    }

    const text = new TextDecoder("utf-8").decode(raw);
    if (!text.startsWith("---")) return;

    const lines = text.split(/\r?\n/);
    const endIndex = lines.findIndex((line, idx) => idx > 0 && line.trim() === "---");
    if (endIndex === -1) return;

    let connectionReplaced = false;
    let connectionIdReplaced = false;
    let dialectReplaced = false;
    for (let i = 1; i < endIndex; i += 1) {
        if (lines[i].startsWith("connection:")) {
            lines[i] = `connection: "${connectionName}"`;
            connectionReplaced = true;
        }
        if (typeof connectionId === "string" && lines[i].startsWith("connection_id:")) {
            lines[i] = `connection_id: "${connectionId}"`;
            connectionIdReplaced = true;
        }
        if (dialect && lines[i].startsWith("dialect:")) {
            lines[i] = `dialect: "${dialect}"`;
            dialectReplaced = true;
        }
    }

    let insertIndex = endIndex;
    if (!connectionReplaced) {
        lines.splice(insertIndex, 0, `connection: "${connectionName}"`);
        insertIndex += 1;
    }
    if (typeof connectionId === "string" && !connectionIdReplaced) {
        lines.splice(insertIndex, 0, `connection_id: "${connectionId}"`);
        insertIndex += 1;
    }
    if (dialect && !dialectReplaced) {
        lines.splice(insertIndex, 0, `dialect: "${dialect}"`);
    }

    const updated = lines.join("\n");
    await vscode.workspace.fs.writeFile(mdUri, new TextEncoder().encode(updated));
}

async function updateQueryMdSchemaContext(docUri: vscode.Uri, schemaContext?: QuerySchemaContext) {
    if (!docUri.fsPath.endsWith(".sql")) return;
    const mdPath = docUri.fsPath.replace(/\.sql$/i, ".md");
    const mdUri = vscode.Uri.file(mdPath);

    let raw: Uint8Array;
    try {
        raw = await vscode.workspace.fs.readFile(mdUri);
    } catch {
        return;
    }

    const text = new TextDecoder("utf-8").decode(raw);
    if (!text.startsWith("---")) return;

    const lines = text.split(/\r?\n/);
    const endIndex = lines.findIndex((line, idx) => idx > 0 && line.trim() === "---");
    if (endIndex === -1) return;

    const filtered = lines.filter((line, idx) => {
        if (idx <= 0 || idx >= endIndex) return true;
        return !line.startsWith("schema_context:") && !line.startsWith("catalog_context:");
    });
    const filteredEndIndex = filtered.findIndex((line, idx) => idx > 0 && line.trim() === "---");

    if (schemaContext?.defaultSchema) {
        const insert = [
            ...(schemaContext.defaultCatalog ? [`catalog_context: "${schemaContext.defaultCatalog}"`] : []),
            `schema_context: "${schemaContext.defaultSchema}"`,
        ];
        filtered.splice(filteredEndIndex, 0, ...insert);
    }

    await vscode.workspace.fs.writeFile(mdUri, new TextEncoder().encode(filtered.join("\n")));
}

function buildSchemaContextOption(
    schema: SchemaModel,
): { label: string; context: QuerySchemaContext } {
    const defaultSchema = schema.name;
    const defaultCatalog = schema.catalog;
    return {
        label: defaultCatalog ? `${defaultCatalog}.${defaultSchema}` : defaultSchema,
        context: {
            ...(defaultCatalog ? { defaultCatalog } : {}),
            defaultSchema,
        },
    };
}

export function registerSqlCodelensCommands(
    context: vscode.ExtensionContext,
    store: DPDocConnectionStore,
    providerRefresh: () => void,
    onConnectionChanged?: () => void
) {
    context.subscriptions.push(
        vscode.commands.registerCommand("runql.sql.setConnectionForDoc", async (uri: vscode.Uri, connectionId?: string) => {
            // Ensure we have a valid URI
            if (!uri) {
                const editor = vscode.window.activeTextEditor;
                if (!editor) return;
                uri = editor.document.uri;
            }

            const doc = await vscode.workspace.openTextDocument(uri);

            // Bypass UI if connectionId is provided
            if (connectionId) {
                const profiles = await loadConnectionProfiles();
                const profile = profiles.find(p => p.id === connectionId);
                if (profile) {
                    const effectiveDialect = resolveEffectiveSqlDialect(profile);
                    await store.set(doc, connectionId);
                    await store.clearSchemaContext(doc);
                    await updateQueryMdSchemaContext(doc.uri);
                    // Update Index
                    await queryIndex.updateConnectionContext(doc.uri, profile.id, profile.name, effectiveDialect);
                    await updateQueryMdConnection(doc.uri, profile.name, profile.id, effectiveDialect);

                    providerRefresh();
                    onConnectionChanged?.();
                    return;
                }
            }

            // Load connections dynamically from the store
            const profiles = await loadConnectionProfiles();
            const connections = profiles.map(p => ({
                label: p.name,
                description: `${p.dialect}${p.database ? ` • ${p.database}` : ''}`,
                id: p.id,
                profile: p
            }));

            if (!connections.length) {
                vscode.window.showWarningMessage("RunQL: No connections available. Add one first.");
                return;
            }

            const picked = await vscode.window.showQuickPick(
                connections,
                { title: "Select connection for this SQL tab" }
            );

            if (!picked) return;

            const effectiveDialect = picked.profile ? resolveEffectiveSqlDialect(picked.profile) : 'duckdb';
            await store.set(doc, picked.id);
            await store.clearSchemaContext(doc);
            await updateQueryMdSchemaContext(doc.uri);
            await updateQueryMdConnection(doc.uri, picked.label, picked.id, effectiveDialect);

            // Update Index (Source of Truth)
            await queryIndex.updateConnectionContext(doc.uri, picked.id, picked.label, effectiveDialect);

            // Also update running context if this is the active document
            if (vscode.window.activeTextEditor?.document.uri.toString() === doc.uri.toString()) {
                await context.workspaceState.update("runql.activeConnectionId", picked.id);
                // We might want to trigger context updates here too if needed
            }

            providerRefresh();
            onConnectionChanged?.();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("runql.sql.setSchemaContextForDoc", async (uri: vscode.Uri) => {
            if (!uri) {
                const editor = vscode.window.activeTextEditor;
                if (!editor) return;
                uri = editor.document.uri;
            }

            const doc = await vscode.workspace.openTextDocument(uri);
            const profiles = await loadConnectionProfiles();
            const connectionId = store.get(doc) ?? context.workspaceState.get<string>("runql.activeConnectionId");
            const profile = profiles.find(p => p.id === connectionId);

            if (!profile) {
                vscode.window.showWarningMessage("RunQL: Select a connection before choosing a schema.");
                return;
            }

            const allSchemas = await loadSchemas();
            const schemaInfo = allSchemas.find(schema => schema.connectionId === profile.id);
            const schemas = (schemaInfo?.schemas ?? [])
                .filter(schema => Boolean(schema.name))
                .sort((a, b) => {
                    const left = a.catalog ? `${a.catalog}.${a.name}` : a.name;
                    const right = b.catalog ? `${b.catalog}.${b.name}` : b.name;
                    return left.localeCompare(right);
                });

            const options: Array<{
                label: string;
                description?: string;
                context?: QuerySchemaContext;
            }> = [
                { label: 'None', description: 'Require fully qualified table references' },
                ...schemas.map(schema => buildSchemaContextOption(schema)),
            ];

            const picked = await vscode.window.showQuickPick(options, {
                title: "Select schema context for this SQL tab",
            });
            if (!picked) return;

            if (picked.label === 'None') {
                await store.clearSchemaContext(doc);
                await updateQueryMdSchemaContext(doc.uri);
            } else {
                if (!picked.context) {
                    vscode.window.showWarningMessage("RunQL: Could not resolve the selected schema context.");
                    return;
                }
                await store.setSchemaContext(doc, picked.context);
                await updateQueryMdSchemaContext(doc.uri, picked.context);
            }

            await queryIndex.updateFile(doc.uri);
            providerRefresh();
            onConnectionChanged?.();
        })
    );
}

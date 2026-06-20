import * as vscode from "vscode";

type ConnectionId = string;
export interface DocSchemaContext {
    defaultSchema: string;
    defaultCatalog?: string;
}

const STATE_KEY = "runql.docConnections.v1";
const SCHEMA_CONTEXT_STATE_KEY = "runql.docSchemaContexts.v1";

function getDocKey(doc: vscode.TextDocument) {
    return doc.uri.toString();
}

export class DPDocConnectionStore {
    private mem = new Map<string, ConnectionId>();
    private schemaContexts = new Map<string, DocSchemaContext>();
    constructor(private workspaceState: vscode.Memento) { }

    loadFromWorkspaceState() {
        const saved = this.workspaceState.get<Record<string, ConnectionId>>(STATE_KEY, {});
        for (const [k, v] of Object.entries(saved)) this.mem.set(k, v);
        const savedSchemaContexts = this.workspaceState.get<Record<string, DocSchemaContext>>(SCHEMA_CONTEXT_STATE_KEY, {});
        for (const [k, v] of Object.entries(savedSchemaContexts)) {
            if (v?.defaultSchema) this.schemaContexts.set(k, v);
        }
    }

    private persist() {
        const obj: Record<string, ConnectionId> = {};
        for (const [k, v] of this.mem.entries()) obj[k] = v;
        return this.workspaceState.update(STATE_KEY, obj);
    }

    private persistSchemaContexts() {
        const obj: Record<string, DocSchemaContext> = {};
        for (const [k, v] of this.schemaContexts.entries()) obj[k] = v;
        return this.workspaceState.update(SCHEMA_CONTEXT_STATE_KEY, obj);
    }

    get(doc: vscode.TextDocument): ConnectionId | undefined {
        return this.mem.get(getDocKey(doc));
    }

    async set(doc: vscode.TextDocument, id: ConnectionId) {
        this.mem.set(getDocKey(doc), id);
        await this.persist();
    }

    async clear(doc: vscode.TextDocument) {
        this.mem.delete(getDocKey(doc));
        await this.persist();
    }

    getSchemaContext(doc: vscode.TextDocument): DocSchemaContext | undefined {
        return this.schemaContexts.get(getDocKey(doc));
    }

    async setSchemaContext(doc: vscode.TextDocument, context: DocSchemaContext) {
        this.schemaContexts.set(getDocKey(doc), context);
        await this.persistSchemaContexts();
    }

    async clearSchemaContext(doc: vscode.TextDocument) {
        this.schemaContexts.delete(getDocKey(doc));
        await this.persistSchemaContexts();
    }
}

export class DPSqlCodelensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

    constructor(
        private store: DPDocConnectionStore,
        private getConnectionLabel: (id?: string) => string,
        private getSchemaContextLabel?: (document: vscode.TextDocument, connectionId?: string) => string | undefined,
    ) { }

    refresh() {
        this._onDidChangeCodeLenses.fire();
    }

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const enabled = vscode.workspace.getConfiguration("runql").get<boolean>("sqlCodelens.enabled", true);
        if (!enabled) return [];

        // Put lenses at top of file (line 0)
        const pos = new vscode.Position(0, 0);
        const range = new vscode.Range(pos, pos);

        const connectionId = this.store.get(document);
        const connectionLabel = this.getConnectionLabel(connectionId);

        const lenses: vscode.CodeLens[] = [];

        // Connection selector lens
        const displayLabel = connectionLabel === "Select Connection" ? "Default or No connection" : connectionLabel;
        lenses.push(new vscode.CodeLens(range, {
            title: `$(database) ${displayLabel} $(chevron-down)`,
            command: "runql.sql.setConnectionForDoc",
            arguments: [document.uri]
        }));

        const schemaContextLabel = this.getSchemaContextLabel?.(document, connectionId);
        if (schemaContextLabel) {
            lenses.push(new vscode.CodeLens(range, {
                title: `\u00A0\u00A0$(symbol-namespace) Schema: ${schemaContextLabel} $(chevron-down)`,
                command: "runql.sql.setSchemaContextForDoc",
                arguments: [document.uri]
            }));
        }

        // For notebooks, we skip the rest (Explain, Comment, Doc, Run, etc.)
        // as they clutter the cell UI and have their own toolbar/status bar controls.
        if (document.uri.scheme === 'vscode-notebook-cell') {
            return lenses;
        }

        // Spacer to separate items visually (since we can't control the | separator)
        const spacer = "\u00A0\u00A0\u00A0";
        const smallSpacer = "\u00A0";

        lenses.push(new vscode.CodeLens(range, {
            title: `${spacer}$(output)${smallSpacer}Comment`,
            command: "runql.query.addInlineComments",
            arguments: [document.uri]
        }));

        lenses.push(new vscode.CodeLens(range, {
            title: `${spacer}$(markdown)${smallSpacer}Document`,
            command: "runql.query.generateMarkdownDoc",
            arguments: [document.uri]
        }));

        lenses.push(new vscode.CodeLens(range, {
            title: `${spacer}$(trash)${smallSpacer}Delete`,
            command: "runql.query.deleteSaved",
            arguments: [document.uri]
        }));

        if (enabled) {
            const formatEnabled = vscode.workspace.getConfiguration("runql").get<boolean>("format.enabled", true);
            if (formatEnabled) {
                lenses.push(new vscode.CodeLens(range, {
                    title: `${spacer}$(list-unordered)${smallSpacer}Format`,
                    command: "runql.sql.formatDocument"
                }));
            }
        }

        lenses.push(new vscode.CodeLens(range, {
            title: `${spacer}$(save)${smallSpacer}Save${smallSpacer}(⌘⇧S)`,
            command: "runql.query.saveSqlFile",
            arguments: [document.uri]
        }));

        lenses.push(new vscode.CodeLens(range, {
            title: `${spacer}$(play)${smallSpacer}Run (no LIMIT)`,
            command: "runql.query.runNoLimit",
            arguments: [document.uri]
        }));

        lenses.push(new vscode.CodeLens(range, {
            title: `${spacer}$(play)${smallSpacer}Run${smallSpacer}(⌘⇧R)`,
            command: "runql.query.run",
            arguments: [document.uri]
        }));

        return lenses;
    }
}

import * as vscode from 'vscode';
import { loadSchemas, getSchemaVersion } from '../schema/schemaStore';
import { SchemaIntrospection, TableModel } from '../core/types';

interface ConnectionItems {
    schemas: SchemaIntrospection[];
    tableItems: vscode.CompletionItem[];
    allColumnItems: vscode.CompletionItem[];
}

interface SchemaCache {
    version: number;
    schemas: SchemaIntrospection[];
    perConnection: Map<string, ConnectionItems>;
}

const ALL_CONNECTIONS_KEY = '__all__';

export class DPCompletionProvider implements vscode.CompletionItemProvider {
    private cache: SchemaCache | null = null;

    constructor(private getConnectionId: (doc: vscode.TextDocument) => string | undefined) { }


    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        _context: vscode.CompletionContext
    ): Promise<vscode.CompletionItem[]> {

        // 1. Load schemas (only re-read from disk if version changed)
        const currentVersion = getSchemaVersion();
        if (!this.cache || this.cache.version !== currentVersion) {
            this.cache = {
                version: currentVersion,
                schemas: await loadSchemas(),
                perConnection: new Map(),
            };
        }

        // 2. Get items scoped to the editor's connection (build & memoize on first use)
        const connectionId = this.getConnectionId(document);
        const { schemas, tableItems, allColumnItems } = this.getItemsForConnection(connectionId);

        // 2. Analyze context - get ALL text before cursor, not just current line
        const textBeforeCursor = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
        const linePrefix = document.lineAt(position).text.substr(0, position.character);

        // CASE A: Triggered by dot '.' -> Column completion (for alias or table)
        if (linePrefix.trim().endsWith('.')) {
            return this.provideColumnCompletions(linePrefix, textBeforeCursor, schemas, tableItems, allColumnItems);
        }

        // CASE B: Keyword Context Heuristic - look at ALL text before cursor
        const keyword = this.getLastKeyword(textBeforeCursor);
        if (keyword) {
            if (['FROM', 'JOIN', 'UPDATE', 'INTO'].includes(keyword)) {
                return tableItems;
            }
            if (['SELECT', 'WHERE', 'HAVING', 'SET', 'BY', 'AND', 'OR'].includes(keyword)) {
                return allColumnItems;
            }
        }

        return [];
    }

    private getLastKeyword(textBeforeCursor: string): string | undefined {
        // Look at all text before cursor to find the last SQL keyword
        // This handles multi-line SQL properly

        // Simple tokenizer: replace parens/commas/newlines with space, split by whitespace
        const tokens = textBeforeCursor.replace(/[\(\),\n\r]/g, ' ').trim().split(/\s+/);

        // Iterate backwards to find the last SQL keyword
        for (let i = tokens.length - 1; i >= 0; i--) {
            const word = tokens[i].toUpperCase();
            if (['SELECT', 'FROM', 'JOIN', 'WHERE', 'UPDATE', 'INTO', 'SET', 'HAVING', 'GROUP', 'ORDER', 'BY', 'AND', 'OR'].includes(word)) {
                return word;
            }
        }
        return undefined;
    }

    private getItemsForConnection(connectionId: string | undefined): ConnectionItems {
        const cache = this.cache!;
        const key = connectionId ?? ALL_CONNECTIONS_KEY;
        const existing = cache.perConnection.get(key);
        if (existing) {
            return existing;
        }
        const schemas = connectionId
            ? cache.schemas.filter(s => s.connectionId === connectionId)
            : cache.schemas;
        const built: ConnectionItems = {
            schemas,
            tableItems: this.buildTableCompletions(schemas),
            allColumnItems: this.buildAllColumnCompletions(schemas),
        };
        cache.perConnection.set(key, built);
        return built;
    }

    private buildTableCompletions(introspections: SchemaIntrospection[]): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];
        const addedSchemas = new Set<string>();

        for (const intro of introspections) {
            for (const schema of intro.schemas) {
                // Add schema name as a completion item (so user can type "schema." to get tables)
                if (!addedSchemas.has(schema.name) && schema.name !== 'default' && schema.name !== 'public' && schema.name !== 'main') {
                    const schemaItem = new vscode.CompletionItem(schema.name, vscode.CompletionItemKind.Module);
                    const totalObjects = schema.tables.length + (schema.views?.length || 0);
                    schemaItem.detail = `Schema (${totalObjects} tables/views)`;
                    schemaItem.insertText = schema.name; // Just the schema name, user adds "."
                    items.push(schemaItem);
                    addedSchemas.add(schema.name);
                }

                for (const table of schema.tables) {
                    const item = new vscode.CompletionItem(table.name, vscode.CompletionItemKind.Class);
                    item.detail = `${schema.name}.${table.name} (${intro.connectionName || intro.connectionId})`;
                    items.push(item);

                    // Also add schema-qualified suggestion
                    if (schema.name !== 'default' && schema.name !== 'public') {
                        const qualItem = new vscode.CompletionItem(`${schema.name}.${table.name}`, vscode.CompletionItemKind.Class);
                        qualItem.detail = `Full path`;
                        items.push(qualItem);
                    }
                }

                for (const view of (schema.views || [])) {
                    const item = new vscode.CompletionItem(view.name, vscode.CompletionItemKind.Interface);
                    item.detail = `View: ${schema.name}.${view.name} (${intro.connectionName || intro.connectionId})`;
                    items.push(item);

                    if (schema.name !== 'default' && schema.name !== 'public') {
                        const qualItem = new vscode.CompletionItem(`${schema.name}.${view.name}`, vscode.CompletionItemKind.Interface);
                        qualItem.detail = `Full path (view)`;
                        items.push(qualItem);
                    }
                }
            }
        }
        return items;
    }

    private provideColumnCompletions(
        linePrefix: string,
        textBeforeCursor: string,
        introspections: SchemaIntrospection[],
        tableItems: vscode.CompletionItem[],
        allColumnItems: vscode.CompletionItem[],
    ): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];
        const match = linePrefix.match(/([a-zA-Z0-9_]+)\.$/);

        if (match) {
            const aliasOrTable = match[1].toLowerCase();
            const resolved = this.resolveAlias(textBeforeCursor, aliasOrTable) ?? aliasOrTable;

            // 1. Prefix matches a table/view name (after alias resolution) -> columns of that table
            for (const intro of introspections) {
                for (const schema of intro.schemas) {
                    const table = schema.tables.find(t => t.name.toLowerCase() === resolved)
                        || (schema.views || []).find(v => v.name.toLowerCase() === resolved);
                    if (table) {
                        items.push(...this.columnsToItems(table));
                    }
                }
            }

            // 2. Prefix matches a schema name (e.g. "data_cache.") -> tables and views in that schema
            for (const intro of introspections) {
                for (const schema of intro.schemas) {
                    if (schema.name.toLowerCase() === aliasOrTable) {
                        for (const table of schema.tables) {
                            const item = new vscode.CompletionItem(table.name, vscode.CompletionItemKind.Class);
                            item.detail = `Table in ${schema.name}`;
                            items.push(item);
                        }
                        for (const view of (schema.views || [])) {
                            const item = new vscode.CompletionItem(view.name, vscode.CompletionItemKind.Interface);
                            item.detail = `View in ${schema.name}`;
                            items.push(item);
                        }
                    }
                }
            }

            if (items.length > 0) {
                return items;
            }
        }

        // 3. Fallback: prefix didn't resolve, offer everything so the user's typing can filter
        return [...tableItems, ...allColumnItems];
    }

    private static readonly ALIAS_STOP_WORDS = new Set([
        'WHERE', 'ORDER', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET', 'ON', 'USING',
        'INNER', 'LEFT', 'RIGHT', 'OUTER', 'FULL', 'CROSS', 'NATURAL', 'JOIN',
        'AND', 'OR', 'UNION', 'INTERSECT', 'EXCEPT', 'SELECT', 'FROM', 'SET',
        'VALUES', 'RETURNING', 'WINDOW', 'FETCH', 'FOR',
    ]);

    private resolveAlias(textBeforeCursor: string, alias: string): string | undefined {
        // Strip comments and string literals so their contents can't masquerade as FROM/JOIN clauses.
        const sanitized = textBeforeCursor
            .replace(/--[^\n]*/g, ' ')
            .replace(/\/\*[\s\S]*?\*\//g, ' ')
            .replace(/'(?:[^']|'')*'/g, "''");

        const re = /\b(?:FROM|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?)(?:\s+(?:AS\s+)?([a-zA-Z_][a-zA-Z0-9_]*))?/gi;
        let m: RegExpExecArray | null;
        let resolved: string | undefined;
        while ((m = re.exec(sanitized)) !== null) {
            const tableBare = m[1].split('.').pop()!.toLowerCase();
            const candidateAlias = m[2];
            const explicitAlias = candidateAlias && !DPCompletionProvider.ALIAS_STOP_WORDS.has(candidateAlias.toUpperCase())
                ? candidateAlias.toLowerCase()
                : undefined;
            const effective = explicitAlias ?? tableBare;
            if (effective === alias) {
                // Later occurrences (e.g. inside a subquery the user is now editing) win.
                resolved = tableBare;
            }
        }
        return resolved;
    }

    private buildAllColumnCompletions(introspections: SchemaIntrospection[]): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];
        for (const intro of introspections) {
            for (const schema of intro.schemas) {
                for (const table of schema.tables) {
                    for (const c of table.columns) {
                        const item = new vscode.CompletionItem(c.name, vscode.CompletionItemKind.Field);
                        item.detail = `${c.type} (${table.name})`;
                        items.push(item);
                    }
                }
                for (const view of (schema.views || [])) {
                    for (const c of view.columns) {
                        const item = new vscode.CompletionItem(c.name, vscode.CompletionItemKind.Field);
                        item.detail = `${c.type} (${view.name})`;
                        items.push(item);
                    }
                }
            }
        }
        return items;
    }

    private columnsToItems(table: TableModel): vscode.CompletionItem[] {
        return table.columns.map(c => {
            const item = new vscode.CompletionItem(c.name, vscode.CompletionItemKind.Field);
            item.detail = c.type;
            return item;
        });
    }
}

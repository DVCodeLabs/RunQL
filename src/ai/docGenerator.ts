import * as vscode from 'vscode';
import * as path from 'path';
import { canonicalizeSql } from '../core/hashing';
import { fileExists } from '../core/fsWorkspace';
import { getConfiguredAIProvider, openAiProviderSettings } from './aiService';
import { createFileEditingBrokerPrompt, maybeHandleBrokerTask } from './broker';
import { buildSchemaContext } from './schemaContext';
import { loadPromptTemplate, renderPrompt } from './prompts';
import { ErrorHandler, ErrorSeverity, formatAIError } from '../core/errorHandler';
import { MarkdownViewProvider } from '../markdown/markdownView';
import { resolveConnectionInfo } from './connectionInfo';

const CONTENT_START = "<!-- RunQL:content:start -->";
const CONTENT_END = "<!-- RunQL:content:end -->";

export async function generateMarkdownDoc(context: vscode.ExtensionContext) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage("No active editor.");
        return;
    }

    const sqlDoc = editor.document;
    if (!isSqlDoc(sqlDoc)) {
        vscode.window.showWarningMessage("Open a SQL file to generate docs.");
        return;
    }

    const sqlText = sqlDoc.getText();
    if (!sqlText.trim()) {
        vscode.window.showWarningMessage("File is empty.");
        return;
    }

    const { sqlHash } = canonicalizeSql(sqlText);
    const sqlUri = sqlDoc.uri;
    const mdUri = sqlUri.with({ path: sqlUri.path.replace(/\.sql$/i, '.md') });

    const { connectionName, dialect, connectionId } = await resolveConnectionInfo(context, sqlDoc);

    await ensureMarkdownFile(mdUri, sqlUri, connectionName, connectionId, dialect, sqlHash);

    if (MarkdownViewProvider.current) {
        await MarkdownViewProvider.current.showAndFocus(sqlUri);
    }

    const schemaContext = await buildSchemaContext(sqlText, connectionId);
    const promptTemplate = await loadPromptTemplate("markdownDoc");
    const prompt = renderPrompt(promptTemplate, {
        sql: sqlText,
        dialect,
        connection: connectionName,
        schemaContext: schemaContext ? `Schema context:\n${schemaContext}` : ""
    });

    const workspaceRoot = vscode.workspace.getWorkspaceFolder(sqlUri)?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.dirname(sqlUri.fsPath);
    const brokerResult = await maybeHandleBrokerTask({
        title: "Generate SQL Markdown documentation",
        prompt: createFileEditingBrokerPrompt(prompt, {
            workspaceRoot,
            targetFiles: [mdUri.fsPath],
            primaryTarget: mdUri.fsPath,
            allowCommands: false
        }),
        workspaceRoot,
        targetFiles: [mdUri.fsPath],
        expectedWriteTargets: [mdUri.fsPath],
        contextFiles: [sqlUri.fsPath, mdUri.fsPath],
        primaryTarget: mdUri.fsPath,
        allowCommands: false
    });
    if (brokerResult?.handled) {
        return;
    }

    const provider = await getConfiguredAIProvider(context, { requireConfigured: true });
    if (!provider) {
        const picked = await vscode.window.showWarningMessage(
            "No AI provider configured. Click Copy Prompt to paste it into your AI tool of choice.",
            "Open AI Settings",
            "Copy Prompt"
        );
        if (picked === "Open AI Settings") await openAiProviderSettings();
        if (picked === "Copy Prompt") {
            const { sendDocumentToChat } = require('./sendToChat');
            await sendDocumentToChat(context);
        }
        return;
    }

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Generating documentation...",
        cancellable: true
    }, async (_progress, token) => {
        if (token.isCancellationRequested) return;
        try {
            const output = await provider.generateCompletion(prompt);
            if (token.isCancellationRequested) return;

            const sanitized = stripWrappingCodeFence(output.trim());
            const normalized = ensureMarkdownSections(sanitized);
            await streamInsert(mdUri, sqlUri, normalized);
        } catch (e: unknown) {
            await ErrorHandler.handle(e, {
                severity: ErrorSeverity.Error,
                userMessage: formatAIError(
                    'Documentation generation',
                    'AI',
                    ErrorHandler.extractErrorMessage(e),
                    'Check AI provider settings and try again'
                ),
                context: 'Generate Markdown Doc'
            });
        }
    });
}

export async function openMarkdownDoc(_context: vscode.ExtensionContext) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage("No active editor.");
        return;
    }

    const sqlDoc = editor.document;
    if (!isSqlDoc(sqlDoc)) {
        vscode.window.showWarningMessage("Open a SQL file to view docs.");
        return;
    }

    const sqlUri = sqlDoc.uri;
    const mdUri = sqlUri.with({ path: sqlUri.path.replace(/\.sql$/i, '.md') });

    if (MarkdownViewProvider.current) {
        await MarkdownViewProvider.current.showAndFocus(sqlUri);
    }
}

function isSqlDoc(doc: vscode.TextDocument): boolean {
    const id = doc.languageId.toLowerCase();
    return id.includes("sql") || id.includes("pgsql") || id.includes("mysql");
}


async function ensureMarkdownFile(
    mdUri: vscode.Uri,
    sqlUri: vscode.Uri,
    connectionName: string,
    connectionId: string | undefined,
    dialect: string,
    sqlHash: string
): Promise<void> {
    const title = path.basename(sqlUri.fsPath).replace(/\.sql$/i, '');
    const prettyTitle = title.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const today = new Date().toISOString().split('T')[0];
    const sourcePath = vscode.workspace.asRelativePath(sqlUri, false);

    const header = [
        "---",
        `title: "${prettyTitle}"`,
        `created_at: "${today}"`,
        `connection: "${connectionName}"`,
        `connection_id: "${connectionId ?? ''}"`,
        `dialect: "${dialect}"`,
        "tags: []",
        `source_path: "${sourcePath}"`,
        `source_hash: "${sqlHash}"`,
        "---",
        "",
        "<!-- DO NOT EDIT ABOVE THIS LINE - SYSTEM MANAGED -->"
    ].join("\n");

    if (!(await fileExists(mdUri))) {
        const content = [
            header,
            "",
            CONTENT_START,
            "",
            CONTENT_END,
            ""
        ].join("\n");
        await vscode.workspace.fs.writeFile(mdUri, Buffer.from(content, "utf8"));
        return;
    }

    const existing = new TextDecoder().decode(await vscode.workspace.fs.readFile(mdUri));
    if (existing.startsWith("---")) {
        const lines = existing.split(/\r?\n/);
        let endIndex = lines.findIndex((line, idx) => idx > 0 && line.trim() === "---");
        if (endIndex === -1) {
            return;
        }

        endIndex = upsertFrontmatterField(lines, endIndex, "connection", connectionName);
        endIndex = upsertFrontmatterField(lines, endIndex, "connection_id", connectionId ?? "");
        endIndex = upsertFrontmatterField(lines, endIndex, "dialect", dialect);
        endIndex = upsertFrontmatterField(lines, endIndex, "source_path", sourcePath);
        upsertFrontmatterField(lines, endIndex, "source_hash", sqlHash);

        await vscode.workspace.fs.writeFile(mdUri, Buffer.from(lines.join("\n"), "utf8"));
        return;
    }

    const content = [
        header,
        "",
        existing.trim(),
        "",
        CONTENT_START,
        "",
        CONTENT_END,
        ""
    ].join("\n");
    await vscode.workspace.fs.writeFile(mdUri, Buffer.from(content, "utf8"));
}

function upsertFrontmatterField(lines: string[], endIndex: number, key: string, value: string): number {
    for (let i = 1; i < endIndex; i += 1) {
        if (lines[i].startsWith(`${key}:`)) {
            lines[i] = `${key}: "${value}"`;
            return endIndex;
        }
    }

    lines.splice(endIndex, 0, `${key}: "${value}"`);
    return endIndex + 1;
}

function replaceContentRegion(text: string, content: string): string {
    const start = text.indexOf(CONTENT_START);
    const end = text.indexOf(CONTENT_END);
    if (start !== -1 && end !== -1 && end > start) {
        const before = text.slice(0, start + CONTENT_START.length);
        const after = text.slice(end);
        return `${before}\n${content}\n${after}`;
    }

    const lines = text.split(/\r?\n/);
    let headerEnd = -1;
    if (lines[0] === "---") {
        headerEnd = lines.findIndex((line, idx) => idx > 0 && line.trim() === "---");
    }
    if (headerEnd !== -1) {
        const header = lines.slice(0, headerEnd + 1).join("\n");
        return [
            header,
            "",
            CONTENT_START,
            content,
            CONTENT_END,
            ""
        ].join("\n");
    }

    return [
        CONTENT_START,
        content,
        CONTENT_END,
        ""
    ].join("\n");
}

async function streamInsert(mdUri: vscode.Uri, sqlUri: vscode.Uri, content: string): Promise<void> {
    const fileBytes = await vscode.workspace.fs.readFile(mdUri);
    const baseText = new TextDecoder().decode(fileBytes);
    const chunks = chunkText(content, 6);
    let acc = "";
    MarkdownViewProvider.current?.setGenerating(sqlUri, true);
    for (const chunk of chunks) {
        acc += chunk;
        const updated = replaceContentRegion(baseText, acc);
        await vscode.workspace.fs.writeFile(mdUri, Buffer.from(updated, "utf8"));
        MarkdownViewProvider.current?.updateContent(sqlUri, updated);
        await new Promise(resolve => setTimeout(resolve, 40));
    }
    MarkdownViewProvider.current?.setGenerating(sqlUri, false);
}

function chunkText(text: string, parts: number): string[] {
    if (parts <= 1 || text.length === 0) return [text];
    const size = Math.ceil(text.length / parts);
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += size) {
        chunks.push(text.slice(i, i + size));
    }
    return chunks;
}

function stripWrappingCodeFence(text: string): string {
    if (text.startsWith("```") && text.endsWith("```")) {
        const lines = text.split(/\r?\n/);
        if (lines.length >= 3) {
            return lines.slice(1, -1).join("\n").trim();
        }
    }
    return text;
}

function ensureMarkdownSections(text: string): string {
    const required = [
        "# What this query answers",
        "# Inputs",
        "# Business logic",
        "# Output",
        "# Caveats",
        "# Performance notes"
    ];
    const hasAll = required.every(h => text.includes(h));
    if (hasAll) return text;
    return [
        ...required,
        "",
        text
    ].join("\n");
}

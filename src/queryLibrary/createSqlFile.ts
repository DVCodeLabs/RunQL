import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { loadConnectionProfiles } from '../connections/connectionStore';
import { canonicalizeSql } from '../core/hashing';
import { ErrorHandler, ErrorSeverity, formatFileSystemError } from '../core/errorHandler';
import { resolveEffectiveSqlDialect } from '../core/sqlUtils';
import type { QuerySchemaContext } from '../core/types';
import { queryIndex } from './queryIndex';
import { UNASSIGNED_QUERY_FOLDER, sanitizeQueryConnectionFolderName } from './queryStorage';
import { ensureDPDirs } from '../core/fsWorkspace';
import { makeStoredPath } from '../core/storageRoot';

type QueryFileConnectionContext = {
    connName: string;
    connId: string;
    dialect: string;
};

type QueryFileTarget = {
    /** Absolute path to the connection-scoped queries folder. */
    folderPath: string;
    /** Absolute path to the RunQL storage root (used to derive relative source_path). */
    storageRootPath: string;
    /** RunQL storage root as a URI (file scheme only in v1). */
    storageRootUri: vscode.Uri;
    connection: QueryFileConnectionContext;
};

function yamlString(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function resolveQueryFileTarget(
    context: vscode.ExtensionContext,
    connectionId?: string
): Promise<QueryFileTarget | undefined> {
    let storageRootUri: vscode.Uri;
    try {
        storageRootUri = await ensureDPDirs();
    } catch (e) {
        await ErrorHandler.handle(
            new Error(formatFileSystemError(
                'Save query',
                e instanceof Error ? e.message : String(e),
                'Configure RunQL storage from the Welcome page or switch to User-level storage.'
            )),
            { severity: ErrorSeverity.Warning, context: 'Save SQL File' }
        );
        return undefined;
    }

    if (storageRootUri.scheme !== 'file') {
        await ErrorHandler.handle(
            new Error(formatFileSystemError(
                'Save query',
                `Unsupported RunQL storage scheme: ${storageRootUri.scheme}`,
                'RunQL requires a local file-system storage root in this version.'
            )),
            { severity: ErrorSeverity.Warning, context: 'Save SQL File' }
        );
        return undefined;
    }

    const activeConnId = connectionId ?? context.workspaceState.get<string>("runql.activeConnectionId");
    const connection: QueryFileConnectionContext = {
        connName: "none",
        connId: "",
        dialect: "unknown",
    };

    if (activeConnId) {
        const profiles = await loadConnectionProfiles();
        const profile = profiles.find(p => p.id === activeConnId);
        if (profile) {
            connection.connName = profile.name;
            connection.connId = profile.id;
            connection.dialect = resolveEffectiveSqlDialect(profile);
        }
    }

    const connectionFolder = connection.connName === 'none'
        ? UNASSIGNED_QUERY_FOLDER
        : sanitizeQueryConnectionFolderName(connection.connName, connection.connId);

    return {
        folderPath: path.join(storageRootUri.fsPath, 'queries', connectionFolder),
        storageRootPath: storageRootUri.fsPath,
        storageRootUri,
        connection,
    };
}

function normalizeQueryName(input: string): { subFolder: string; fileName: string } {
    const normalizedInput = input.replace(/\\/g, '/');
    const segments = normalizedInput
        .split('/')
        .map(s => s.replace(/[^a-zA-Z0-9_\-]/g, '_').toLowerCase())
        .filter(Boolean);

    let fileName = segments.pop() || 'untitled';
    if (!fileName) fileName = 'untitled';

    return {
        subFolder: segments.join(path.sep),
        fileName,
    };
}

function incrementedBaseName(targetDir: string, fileName: string): string {
    let iter = 0;
    let baseName = fileName;
    while (fs.existsSync(path.join(targetDir, `${baseName}.sql`)) || fs.existsSync(path.join(targetDir, `${baseName}.md`))) {
        iter++;
        baseName = `${fileName}_${iter}`;
    }
    return baseName;
}

async function resolveBaseNameForSave(targetDir: string, fileName: string): Promise<string | undefined> {
    const sqlPath = path.join(targetDir, `${fileName}.sql`);
    const mdPath = path.join(targetDir, `${fileName}.md`);
    if (!fs.existsSync(sqlPath) && !fs.existsSync(mdPath)) {
        return fileName;
    }

    const choice = await vscode.window.showWarningMessage(
        `A saved query named "${fileName}" already exists.`,
        { modal: true },
        "Overwrite",
        "Save Copy"
    );

    if (choice === "Overwrite") {
        return fileName;
    }
    if (choice === "Save Copy") {
        return incrementedBaseName(targetDir, fileName);
    }
    return undefined;
}

function buildMarkdownContent(args: {
    baseName: string;
    connection: QueryFileConnectionContext;
    schemaContext?: QuerySchemaContext;
    sourcePath: string;
    sqlHash: string;
}): string {
    const today = new Date().toISOString().split('T')[0];
    const niceTitle = args.baseName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const schemaLines = args.schemaContext?.defaultSchema
        ? `${args.schemaContext.defaultCatalog ? `catalog_context: ${yamlString(args.schemaContext.defaultCatalog)}\n` : ''}schema_context: ${yamlString(args.schemaContext.defaultSchema)}\n`
        : '';

    return `---
title: ${yamlString(niceTitle)}
created_at: "${today}"
connection: ${yamlString(args.connection.connName)}
connection_id: ${yamlString(args.connection.connId)}
dialect: ${yamlString(args.connection.dialect)}
${schemaLines}tags: []
source_path: ${yamlString(args.sourcePath)}
source_hash: ${yamlString(args.sqlHash)}
---

<!-- RunQL:content:start -->
# Goal
-

# Context / Notes
-

# Inputs
- Tables:
- Key columns:

# Output
- What does this return?

# Caveats
-
<!-- RunQL:content:end -->
`;
}

async function writeQueryBundle(args: {
    target: QueryFileTarget;
    targetDir: string;
    baseName: string;
    sqlContent: string;
    schemaContext?: QuerySchemaContext;
    openAfterWrite?: boolean;
}): Promise<vscode.Uri> {
    const sqlPath = path.join(args.targetDir, `${args.baseName}.sql`);
    const mdPath = path.join(args.targetDir, `${args.baseName}.md`);
    const { sqlHash } = canonicalizeSql(args.sqlContent);
    const sqlUri = vscode.Uri.file(sqlPath);
    // source_path stored root-relative so it survives storage-mode changes.
    const sourcePath = makeStoredPath(sqlUri).replace(/\\/g, '/');
    const mdContent = buildMarkdownContent({
        baseName: args.baseName,
        connection: args.target.connection,
        schemaContext: args.schemaContext,
        sourcePath,
        sqlHash,
    });

    // Ordering + rollback rules:
    //   Create path (neither file pre-exists): write .md first, then .sql;
    //     if .sql fails, unlink the .md we just created so we don't leave
    //     a doc-less orphan the Saved Queries view would index.
    //   Overwrite path (.md and/or .sql pre-exist): the user asked to
    //     replace both, but a partial-write recovery must not destroy
    //     what was there. Snapshot the pre-existing .md content so a
    //     .sql-write failure restores the .md rather than unlinking
    //     the freshly-overwritten (new) content.
    const mdExistedBefore = fs.existsSync(mdPath);
    const priorMdBytes = mdExistedBefore ? fs.readFileSync(mdPath) : undefined;
    fs.writeFileSync(mdPath, mdContent);
    try {
        fs.writeFileSync(sqlPath, args.sqlContent);
    } catch (e) {
        if (mdExistedBefore && priorMdBytes) {
            // Overwrite path: restore the user's prior .md content.
            try { fs.writeFileSync(mdPath, priorMdBytes); } catch { /* ignore */ }
        } else {
            // Create path: no prior .md, so best-effort unlink the
            // freshly-created one to avoid a doc-less orphan.
            try { fs.unlinkSync(mdPath); } catch { /* ignore */ }
        }
        throw e;
    }

    await queryIndex.updateFile(sqlUri);
    if (args.openAfterWrite !== false) {
        const doc = await vscode.workspace.openTextDocument(sqlUri);
        await vscode.window.showTextDocument(doc);
    }
    return sqlUri;
}

export async function createSqlFile(context: vscode.ExtensionContext) {
    const target = await resolveQueryFileTarget(context);
    if (!target) return;

    if (!fs.existsSync(target.folderPath)) {
        fs.mkdirSync(target.folderPath, { recursive: true });
    }

    const input = await vscode.window.showInputBox({
        prompt: "Query Name (or path/query_name)",
        placeHolder: "monthly_active_users or reports/q1/revenue"
    });
    if (!input) return;

    const { subFolder, fileName } = normalizeQueryName(input);
    const targetDir = path.join(target.folderPath, subFolder);

    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    const baseName = incrementedBaseName(targetDir, fileName);
    const sqlContent = `SELECT
  1 AS example;
`;

    await writeQueryBundle({ target, targetDir, baseName, sqlContent });
}

export async function saveSqlFile(
    context: vscode.ExtensionContext,
    document: vscode.TextDocument,
    connectionId?: string,
    schemaContext?: QuerySchemaContext
): Promise<vscode.Uri | undefined> {
    const target = await resolveQueryFileTarget(context, connectionId);
    if (!target) return undefined;

    if (!fs.existsSync(target.folderPath)) {
        fs.mkdirSync(target.folderPath, { recursive: true });
    }

    const defaultName = document.uri.scheme === 'file'
        ? path.basename(document.uri.fsPath).replace(/\.(sql|postgres)$/i, '')
        : undefined;

    const input = await vscode.window.showInputBox({
        prompt: "Query Name (or path/query_name)",
        placeHolder: "monthly_active_users or reports/q1/revenue",
        value: defaultName,
        validateInput: (value) => value.trim() ? undefined : "Enter a query name."
    });
    if (!input) return undefined;

    const { subFolder, fileName } = normalizeQueryName(input);
    const targetDir = path.join(target.folderPath, subFolder);
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    const baseName = await resolveBaseNameForSave(targetDir, fileName);
    if (!baseName) return undefined;

    return writeQueryBundle({
        target,
        targetDir,
        baseName,
        sqlContent: document.getText(),
        schemaContext,
        openAfterWrite: false,
    });
}

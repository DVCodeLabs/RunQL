import * as vscode from 'vscode';
import * as path from 'path';
import { SavedQueryItem } from './savedQueriesView';
import { ErrorHandler, ErrorSeverity, formatQueryError } from '../core/errorHandler';
import { Logger } from '../core/logger';
import { resolveStoredPathToExistingFile } from '../core/storageRoot';
import { queryIndex } from './queryIndex';
import { siblingUri, stripQuerySourceSuffix, withPath } from './bundleUtils';

function isFileNotFound(error: unknown): boolean {
    const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';
    const message = error instanceof Error ? error.message : String(error);
    return code === 'FileNotFound' || /\bENOENT\b|no such file or directory/i.test(message);
}

async function deleteIfPresent(uri: vscode.Uri, useTrash = true): Promise<boolean> {
    try {
        await vscode.workspace.fs.delete(uri, { recursive: false, useTrash });
        return true;
    } catch (error) {
        if (isFileNotFound(error)) return false;
        throw error;
    }
}

export async function deleteSavedQuery(item: SavedQueryItem | vscode.Uri) {
    if (!item) return;

    let fileUri: vscode.Uri | undefined;
    let displayLabel: string;

    // Handle both SavedQueryItem (from sidebar) and Uri (from codelens)
    if (item instanceof vscode.Uri) {
        fileUri = item;
        displayLabel = path.basename(stripQuerySourceSuffix(item.fsPath));
    } else if (item.entry) {
        // In multi-root workspaces the syntactic resolver picks
        // folder[0] blindly. Probe every folder for the actual file so
        // we don't delete the wrong workspace-folder's copy.
        fileUri = await resolveStoredPathToExistingFile(item.entry.path);
        displayLabel = (item.label as string) || path.basename(stripQuerySourceSuffix(item.entry.path));
    } else {
        return;
    }

    if (!fileUri) return;

    const companionUris = [
        siblingUri(fileUri, ".md"),
        siblingUri(fileUri, ".comments.json"),
        siblingUri(fileUri, ".chart.json"),
        siblingUri(fileUri, ".chartconfig.json"),
        withPath(fileUri, stripQuerySourceSuffix(fileUri.path) + ".annotated.sql")
    ];

    const choice = await vscode.window.showWarningMessage(
        `Are you sure you want to move '${displayLabel}' and its source and companion files to the Trash?`,
        { modal: true },
        'Delete'
    );

    if (choice !== 'Delete') return;

    try {
        await deleteIfPresent(fileUri);

        const failedCompanions: string[] = [];
        for (const companion of companionUris) {
            try {
                await deleteIfPresent(companion);
            } catch (error) {
                failedCompanions.push(path.basename(companion.fsPath));
                Logger.warn(`Failed to delete query companion ${companion.fsPath}`, error);
            }
        }

        await queryIndex.removeFile(fileUri);
        await vscode.commands.executeCommand('runql.view.refreshSavedQueries');

        if (failedCompanions.length > 0) {
            vscode.window.showWarningMessage(`Deleted query '${displayLabel}', but could not delete companion files: ${failedCompanions.join(', ')}`);
            return;
        }

        vscode.window.showInformationMessage(`Deleted query '${displayLabel}'`);

    } catch (e: unknown) {
        if (!isFileNotFound(e)) {
            await ErrorHandler.handle(e, {
                severity: ErrorSeverity.Error,
                userMessage: formatQueryError(
                    'Delete query',
                    ErrorHandler.extractErrorMessage(e),
                    'Check file permissions and try again'
                ),
                context: 'Delete Saved Query'
            });
        } else {
            await queryIndex.removeFile(fileUri);
            await vscode.commands.executeCommand('runql.view.refreshSavedQueries');
        }
    }
}

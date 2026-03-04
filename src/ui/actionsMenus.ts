import * as vscode from "vscode";
import { ConnectionItem } from "../connections/connectionsView";
import { Logger } from '../core/logger';

/**
 * Spec:
 * - runql.actionsMenu: Editor toolbar dropdown for SQL editor actions
 * - runql.connectionsActionsMenu: View toolbar dropdown for connection/schema actions
 */

// Global-ish selection cache for view menu context
let _connectionsTreeView: vscode.TreeView<ConnectionItem> | undefined;
let _extensionContext: vscode.ExtensionContext;

// Utility: run a command safely
async function runCommand(cmd: string, ...args: unknown[]) {
    try {
        await vscode.commands.executeCommand(cmd, ...args);
    } catch (err) {
        vscode.window.showErrorMessage(`RunQL: Failed to run "${cmd}". See console for details.`);
        Logger.error(`RunQL command failed: ${cmd}`, err);
    }
}

function isSqlActiveEditor(): boolean {
    const editor = vscode.window.activeTextEditor;
    return !!editor && (editor.document.languageId === "sql" || editor.document.languageId === "pgsql" || editor.document.languageId === "mysql");
}

// ----- Editor Actions Menu -----
async function showEditorActionsMenu() {
    if (!isSqlActiveEditor()) {
        vscode.window.showInformationMessage("RunQL: Open a SQL file to use these actions.");
        return;
    }

    const items: Array<vscode.QuickPickItem & { cmd: string }> = [
        { label: "Run Query", cmd: "runql.query.run" },
        { label: "Add Inline Comments", cmd: "runql.query.addInlineComments" },
        { label: "Add Markdown Documentation", cmd: "runql.query.generateMarkdownDoc" }
    ];

    const picked = await vscode.window.showQuickPick(items, {
        title: "RunQL Actions",
        placeHolder: "Choose an action"
    });

    if (!picked) return;
    await runCommand(picked.cmd);
}



/**
 * Hook selection tracking for the Connections tree view.
 * Now simply stores the reference for on-demand querying.
 */
export function attachConnectionsSelectionTracking(
    view: vscode.TreeView<ConnectionItem>
) {
    _connectionsTreeView = view;
}

// ----- Registration entrypoint -----
export function registerActionsMenus(context: vscode.ExtensionContext) {
    _extensionContext = context;
    context.subscriptions.push(
        vscode.commands.registerCommand("runql.actionsMenu", showEditorActionsMenu)
    );
}

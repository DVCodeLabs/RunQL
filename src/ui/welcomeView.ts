import * as vscode from 'vscode';
import { isProjectInitialized, updateProjectInitializedContext } from '../core/isProjectInitialized';
import { fileExists } from '../core/fsWorkspace';
import { ChangelogEntry, parseChangelogEntry } from './changelog';
import {
    tryResolveRunQLRoot,
    onDidChangeStorageRoot,
    StorageLocation,
    isCodespaces,
    validateCustomPath,
    checkCustomPathWritable,
    computeProspectiveRoot,
} from '../core/storageRoot';
import {
    askStorageChangeAction,
    executeStorageChangeAction,
    postMigrationHousekeeping,
    suppressAutoMigration,
    markProgrammaticStorageChange,
} from '../core/storageMigration';
import { promptWorkspaceLinkInit, promptWorkspaceOwnerFolder } from '../core/workspaceLinkInit';

type WelcomeMode = 'welcome' | 'whatsNew';

interface WelcomeRenderOptions {
    mode?: WelcomeMode;
    version?: string;
}

export class WelcomeView {
    public static currentPanel: WelcomeView | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _mode: WelcomeMode;
    private _version?: string;
    private _changelogEntry?: ChangelogEntry;
    private _disposables: vscode.Disposable[] = [];

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, options: WelcomeRenderOptions = {}) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._mode = options.mode ?? 'welcome';
        this._version = options.version;

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            void this._sendStatus();
        }, null, this._disposables);
        this._disposables.push(onDidChangeStorageRoot(() => {
            void this._sendStatus();
        }));
        this._panel.webview.html = this._getWebviewContent(this._panel.webview, extensionUri);
        this._setWebviewMessageListener(this._panel.webview);
    }

    public static render(extensionUri: vscode.Uri, options: WelcomeRenderOptions = {}) {
        const mode = options.mode ?? 'welcome';
        const title = mode === 'whatsNew' ? "What's New in RunQL" : 'Welcome to RunQL';

        if (WelcomeView.currentPanel) {
            WelcomeView.currentPanel._mode = mode;
            WelcomeView.currentPanel._version = options.version;
            WelcomeView.currentPanel._panel.title = title;
            WelcomeView.currentPanel._panel.reveal(vscode.ViewColumn.One);
            // Refresh status
            WelcomeView.currentPanel._sendStatus();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'dpWelcome',
            title,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')]
            }
        );

        WelcomeView.currentPanel = new WelcomeView(panel, extensionUri, options);
    }

    private async _sendStatus() {
        const initialized = await isProjectInitialized();
        const hasWorkspace = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
        const cfg = vscode.workspace.getConfiguration('runql.storage');
        const storageLocation = cfg.get<StorageLocation>('location', 'workspace');
        const customPath = cfg.get<string>('customPath', '');
        const userPath = cfg.get<string>('userPath', '~/.runql');
        const codespacesPath = cfg.get<string>('codespacesPath', '/workspaces/.runql');
        const resolved = tryResolveRunQLRoot();
        this._panel.webview.postMessage({
            command: 'setStatus',
            initialized,
            hasWorkspace,
            mode: this._mode,
            version: this._version,
            whatsNewEntry: this._mode === 'whatsNew' ? await this._getWhatsNewEntry() : undefined,
            storage: {
                location: storageLocation,
                customPath,
                userPath,
                codespacesPath,
                resolvedPath: resolved?.displayPath ?? null,
                resolvedLocation: resolved?.location ?? null,
                codespaces: isCodespaces(),
                workspaceFolderCount: vscode.workspace.workspaceFolders?.length ?? 0,
            },
        });
    }

    private async _getWhatsNewEntry(): Promise<ChangelogEntry | undefined> {
        if (this._changelogEntry?.version === this._version) {
            return this._changelogEntry;
        }

        try {
            const changelogUri = vscode.Uri.joinPath(this._extensionUri, 'CHANGELOG.md');
            const changelogBytes = await vscode.workspace.fs.readFile(changelogUri);
            const changelog = new TextDecoder('utf-8').decode(changelogBytes);
            this._changelogEntry = parseChangelogEntry(changelog, this._version);
            return this._changelogEntry;
        } catch (_e: unknown) {
            return undefined;
        }
    }

    public dispose() {
        WelcomeView.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) x.dispose();
        }
    }

    /**
     * Ask-then-commit storage-location change from the Welcome webview.
     * Runs the migration prompt (Move/Copy/Use existing/… OR Use existing/
     * Replace after backup/…) BEFORE applying any setting. Cancel is a
     * true no-op — no setting change, no revert dance, and the webview's
     * radio reverts naturally because the server-side storage.location
     * never changed.
     */
    private async _handleChangeStorageLocation(
        target: StorageLocation,
        rawCustomPath?: string
    ): Promise<void> {
        const releaseSuppression = suppressAutoMigration();
        try {
            const cfg = vscode.workspace.getConfiguration('runql.storage');
            const previousSettings = {
                location: cfg.get<StorageLocation>('location', 'workspace'),
                userPath: cfg.get<string>('userPath', '~/.runql'),
                codespacesPath: cfg.get<string>('codespacesPath', '/workspaces/.runql'),
                customPath: cfg.get<string>('customPath', ''),
            };
            const previousRoot = tryResolveRunQLRoot();
            const settingUnchanged = target === previousSettings.location;

            // For custom mode we need a valid path up front — the webview
            // should have supplied it. Bail with a message if it hasn't.
            let prospectiveCustomPath: string | undefined;
            if (target === 'custom') {
                const trimmed = (rawCustomPath ?? '').trim();
                if (!trimmed) {
                    vscode.window.showWarningMessage(
                        'Enter a custom storage path in the field above and click Save.'
                    );
                    return;
                }
                const validated = validateCustomPath(trimmed);
                if (validated.error || !validated.fsPath) {
                    vscode.window.showErrorMessage(
                        validated.error?.message ?? 'Custom RunQL storage path is invalid.'
                    );
                    return;
                }
                const writeErr = await checkCustomPathWritable(validated.fsPath);
                if (writeErr) {
                    vscode.window.showErrorMessage(writeErr.message);
                    return;
                }
                prospectiveCustomPath = validated.fsPath;
            }

            const prospectiveNextRoot = computeProspectiveRoot(target, {
                customPath: prospectiveCustomPath ?? previousSettings.customPath,
                userPath: previousSettings.userPath,
                codespacesPath: previousSettings.codespacesPath,
            });
            if (!prospectiveNextRoot) {
                vscode.window.showWarningMessage(
                    target === 'workspace'
                        ? 'Open a folder before switching to workspace storage.'
                        : 'Cannot resolve the new storage root. Check the storage path settings.'
                );
                return;
            }

            let choice: 'move' | 'copy' | 'use-existing' | 'start-empty' | 'replace-after-backup' | 'cancelled' | 'no-source-data' | 'noop-same-root' = 'no-source-data';
            if (previousRoot) {
                choice = await askStorageChangeAction({
                    previousRoot,
                    nextRoot: prospectiveNextRoot,
                });
            }
            if (choice === 'cancelled') return;
            if (choice === 'noop-same-root' && settingUnchanged) return;

            // Migrate BEFORE the setting change — see extension.ts for
            // full rationale. Ensures event subscribers see files at the
            // new root when `onDidChangeStorageRoot` fires.
            if (previousRoot && choice !== 'no-source-data' && choice !== 'noop-same-root') {
                try {
                    await executeStorageChangeAction(
                        { previousRoot, nextRoot: prospectiveNextRoot },
                        choice
                    );
                } catch (e) {
                    // Surface the failure and abort — leaving the setting
                    // pointed at the old root and existing data intact.
                    // Silently swallowing here would commit the setting
                    // change and orphan the user's data at the old root.
                    const msg = e instanceof Error ? e.message : String(e);
                    await vscode.window.showErrorMessage(
                        `RunQL storage change failed while ${choice === 'move' ? 'moving' : choice === 'copy' ? 'copying' : 'preparing'} files: ${msg}. Your existing data is untouched and the storage-location setting has not been changed.`
                    );
                    return;
                }
            }

            markProgrammaticStorageChange({
                displayPath: prospectiveNextRoot.displayPath,
                location: prospectiveNextRoot.location,
            });

            if (target === 'custom' && prospectiveCustomPath !== undefined) {
                await cfg.update('customPath', prospectiveCustomPath, vscode.ConfigurationTarget.Global);
            }
            if (!settingUnchanged) {
                await cfg.update('location', target, vscode.ConfigurationTarget.Global);
            }

            const next = tryResolveRunQLRoot();
            if (!next) return;

            await postMigrationHousekeeping();

            // Peer-window coordination: write a short-TTL commit
            // marker at the new root so any other VS Code windows on
            // this machine that receive the settings.json change via
            // Settings Sync short-circuit their own auto-migration
            // instead of re-running against a source root we just
            // migrated. See extension.ts settings-edit subscriber.
            if (previousRoot) {
                const { writeStorageChangeCommitMarker } = await import(
                    '../core/storageMigration'
                );
                await writeStorageChangeCommitMarker(next, previousRoot.displayPath);
            }
        } finally {
            const { clearExpectedNextRoot } = await import('../core/storageMigration');
            clearExpectedNextRoot();
            setTimeout(releaseSuppression, 750);
        }
    }

    private _setWebviewMessageListener(webview: vscode.Webview) {
        webview.onDidReceiveMessage(
            async (message: Record<string, unknown>) => {
                switch (message.command) {
                    case 'ready':
                        await this._sendStatus();
                        break;

                    case 'initialize':
                        try {
                            const location = vscode.workspace
                                .getConfiguration('runql.storage')
                                .get<StorageLocation>('location', 'workspace');
                            if (location === 'workspace') {
                                await promptWorkspaceOwnerFolder();
                                if ((vscode.workspace.workspaceFolders?.length ?? 0) === 0) {
                                    vscode.window.showWarningMessage(
                                        'Workspace storage requires an open folder. Open a folder or switch RunQL storage to User-level.'
                                    );
                                    return;
                                }
                            }

                            const root = tryResolveRunQLRoot();
                            if (!root) {
                                vscode.window.showWarningMessage(
                                    'RunQL storage cannot be resolved. Configure a storage location and try again.'
                                );
                                return;
                            }

                            // Full initialization - must match runql.project.initialize command flow
                            const { ensureDPDirs, ensureAgentsMd, ensureReadmeMd } = require('../core/fsWorkspace');
                            const { initializePromptFiles } = require('../ai/prompts');
                            const { queryIndex } = require('../queryLibrary/queryIndex');
                            const { HistoryService } = require('../services/historyService');

                            await ensureDPDirs();
                            await queryIndex.initialize();
                            await initializePromptFiles();

                            if (root.location === 'workspace') {
                                await ensureAgentsMd();
                                await ensureReadmeMd();
                            } else {
                                await promptWorkspaceLinkInit(root);
                            }

                            await HistoryService.getInstance().initialize();

                            await updateProjectInitializedContext();
                            await vscode.commands.executeCommand('runql.view.refreshConnections');
                            vscode.window.showInformationMessage('RunQL project initialized successfully!');
                            await this._sendStatus();
                        } catch (e: unknown) {
                            vscode.window.showErrorMessage(`Initialization failed: ${e instanceof Error ? e.message : String(e)}`);
                        }
                        break;

                    case 'changeStorageLocation': {
                        // Ask-then-commit: run the migration dialog BEFORE any
                        // setting change, so Cancel is a true no-op and the
                        // radio in the webview reverts naturally (server-side
                        // storage.location never changed → next _sendStatus
                        // reflects the original).
                        const rawTarget = typeof message.location === 'string' ? message.location : 'workspace';
                        const target: StorageLocation =
                            rawTarget === 'user' || rawTarget === 'custom' ? rawTarget : 'workspace';
                        const rawCustomPath = typeof message.customPath === 'string' ? message.customPath : undefined;
                        await this._handleChangeStorageLocation(target, rawCustomPath);
                        // Whatever happened, refresh the status so the radios
                        // reflect the authoritative server-side setting.
                        await this._sendStatus();
                        break;
                    }

                    case 'browseCustomPath': {
                        const picked = await vscode.window.showOpenDialog({
                            canSelectFiles: false,
                            canSelectFolders: true,
                            canSelectMany: false,
                            openLabel: 'Use as RunQL custom storage folder',
                            title: 'RunQL: Custom Storage Path',
                        });
                        if (picked && picked.length > 0) {
                            this._panel.webview.postMessage({
                                command: 'customPathPicked',
                                fsPath: picked[0].fsPath,
                            });
                        }
                        break;
                    }

                    case 'openStorageFolder':
                        await vscode.commands.executeCommand('runql.storage.openFolder');
                        break;

                    case 'showWarning': {
                        const msg = typeof message.message === 'string' ? message.message : '';
                        if (msg) vscode.window.showWarningMessage(msg);
                        break;
                    }

                    case 'addConnection':
                        vscode.commands.executeCommand('runql.connection.add');
                        break;

                    case 'openSettings':
                        vscode.commands.executeCommand('runql.openSettings');
                        break;

                    case 'openAiSettings':
                        // Open the VS Code Settings editor filtered to RunQL AI settings.
                        await vscode.commands.executeCommand(
                            'workbench.action.openSettings',
                            'runql.ai'
                        );
                        break;

                    case 'openExtensionSearch': {
                        const extensionQuery = typeof message.extensionQuery === 'string' ? message.extensionQuery : '';
                        if (!extensionQuery) {
                            return;
                        }
                        await vscode.commands.executeCommand('workbench.view.extensions');
                        try {
                            await vscode.commands.executeCommand('workbench.extensions.search', extensionQuery);
                        } catch (_e: unknown) {
                            await vscode.commands.executeCommand('workbench.extensions.action.showExtensionsForQuery', extensionQuery);
                        }
                        break;
                    }

                    case 'openFolder':
                        vscode.commands.executeCommand('vscode.openFolder');
                        break;

                    case 'openReadme':
                        try {
                            const folders = vscode.workspace.workspaceFolders;
                            if (!folders || folders.length === 0) {
                                vscode.window.showWarningMessage('No workspace folder open.');
                                return;
                            }
                            // Prefer a workspace folder that already has README_RUNQL.md; fall back to the first.
                            let target: vscode.Uri | undefined;
                            for (const f of folders) {
                                const candidate = vscode.Uri.joinPath(f.uri, 'README_RUNQL.md');
                                if (await fileExists(candidate)) {
                                    target = candidate;
                                    break;
                                }
                            }
                            if (!target) {
                                vscode.window.showWarningMessage('README_RUNQL.md not found. Initialize RunQL to create it.');
                                return;
                            }

                            const doc = await vscode.workspace.openTextDocument(target);
                            await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
                        } catch (_e: unknown) {
                            vscode.window.showWarningMessage('Could not open README_RUNQL.md.');
                        }
                        break;
                }
            },
            undefined,
            this._disposables
        );
    }

    private _getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'welcomeApp.js'));

        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to RunQL</title>
</head>
<body>
  <div id="root"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
    }
}

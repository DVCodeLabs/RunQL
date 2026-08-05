import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

// Type extension for VS Code webview API
declare const acquireVsCodeApi: () => {
    postMessage: (message: any) => void;
    getState: () => any;
    setState: (state: any) => void;
};

const vscode = acquireVsCodeApi();

type InitStructureEntry = {
    folder: string;
    files: string[];
    /** Optional per-entry annotation shown next to the folder name. */
    note?: string;
};

type StructureIconKind = 'folder' | 'file';
type WelcomeMode = 'welcome' | 'whatsNew';

type ChangelogSection = {
    title: string;
    paragraphs: string[];
    items: string[];
};

type ChangelogEntry = {
    version: string;
    date?: string;
    sections: ChangelogSection[];
};

type AISettingDoc = {
    name: string;
    summary: string;
    details: string;
};

type ConnectorDoc = {
    name: string;
    extensionId: string;
    summary: string;
};

// Folder + default file structure that Initialize creates.
// One generic layout that applies across all storage modes; only the
// meaning of "<storage-root>" and the presence of `.runql-link/` differ,
// and both are called out in prose alongside the trees.

const STORAGE_TREE_ENTRIES: InitStructureEntry[] = [
    { folder: '<storage-root>/', files: [] },
    {
        folder: '<storage-root>/queries/',
        files: ['<connection>/<query>.sql', '<connection>/<query>.md'],
    },
    {
        folder: '<storage-root>/schemas/',
        files: [
            '<connection>/manifest.json',
            '<connection>/<schema>/schema.json',
            '<connection>/<schema>/description.json',
            '<connection>/<schema>/custom.relationships.json',
            '<connection>/<schema>/erd.json',
            '<connection>/<schema>/erd.layout.json',
        ],
    },
    { folder: '<storage-root>/system/', files: [] },
    {
        folder: '<storage-root>/system/queries/',
        files: ['queryIndex.json', 'queryHistory.json (after first query run)'],
    },
    {
        folder: '<storage-root>/system/prompts/',
        files: ['markdownDoc.txt', 'inlineComments.txt', 'describeSchema.txt'],
    },
];

const PROJECT_ROOT_ENTRIES: InitStructureEntry[] = [
    {
        folder: '(project root)',
        files: ['AGENTS.md', 'README_RUNQL.md'],
    },
    {
        folder: '.runql-link/',
        files: [
            'storage-root.json (authoritative link marker)',
            'ref.json (agent-readable mirror)',
        ],
        note: 'Only created for User-level and Custom location storage modes',
    },
];

const AI_SETTINGS: AISettingDoc[] = [
    {
        name: 'AI Source',
        summary: 'Choose how RunQL should access AI.',
        details: 'Use GitHub Copilot / VS Code AI for the built-in VS Code path, AI Extension for Claude Code or Codex handoff, Direct API for your own provider, or Off to disable AI.'
    },
    {
        name: 'AI Extension',
        summary: 'Pick the extension RunQL should use when AI Source is AI Extension.',
        details: 'Choose Claude Code or Codex. Leave it on Automatic if you want RunQL to choose from supported installed extensions.'
    },
    {
        name: 'API Provider',
        summary: 'Choose the provider for Direct API.',
        details: 'Use OpenAI, Anthropic, Azure OpenAI, Ollama, or OpenAI-Compatible depending on where your model lives.'
    },
    {
        name: 'AI Model',
        summary: 'Choose a model when your AI source supports it.',
        details: 'This is used by GitHub Copilot / VS Code AI and Direct API. It is ignored for AI Extension.'
    },
    {
        name: 'API Base URL',
        summary: 'Enter a custom base URL only when your provider needs one.',
        details: 'This is usually required for Azure OpenAI and OpenAI-compatible servers, and optional for Ollama if you are not using the default local URL.'
    }
];

const OFFICIAL_CONNECTORS: ConnectorDoc[] = [
    {
        name: 'RunQL DuckDB Connector',
        extensionId: 'runql.runql-duckdb',
        summary: 'Query local DuckDB files, in-memory DuckDB databases, and MotherDuck connections.'
    },
    {
        name: 'RunQL Snowflake Connector',
        extensionId: 'runql.runql-snowflake',
        summary: 'Connect to Snowflake warehouses for SQL workflows, schema introspection, and ERDs.'
    },
    {
        name: 'RunQL BigQuery Connector',
        extensionId: 'runql.runql-bigquery',
        summary: 'Connect to BigQuery projects from RunQL.'
    },
    {
        name: 'RunQL Databricks Connector',
        extensionId: 'runql.runql-databricks',
        summary: 'Connect to Databricks SQL warehouses and lakehouse data.'
    },
    {
        name: 'RunQL Microsoft SQL Server Connector',
        extensionId: 'runql.runql-mssql',
        summary: 'Connect to Microsoft SQL Server and Azure SQL databases.'
    }
];

const VSCODE_MARKETPLACE_CONFIG = `{
  "extensionsGallery": {
    "serviceUrl": "https://marketplace.visualstudio.com/_apis/public/gallery",
    "itemUrl": "https://marketplace.visualstudio.com/items",
    "cacheUrl": "https://vscode.blob.core.windows.net/gallery/index",
    "controlUrl": ""
  }
}`;

// Styles
const styles: Record<string, React.CSSProperties> = {
    container: {
        fontFamily: 'var(--vscode-font-family)',
        color: 'var(--vscode-foreground)',
        backgroundColor: 'var(--vscode-editor-background)',
        padding: '24px',
        maxWidth: '800px',
        margin: '0 auto'
    },
    header: {
        marginBottom: '24px',
        borderBottom: '1px solid var(--vscode-panel-border)',
        paddingBottom: '16px'
    },
    title: {
        fontSize: '24px',
        fontWeight: 600,
        margin: 0,
        marginBottom: '8px',
        display: 'flex',
        alignItems: 'center',
        gap: '10px'
    },
    trustStatement: {
        fontSize: '13px',
        color: 'var(--vscode-descriptionForeground)',
        margin: 0,
        padding: '8px 12px',
        backgroundColor: 'var(--vscode-textBlockQuote-background)',
        borderLeft: '3px solid var(--vscode-textLink-activeForeground)',
        borderRadius: '2px'
    },
    card: {
        backgroundColor: 'var(--vscode-sideBar-background)',
        border: '1px solid var(--vscode-panel-border)',
        borderRadius: '6px',
        padding: '16px',
        marginBottom: '16px'
    },
    cardTitle: {
        fontSize: '14px',
        fontWeight: 600,
        marginBottom: '12px',
        marginTop: 0,
        marginLeft: 0,
        marginRight: 0
    },
    collapsibleHeader: {
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        padding: 0,
        border: 'none',
        background: 'transparent',
        color: 'var(--vscode-foreground)',
        cursor: 'pointer',
        textAlign: 'left'
    },
    collapsibleTitle: {
        fontSize: '14px',
        fontWeight: 600,
        margin: 0
    },
    collapsibleArrow: {
        flex: '0 0 auto',
        color: 'var(--vscode-descriptionForeground)',
        fontSize: '13px',
        lineHeight: 1
    },
    collapsibleContent: {
        marginTop: '14px'
    },
    statusBadge: {
        display: 'inline-block',
        padding: '4px 12px',
        borderRadius: '12px',
        fontSize: '12px',
        fontWeight: 500
    },
    statusInitialized: {
        backgroundColor: 'var(--vscode-testing-iconPassed)',
        color: 'var(--vscode-editor-background)'
    },
    statusNotInitialized: {
        backgroundColor: 'var(--vscode-testing-iconFailed)',
        color: 'var(--vscode-editor-background)'
    },
    button: {
        padding: '8px 16px',
        fontSize: '13px',
        fontWeight: 500,
        border: 'none',
        borderRadius: '4px',
        cursor: 'pointer',
        marginRight: '8px',
        marginBottom: '8px',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px'
    },
    primaryButton: {
        backgroundColor: 'var(--vscode-button-background)',
        color: 'var(--vscode-button-foreground)'
    },
    secondaryButton: {
        backgroundColor: 'var(--vscode-button-secondaryBackground)',
        color: 'var(--vscode-button-secondaryForeground)'
    },
    disabledButton: {
        opacity: 0.6,
        cursor: 'not-allowed'
    },
    folderList: {
        margin: 0,
        padding: 0,
        listStyle: 'none',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
        gap: '8px'
    },
    folderItem: {
        padding: '8px',
        backgroundColor: 'var(--vscode-textCodeBlock-background)',
        borderRadius: '3px',
        minWidth: 0
    },
    folderName: {
        fontSize: '12px',
        fontFamily: 'var(--vscode-editor-font-family)',
        fontWeight: 600
    },
    fileList: {
        margin: '6px 0 0 0',
        padding: 0,
        listStyle: 'none'
    },
    fileItem: {
        fontSize: '12px',
        fontFamily: 'var(--vscode-editor-font-family)',
        color: 'var(--vscode-descriptionForeground)',
        marginTop: '2px'
    },
    emptyFolder: {
        marginTop: '6px',
        fontSize: '12px',
        color: 'var(--vscode-descriptionForeground)',
        fontStyle: 'italic'
    },
    linkList: {
        margin: 0,
        padding: 0,
        listStyle: 'none'
    },
    link: {
        color: 'var(--vscode-textLink-foreground)',
        textDecoration: 'none',
        cursor: 'pointer',
        fontSize: '13px',
        display: 'block',
        padding: '4px 0'
    },
    inlineLink: {
        color: 'var(--vscode-textLink-foreground)',
        textDecoration: 'none',
        cursor: 'pointer'
    },
    statusPanel: {
        backgroundColor: 'var(--vscode-textCodeBlock-background)',
        borderRadius: '4px',
        padding: '12px'
    },
    statusNote: {
        marginTop: 0,
        marginBottom: '12px',
        fontSize: '13px',
        color: 'var(--vscode-descriptionForeground)'
    },
    actionRow: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: '8px',
        alignItems: 'center'
    },
    stepAction: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: '6px',
        minWidth: '220px'
    },
    stepLabel: {
        fontSize: '11px',
        fontWeight: 700,
        letterSpacing: '0.08em',
        color: 'var(--vscode-descriptionForeground)'
    },
    stepStateComplete: {
        fontSize: '12px',
        fontWeight: 600,
        color: 'var(--vscode-testing-iconPassed)'
    },
    stepStatePending: {
        fontSize: '12px',
        color: 'var(--vscode-descriptionForeground)'
    },
    stepCompleteIcon: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '18px',
        height: '18px',
        marginLeft: '4px',
        borderRadius: '999px',
        fontSize: '12px',
        fontWeight: 700,
        lineHeight: 1
    },
    stepCompleteIconActive: {
        backgroundColor: 'var(--vscode-testing-iconPassed)',
        color: 'var(--vscode-editor-background)'
    },
    stepCompleteIconPending: {
        backgroundColor: 'var(--vscode-disabledForeground)',
        color: 'var(--vscode-editor-background)',
        opacity: 0.75
    },
    structureLabel: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px'
    },
    structureRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        minWidth: 0
    },
    structureText: {
        minWidth: 0,
        overflowWrap: 'anywhere',
        wordBreak: 'break-word'
    },
    structureIcon: {
        width: '14px',
        height: '14px',
        color: 'var(--vscode-descriptionForeground)',
        flex: '0 0 auto'
    },
    changelogMeta: {
        marginTop: 0,
        marginBottom: '12px',
        fontSize: '12px',
        color: 'var(--vscode-descriptionForeground)'
    },
    changelogSectionTitle: {
        marginTop: '12px',
        marginBottom: '6px',
        fontSize: '13px',
        fontWeight: 700
    },
    settingsGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
        gap: '10px'
    },
    settingCard: {
        padding: '12px',
        backgroundColor: 'var(--vscode-textCodeBlock-background)',
        borderRadius: '4px',
        border: '1px solid var(--vscode-panel-border)'
    },
    settingName: {
        margin: 0,
        marginBottom: '6px',
        fontSize: '13px',
        fontWeight: 700
    },
    settingSummary: {
        margin: 0,
        marginBottom: '6px',
        fontSize: '13px'
    },
    settingDetails: {
        margin: 0,
        fontSize: '12px',
        color: 'var(--vscode-descriptionForeground)',
        lineHeight: 1.45
    },
    codeBlock: {
        margin: '10px 0 0 0',
        padding: '12px',
        backgroundColor: 'var(--vscode-textCodeBlock-background)',
        border: '1px solid var(--vscode-panel-border)',
        borderRadius: '4px',
        overflowX: 'auto',
        fontSize: '12px',
        lineHeight: 1.45
    },
    connectorGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
        gap: '10px',
        marginTop: '12px'
    },
    connectorCard: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: '8px',
        padding: '12px',
        backgroundColor: 'var(--vscode-textCodeBlock-background)',
        borderRadius: '4px',
        border: '1px solid var(--vscode-panel-border)'
    },
    connectorName: {
        margin: 0,
        fontSize: '13px',
        fontWeight: 700
    },
    connectorSummary: {
        margin: 0,
        fontSize: '12px',
        color: 'var(--vscode-descriptionForeground)',
        lineHeight: 1.45
    },
    connectorId: {
        margin: 0,
        fontSize: '11px',
        fontFamily: 'var(--vscode-editor-font-family)',
        color: 'var(--vscode-descriptionForeground)',
        overflowWrap: 'anywhere',
        wordBreak: 'break-word'
    },
    bulletList: {
        margin: '10px 0 0 18px',
        padding: 0,
        color: 'var(--vscode-descriptionForeground)',
        fontSize: '13px',
        lineHeight: 1.5,
        overflowWrap: 'anywhere',
        wordBreak: 'break-word'
    }
};

function StructureIcon({ kind }: { kind: StructureIconKind }) {
    if (kind === 'folder') {
        return (
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" style={styles.structureIcon}>
                <path
                    d="M1.75 4.5a1.25 1.25 0 0 1 1.25-1.25h3.1l1.2 1.5H13a1.25 1.25 0 0 1 1.25 1.25v5.5A1.25 1.25 0 0 1 13 12.75H3A1.25 1.25 0 0 1 1.75 11.5v-7Z"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinejoin="round"
                />
            </svg>
        );
    }

    return (
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" style={styles.structureIcon}>
            <path
                d="M4 1.75h5.5l2.5 2.5v9A1.25 1.25 0 0 1 10.75 14.5h-6.5A1.25 1.25 0 0 1 3 13.25v-10A1.5 1.5 0 0 1 4.5 1.75Z"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinejoin="round"
            />
            <path d="M9.5 1.75v2.5h2.5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
    );
}

function StructureList({ entries }: { entries: InitStructureEntry[] }) {
    return (
        <ul style={styles.folderList}>
            {entries.map(({ folder, files, note }) => (
                <li key={folder} style={styles.folderItem}>
                    {note && (
                        <div
                            style={{
                                fontSize: '11px',
                                fontStyle: 'italic',
                                color: 'var(--vscode-descriptionForeground)',
                                marginBottom: '2px',
                            }}
                        >
                            {note}
                        </div>
                    )}
                    <div style={{ ...styles.folderName, ...styles.structureLabel }}>
                        <StructureIcon kind="folder" />
                        <span style={styles.structureText}>{folder}</span>
                    </div>
                    {files.length > 0 ? (
                        <ul style={styles.fileList}>
                            {files.map((file) => (
                                <li key={`${folder}/${file}`} style={{ ...styles.fileItem, ...styles.structureRow }}>
                                    <StructureIcon kind="file" />
                                    <span style={styles.structureText}>{file}</span>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <div style={styles.emptyFolder}>No default files at initialization</div>
                    )}
                </li>
            ))}
        </ul>
    );
}

function CollapsibleSection({
    title,
    children,
    defaultOpen = false,
    id
}: {
    title: React.ReactNode;
    children: React.ReactNode;
    defaultOpen?: boolean;
    id?: string;
}) {
    const [isOpen, setIsOpen] = useState(defaultOpen);

    return (
        <div id={id} style={styles.card}>
            <button
                type="button"
                style={styles.collapsibleHeader}
                aria-expanded={isOpen}
                onClick={() => setIsOpen(!isOpen)}
            >
                <h2 style={styles.collapsibleTitle}>{title}</h2>
                <span style={styles.collapsibleArrow} aria-hidden="true">
                    {isOpen ? '▾' : '▸'}
                </span>
            </button>
            {isOpen && (
                <div style={styles.collapsibleContent}>
                    {children}
                </div>
            )}
        </div>
    );
}

function renderInlineMarkdown(text: string): React.ReactNode {
    const parts = text.split(/(`[^`]+`)/g);
    return parts.map((part, index) => {
        if (part.startsWith('`') && part.endsWith('`')) {
            return <code key={index}>{part.slice(1, -1)}</code>;
        }
        return <React.Fragment key={index}>{part}</React.Fragment>;
    });
}

function renderWhatsNewEntry(entry: ChangelogEntry | null, version: string) {
    if (!entry) {
        return (
            <div style={styles.card}>
                <h2 style={styles.cardTitle}>Latest Changes</h2>
                <p style={styles.statusNote}>
                    {version ? `No changelog entry was found for version ${version}.` : 'No changelog entry was found for this version.'}
                </p>
            </div>
        );
    }

    return (
        <div style={styles.card}>
            <h2 style={styles.cardTitle}>Latest Changes</h2>
            <p style={styles.changelogMeta}>
                Version {entry.version}{entry.date ? ` - ${entry.date}` : ''}
            </p>
            {entry.sections.map(section => (
                <div key={section.title}>
                    <h3 style={styles.changelogSectionTitle}>{section.title}</h3>
                    {section.paragraphs.map((paragraph, index) => (
                        <p key={index} style={styles.statusNote}>
                            {renderInlineMarkdown(paragraph)}
                        </p>
                    ))}
                    {section.items.length > 0 && (
                        <ul style={styles.bulletList}>
                            {section.items.map((item, index) => (
                                <li key={index}>{renderInlineMarkdown(item)}</li>
                            ))}
                        </ul>
                    )}
                </div>
            ))}
        </div>
    );
}

type StorageStatus = {
    location: 'workspace' | 'user' | 'custom';
    customPath: string;
    userPath: string;
    codespacesPath: string;
    resolvedPath: string | null;
    resolvedLocation: 'workspace' | 'user' | 'custom' | null;
    codespaces: boolean;
    workspaceFolderCount: number;
};

function App() {
    const [initialized, setInitialized] = useState<boolean | null>(null);
    const [hasWorkspace, setHasWorkspace] = useState<boolean | null>(null);
    const [mode, setMode] = useState<WelcomeMode>('welcome');
    const [version, setVersion] = useState<string>('');
    const [whatsNewEntry, setWhatsNewEntry] = useState<ChangelogEntry | null>(null);
    const [storage, setStorage] = useState<StorageStatus | null>(null);
    const [customPathDraft, setCustomPathDraft] = useState<string>('');
    // Local "pending" selection that overrides the server-side
    // storage.location visually while a migration prompt is in flight
    // or while the user is still entering a custom path. Cleared as
    // soon as a fresh setStatus arrives from the extension — so if the
    // user cancels the migration dialog, the radio reverts naturally
    // because the extension's authoritative storage.location never
    // changed.
    const [pendingLocation, setPendingLocation] = useState<'workspace' | 'user' | 'custom' | null>(null);

    useEffect(() => {
        // Listen for messages from extension
        const handler = (event: MessageEvent) => {
            const message = event.data;
            if (message.command === 'setStatus') {
                setInitialized(message.initialized);
                setHasWorkspace(message.hasWorkspace);
                setMode((message.mode as WelcomeMode) || 'welcome');
                setVersion((message.version as string) || '');
                setWhatsNewEntry((message.whatsNewEntry as ChangelogEntry | undefined) || null);
                const incoming = (message.storage as StorageStatus | undefined) ?? null;
                setStorage((prevStorage) => {
                    // Clear pending only when the server-side location
                    // actually changed OR matches what the user was
                    // pending. This prevents an unrelated status refresh
                    // (workspace-folders change, other-window storage
                    // event) from clobbering an in-progress custom-path
                    // entry the user is still typing into.
                    if (
                        !prevStorage ||
                        !incoming ||
                        prevStorage.location !== incoming.location
                    ) {
                        setPendingLocation(null);
                    } else {
                        setPendingLocation((pending) =>
                            pending && pending === incoming.location ? null : pending
                        );
                    }
                    return incoming;
                });
                if (incoming) {
                    setCustomPathDraft((prev) => (prev === '' ? incoming.customPath : prev));
                }
            } else if (message.command === 'customPathPicked') {
                const fsPath = typeof message.fsPath === 'string' ? message.fsPath : '';
                if (fsPath) setCustomPathDraft(fsPath);
            }
        };
        window.addEventListener('message', handler);

        // Signal ready
        vscode.postMessage({ command: 'ready' });

        return () => window.removeEventListener('message', handler);
    }, []);

    const handleSelectStorageLocation = (location: 'workspace' | 'user' | 'custom') => {
        // Show the click visually while the migration dialog runs (or,
        // for custom, while the user enters a path).
        setPendingLocation(location);
        if (location === 'custom') {
            // Wait for the user to enter a path and click Save — that's
            // when we commit the change.
            return;
        }
        vscode.postMessage({ command: 'changeStorageLocation', location });
    };

    const handleSaveCustomPath = () => {
        vscode.postMessage({
            command: 'changeStorageLocation',
            location: 'custom',
            customPath: customPathDraft,
        });
    };

    const handleBrowseCustomPath = () => {
        vscode.postMessage({ command: 'browseCustomPath' });
    };

    const handleOpenStorageFolder = () => {
        vscode.postMessage({ command: 'openStorageFolder' });
    };

    const handleInitialize = () => {
        // Refuse to initialize while the user has a pending storage-mode
        // change that hasn't been committed. Otherwise clicking
        // Initialize would run against `storage.location` (the old,
        // server-side value) while the radio visibly shows the user's
        // intended new choice — silently scaffolding in the wrong place.
        if (pendingLocation && storage && pendingLocation !== storage.location) {
            const msg = pendingLocation === 'custom'
                ? 'Enter a custom storage path and click Save before initializing.'
                : `Commit the pending "${pendingLocation}" storage-location change before initializing.`;
            vscode.postMessage({ command: 'showWarning', message: msg });
            return;
        }
        const location = storage?.location ?? 'workspace';
        if (location === 'workspace' && !hasWorkspace) {
            return;
        }
        vscode.postMessage({ command: 'initialize' });
    };

    const handleOpenFolder = () => {
        vscode.postMessage({ command: 'openFolder' });
    };

    const handleAddConnection = () => {
        vscode.postMessage({ command: 'addConnection' });
    };

    const handleOpenSettings = () => {
        vscode.postMessage({ command: 'openSettings' });
    };

    const handleOpenAiSettings = () => {
        vscode.postMessage({ command: 'openAiSettings' });
    };

    const handleOpenReadme = () => {
        vscode.postMessage({ command: 'openReadme' });
    };

    const handleOpenExtensionSearch = (extensionQuery: string) => {
        vscode.postMessage({ command: 'openExtensionSearch', extensionQuery });
    };

    const workspaceRequired = storage?.location !== 'user' && storage?.location !== 'custom';
    const canResolveStorage = storage?.resolvedPath != null;
    const step1Complete = workspaceRequired ? hasWorkspace === true : canResolveStorage;
    const step2Complete = initialized === true;
    const step1Active = workspaceRequired ? hasWorkspace === false : !canResolveStorage;
    const step2Active = step1Complete && initialized === false;
    const isWhatsNew = mode === 'whatsNew';
    const canUseInitializedActions = initialized === true;
    // Block Initialize while the user has an uncommitted storage-mode
    // change pending (radio selection that hasn't been saved). Prevents
    // scaffolding against the visibly-stale server-side location.
    const hasPendingStorageChange =
        pendingLocation !== null &&
        !!storage &&
        pendingLocation !== storage.location;
    const canInitialize = !hasPendingStorageChange && (workspaceRequired ? hasWorkspace === true : canResolveStorage);

    return (
        <div style={styles.container}>
            {/* Header */}
            <div style={styles.header}>
                <h1 style={styles.title}>
                    {isWhatsNew ? "What's New in RunQL" : 'RunQL'}
                </h1>
                {!isWhatsNew && (
                    <p style={styles.trustStatement}>
                        Welcome. You're four clicks away from getting better context for AI assistance for your data work.
                        Pick where RunQL should keep your files, initialize, and then select your preferred AI in the RunQL settings (Codex, Claude Code, or others).
                    </p>
                )}
            </div>

            {isWhatsNew && renderWhatsNewEntry(whatsNewEntry, version)}

            {/* Workspace Status */}
            {(() => {
                const setupTitle = (
                    <>
                        <span style={{ marginRight: '4px' }}>Setup Steps </span>
                        {initialized === null ? (
                            <span style={{ ...styles.statusBadge, backgroundColor: 'var(--vscode-descriptionForeground)', fontSize: '9px' }}>
                                Checking...
                            </span>
                        ) : initialized ? (
                            <span style={{ ...styles.statusBadge, ...styles.statusInitialized, fontSize: '9px' }}>
                                ✓ Initialized
                            </span>
                        ) : (
                            <span style={{ ...styles.statusBadge, ...styles.statusNotInitialized, fontSize: '9px' }}>
                                Not Initialized
                            </span>
                        )}
                    </>
                );
                const setupBody = (
                    <div style={styles.statusPanel}>
                    {workspaceRequired && hasWorkspace === false && (
                        <p style={styles.statusNote}>
                            Open or create a project folder, then initialize RunQL. (Or switch to user-level storage below.)
                        </p>
                    )}
                    {!workspaceRequired && !canResolveStorage && (
                        <p style={styles.statusNote}>
                            Configure a valid storage path below, then initialize RunQL.
                        </p>
                    )}
                    {step1Complete && initialized === false && (
                        <p style={styles.statusNote}>
                            Storage is ready. Now Initialize RunQL.
                        </p>
                    )}
                    {initialized === true && (
                        <p style={styles.statusNote}>
                            RunQL is initialized.
                        </p>
                    )}
                    {storage && (
                        <div style={{ marginTop: 12, marginBottom: 12, padding: 12, border: '1px solid var(--vscode-panel-border)', borderRadius: 4 }}>
                            <div style={{ ...styles.stepLabel, marginBottom: 6 }}>
                                STEP 1 — STORAGE LOCATION
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
                                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
                                    <input
                                        type="radio"
                                        name="storageLocation"
                                        value="workspace"
                                        checked={(pendingLocation ?? storage.location) === 'workspace'}
                                        onChange={() => handleSelectStorageLocation('workspace')}
                                        style={{ marginTop: 3 }}
                                    />
                                    <span>
                                        <strong>Workspace folder</strong>
                                        <span style={{ display: 'block', fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
                                            Stores RunQL files in this project.
                                        </span>
                                    </span>
                                </label>
                                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
                                    <input
                                        type="radio"
                                        name="storageLocation"
                                        value="user"
                                        checked={(pendingLocation ?? storage.location) === 'user'}
                                        onChange={() => handleSelectStorageLocation('user')}
                                        style={{ marginTop: 3 }}
                                    />
                                    <span>
                                        <strong>User-level folder</strong>
                                        <span style={{ display: 'block', fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
                                            One system-user location for RunQL files across all your projects on this {storage.codespaces ? 'Codespace' : 'machine'}.
                                        </span>
                                    </span>
                                </label>
                                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
                                    <input
                                        type="radio"
                                        name="storageLocation"
                                        value="custom"
                                        checked={(pendingLocation ?? storage.location) === 'custom'}
                                        onChange={() => handleSelectStorageLocation('custom')}
                                        style={{ marginTop: 3 }}
                                    />
                                    <span>
                                        <strong>Custom folder</strong>
                                        <span style={{ display: 'block', fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
                                            Stores RunQL files in a path you choose - outside of your project folder.
                                        </span>
                                    </span>
                                </label>
                            </div>
                            {(pendingLocation ?? storage.location) === 'custom' && (
                                <div style={{ marginTop: 8, marginBottom: 8 }}>
                                    <div style={{ display: 'flex', gap: 6 }}>
                                        <input
                                            type="text"
                                            value={customPathDraft}
                                            onChange={(e) => setCustomPathDraft(e.target.value)}
                                            placeholder="/absolute/path/to/.runql"
                                            style={{
                                                flex: 1,
                                                padding: '4px 6px',
                                                backgroundColor: 'var(--vscode-input-background)',
                                                color: 'var(--vscode-input-foreground)',
                                                border: '1px solid var(--vscode-input-border)',
                                                borderRadius: 2,
                                                fontSize: '12px',
                                            }}
                                        />
                                        <button style={{ ...styles.button, ...styles.primaryButton }} onClick={handleSaveCustomPath}>
                                            Save
                                        </button>
                                        <button style={{ ...styles.button, ...styles.secondaryButton }} onClick={handleBrowseCustomPath}>
                                            Browse…
                                        </button>
                                    </div>
                                    {pendingLocation === 'custom' && storage.location !== 'custom' && (
                                        <div style={{ marginTop: 4, fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
                                            Enter a path and click <strong>Save</strong> to commit the change. Cancel to revert.
                                        </div>
                                    )}
                                </div>
                            )}
                            <div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)', marginTop: 6 }}>
                                Current storage location:{' '}
                                {storage.resolvedPath ? (
                                    <>
                                        <div>You can switch storage modes anytime - RunQL moves your files for you.</div>
                                        <div>
                                            <code style={{ fontSize: '11px' }}>{storage.resolvedPath}</code>{' '}
                                            <button style={{ ...styles.button, ...styles.secondaryButton, padding: '0 6px', fontSize: '10px' }} onClick={handleOpenStorageFolder}>
                                                Open
                                            </button>
                                        </div>
                                    </>
                                ) : (
                                    <em>
                                        {storage.location === 'workspace' && storage.workspaceFolderCount === 0
                                            ? 'Open a folder to enable workspace storage.'
                                            : storage.location === 'custom'
                                                ? 'Enter a valid absolute path above.'
                                                : 'Unresolvable.'}
                                    </em>
                                )}
                            </div>
                        </div>
                    )}
                    {initialized !== null && (
                        <div style={styles.actionRow}>
                            <div style={styles.stepAction}>
                                <div style={styles.stepLabel}>STEP 2</div>
                                <button
                                    style={{
                                        ...styles.button,
                                        ...(step1Active ? styles.primaryButton : styles.secondaryButton),
                                        ...(step1Active ? {} : { border: '1px solid var(--vscode-textBlockQuote-background)' }),
                                        marginRight: 0
                                    }}
                                    onClick={handleOpenFolder}
                                >
                                    Open Folder
                                    <span
                                        style={{
                                            ...styles.stepCompleteIcon,
                                            ...(step1Complete ? styles.stepCompleteIconActive : styles.stepCompleteIconPending)
                                        }}
                                        aria-label={step1Complete ? 'Completed' : 'Pending'}
                                    >
                                        ✓
                                    </span>
                                </button>
                            </div>
                            <div style={styles.stepAction}>
                                <div style={styles.stepLabel}>STEP 3</div>
                                <button
                                    style={{
                                        ...styles.button,
                                        ...(step2Active ? styles.primaryButton : styles.secondaryButton),
                                        ...(step2Active ? {} : { border: '1px solid var(--vscode-panel-border)' }),
                                        marginRight: 0,
                                        ...((step2Active || step2Complete) ? {} : {
                                            opacity: 0.6,
                                            cursor: 'not-allowed'
                                        })
                                    }}
                                    onClick={handleInitialize}
                                    disabled={!canInitialize || initialized === true}
                                    title={
                                        initialized === true
                                            ? 'RunQL is already initialized.'
                                            : canInitialize
                                                ? 'Initialize RunQL'
                                                : workspaceRequired
                                                    ? 'Open a folder to enable initialization.'
                                                    : 'Configure a valid storage location above to enable initialization.'
                                    }
                                >
                                    Initialize RunQL
                                    <span
                                        style={{
                                            ...styles.stepCompleteIcon,
                                            ...(step2Complete ? styles.stepCompleteIconActive : styles.stepCompleteIconPending)
                                        }}
                                        aria-label={step2Complete ? 'Completed' : 'Pending'}
                                    >
                                        ✓
                                    </span>
                                </button>
                            </div>
                        </div>
                    )}
                    </div>
                );
                return initialized === true ? (
                    <CollapsibleSection title={setupTitle} defaultOpen={false}>
                        {setupBody}
                    </CollapsibleSection>
                ) : (
                    <div style={styles.card}>
                        <h2 style={styles.cardTitle}>{setupTitle}</h2>
                        {setupBody}
                    </div>
                );
            })()}

            {/* AI Settings */}
            <div style={styles.card}>
                <h2 style={styles.cardTitle}>Connect your AI (optional — skip if you don't want AI)</h2>
                <div style={styles.statusPanel}>
                    <p style={styles.statusNote}>
                        Point RunQL at any AI you already use - GitHub Copilot, Claude Code, Codex, your own API key — or skip this and turn it on later. Your AI interacts with RunQL for context to enable query generation, schema descriptions, inline comments, and more.
                    </p>
                    <div style={styles.actionRow}>
                        <div style={styles.stepAction}>
                            <div style={styles.stepLabel}>STEP 4</div>
                            <button
                                style={{
                                    ...styles.button,
                                    ...styles.primaryButton,
                                    marginRight: 0,
                                }}
                                onClick={handleOpenAiSettings}
                                title="Open the RunQL AI Settings in the VS Code Settings editor"
                            >
                                Open AI Settings
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {/* Quick Actions */}
            <div style={styles.card}>
                <h2 style={styles.cardTitle}>Quick Actions</h2>
                <div>
                    <button
                        style={{
                            ...styles.button,
                            ...styles.primaryButton,
                            ...(canUseInitializedActions ? {} : styles.disabledButton)
                        }}
                        onClick={handleAddConnection}
                        disabled={!canUseInitializedActions}
                        title={canUseInitializedActions ? 'Add DB Connection' : 'Initialize RunQL before adding a DB connection.'}
                    >
                        ➕ Add DB Connection
                    </button>
                    <button
                        style={{ ...styles.button, ...styles.secondaryButton }}
                        onClick={handleOpenSettings}
                    >
                        ⚙️ Open RunQL Settings
                    </button>
                    <button
                        style={{
                            ...styles.button,
                            ...styles.secondaryButton,
                            ...(canUseInitializedActions ? {} : styles.disabledButton)
                        }}
                        onClick={handleOpenReadme}
                        disabled={!canUseInitializedActions}
                        title={canUseInitializedActions ? 'Open README_RUNQL.md' : 'Initialize RunQL to create README_RUNQL.md.'}
                    >
                        📘 Open README_RUNQL.md
                    </button>
                </div>
                <p style={{ ...styles.statusNote, marginBottom: 0 }}>
                    Add a connection anytime by clicking on the RunQL icon in the Activity Bar (left navigation), and clicking the + in the Explorer View Panel.
                </p>
            </div>

            <CollapsibleSection id="ai-settings-guide" title="AI Settings Guide">
                <p style={{ ...styles.statusNote, marginBottom: '12px' }}>
                    These are the settings that matter for AI setup in RunQL. Start with AI Source, then only fill in the settings that match that choice.
                </p>
                <div style={styles.settingsGrid}>
                    {AI_SETTINGS.map((setting) => (
                        <div key={setting.name} style={styles.settingCard}>
                            <h3 style={styles.settingName}>{setting.name}</h3>
                            <p style={styles.settingSummary}>{setting.summary}</p>
                            <p style={styles.settingDetails}>{setting.details}</p>
                        </div>
                    ))}
                </div>
                <ul style={styles.bulletList}>
                    <li>If you choose <strong>GitHub Copilot / VS Code AI</strong>, you usually only need AI Model.</li>
                    <li>If you choose <strong>AI Extension</strong>, you usually only need AI Extension.</li>
                    <li>If you choose <strong>Direct API</strong>, you usually need API Provider, AI Model, and sometimes API Base URL.</li>
                </ul>
            </CollapsibleSection>

            <CollapsibleSection title="Optional VSCode Marketplace Configuration & Github Copilot">
                <p style={styles.statusNote}>
                    Add the VS Code Marketplace if you want to use GitHub Copilot. Official extensions for Claude Code and Codex are available in both OpenVSX and the VS Code Marketplace.  Open-source builds cannot ship the VSCode Marketplace as the default but you are allowed to enable it.
                </p>
                <p style={styles.statusNote}>
                    To add the VS Code Marketplace, create or open <code>product.json</code>, add or merge this top-level <code>extensionsGallery</code> configuration, then restart the IDE.
                </p>
                <ul style={styles.bulletList}>
                    <li><strong>macOS:</strong> <code>~/Library/Application Support/VSCodium/product.json</code></li>
                    <li><strong>Windows:</strong> <code>%APPDATA%\VSCodium\product.json</code></li>
                    <li><strong>Linux:</strong> <code>~/.config/VSCodium/product.json</code></li>
                </ul>
                <p style={{ ...styles.statusNote, marginTop: '10px' }}>
                    If your open-source VS Code build uses a different app name, use that app folder in the same OS-specific location.
                </p>
                <pre style={styles.codeBlock}>
                    <code>{VSCODE_MARKETPLACE_CONFIG}</code>
                </pre>
            </CollapsibleSection>

            {/* What Initialize Creates */}
            <CollapsibleSection title="What does initialization do?">
                <div style={{ marginTop: '10px', marginBottom: '10px' }}>
                    Initialization creates default folders and files for SQL, schema, and ERD workflows.
                </div>

                <div style={{ marginTop: '8px', marginBottom: '6px', fontSize: '13px', fontWeight: 600 }}>
                    RunQL data (queries, schemas, prompts, indexes):
                </div>
                <div style={{ fontSize: '13px', color: 'var(--vscode-descriptionForeground)', marginBottom: '6px' }}>
                    <code>&lt;storage-root&gt;</code> is <code>&lt;project&gt;/RunQL/</code> in
                    {' '}<strong>Workspace folder</strong> mode, <code>~/.runql/</code> in
                    {' '}<strong>User-level</strong> mode, or the path you chose in
                    {' '}<strong>Custom folder</strong> mode.
                </div>
                <StructureList entries={STORAGE_TREE_ENTRIES} />

                <div style={{ marginTop: '14px', marginBottom: '6px', fontSize: '13px', fontWeight: 600 }}>
                    Project-local RunQL files (in every workspace folder linked to RunQL):
                </div>
                <StructureList entries={PROJECT_ROOT_ENTRIES} />

                <div style={{ marginTop: '10px', marginBottom: '10px' }}>
                    <div style={{ ...styles.folderName, ...styles.structureRow, marginBottom: '6px' }}>
                        <StructureIcon kind="file" />
                        <span style={styles.structureText}>Guidance files (<code>AGENTS.md</code>, <code>README_RUNQL.md</code>):</span>
                    </div>
                    <div style={{ fontSize: '13px', lineHeight: 1.5 }}>
                        <code>AGENTS.md</code> is used to give AI Agents instructions. RunQL only modifies a section inside <code>AGENTS.md</code> (delimited by
                        {' '}<code>&lt;!-- RUNQL:BEGIN --&gt;</code> / <code>&lt;!-- RUNQL:END --&gt;</code> markers). Unrelated content is
                        never touched.  If the file does not exist then RunQL will create it.
                        <br />
                        <code>README_RUNQL.md</code> contains some details about how RunQL helps you.
                    </div>
                </div>
            </CollapsibleSection>

            <CollapsibleSection title="Add other DB Connectors">
                <p style={styles.statusNote}>
                    Install official connectors for other databases that are not included in RunQL core.
                </p>
                <div style={styles.connectorGrid}>
                    {OFFICIAL_CONNECTORS.map((connector) => (
                        <div key={connector.extensionId} style={styles.connectorCard}>
                            <h3 style={styles.connectorName}>{connector.name}</h3>
                            <p style={styles.connectorSummary}>{connector.summary}</p>
                            <p style={styles.connectorId}>{connector.extensionId}</p>
                            <button
                                type="button"
                                style={{ ...styles.button, ...styles.secondaryButton, marginRight: 0, marginBottom: 0 }}
                                onClick={() => handleOpenExtensionSearch(connector.name)}
                            >
                                Search Extensions
                            </button>
                        </div>
                    ))}
                </div>
            </CollapsibleSection>

            {/* Documentation */}
            <div style={styles.card}>
                <h2 style={styles.cardTitle}>Documentation</h2>
                <ul style={styles.linkList}>
                    <li>
                        <a
                            style={styles.link}
                            href="https://runql.com/opensource/"
                            target="_blank"
                        >
                            RunQL Website
                        </a>
                    </li>
                    <li>
                        <a
                            style={styles.link}
                            href="https://github.com/DVCodeLabs/RunQL/blob/main/README.md"
                            target="_blank"
                        >
                            RunQL Documentation
                        </a>
                    </li>
                    <li>
                        <a
                            style={styles.link}
                            href="https://github.com/DVCodeLabs/RunQL/blob/main/docs/getting-started.md"
                            target="_blank"
                        >
                            Getting Started Guide
                        </a>
                    </li>
                    <li>
                        <a
                            style={styles.link}
                            href="https://github.com/DVCodeLabs/RunQL"
                            target="_blank"
                        >
                            Community & Support
                        </a>
                    </li>
                </ul>
            </div>
        </div>
    );
}

// Mount
const rootEl = document.getElementById('root');
if (rootEl) {
    createRoot(rootEl).render(<App />);
}

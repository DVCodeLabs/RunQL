import * as vscode from "vscode";

import type { ScriptExecutionResult } from "./core/types";
import { canonicalizeSql } from "./core/hashing";
import { Logger } from "./core/logger";

// Tree views + watchers
import { ExplorerViewProvider, ExplorerItem } from "./connections/explorerView";
import { SavedQueriesViewProvider } from "./queryLibrary/savedQueriesView";
import { registerQuerySearchView } from "./queryLibrary/querySearchView";
import { registerDPWatchers } from "./core/watchers";

// Store initialization
import { initConnectionStore } from "./connections/connectionStore";
import { registerConnectionCommands } from "./connections/connectionCommands";
import { registerActionsMenus, attachConnectionsSelectionTracking } from "./ui/actionsMenus";
import { DPDocConnectionStore, DPSqlCodelensProvider } from "./ui/sqlCodelens";
import { registerSqlCodelensCommands } from "./ui/sqlCodelensCommands";
import { loadConnectionProfiles, saveConnectionProfile, getConnectionSecrets } from "./connections/connectionStore";
import { SqlFormattingProvider } from "./formatting/formatSql";
import { quoteIdentifier, resolveEffectiveSqlDialect, toSqlLiteral } from "./core/sqlUtils";

// NEW: context keys for enabling/disabling commands/UI
import { setHasActiveConnection, setHasActiveSchema, setHasSimilarQueries } from "./core/context";

// Schema diff
import { registerSchemaDiffCommands } from "./schema/diffCommands";
import { SchemaDiffContentProvider } from "./schema/diffProvider";
import { loadSchemas } from "./schema/schemaStore";

import {
  ConnectionProfile,
  ConnectionSecrets,
  DbDialect,
  QueryApprovalViewState,
  QueryColumn,
  QueryResultMeta,
  QueryResultSource,
  SecureQLKeyInfo,
  ApplyResultsetEditsRequest,
  ApplyResultsetEditsResult,
  ResultsetRowEdit,
  SchemaIntrospection,
  TableModel,
  ColumnModel,
  RoutineParameterModel,
  QueryIndexEntry,
  QuerySchemaContext
} from './core/types';
import { getAdapter, registerAdapter } from './connections/adapterFactory';
import { setSecureQLSaveProfile } from './connections/adapterFactory';
import { DPCompletionProvider } from './completion/completionProvider';
import { ProviderRegistry } from './connections/providerRegistry';
import { RunQLExtensionApi } from './api';
import { refreshAllSecureQLProfiles } from './connections/secureqlStartupRefresh';

import { queryIndex } from './queryLibrary/queryIndex';

import { ResultsViewProvider } from './results/resultsView';
import { MarkdownViewProvider } from './markdown/markdownView';
import { ERDViewProvider } from './erd/erdViewProvider';
import { updateProjectInitializedContext, isProjectInitialized } from './core/isProjectInitialized';
import { WelcomeView } from './ui/welcomeView';
import { CreateTableView, CreateTablePanelContext, CreateTableResultPayload } from './ui/createTableView';
import { buildCreateTableSql, buildAlterTableSql, buildDropTableSql, CreateTableDraft } from './core/createTableSql';
import {
  getKeyInfo,
  getQueryApprovalRequest,
  createQueryApprovalRequest,
  SecureQLApprovalRequiredError,
  SecureQLApprovalRequestResponse,
  SecureQLRequestOptions
} from './connections/adapters/secureqlClient';

type ApplyResultsetEditsCommandPayload = ApplyResultsetEditsRequest & {
  confirmed?: boolean;
};

export async function activate(context: vscode.ExtensionContext): Promise<RunQLExtensionApi> {
  // Initialize logger first
  Logger.initialize("RunQL");
  Logger.info("RunQL extension activating...");

  const extensionVersion = String((context.extension.packageJSON as { version?: string } | undefined)?.version ?? "");
  const previousExtensionVersion = context.globalState.get<string>("runql.lastExtensionVersion");

  // Migrate legacy AI settings to the simplified source/provider model
  const { migrateAiProviderSetting, normalizeAiSettings, initializeAiSettingsSyncSnapshot } = await import('./ai/aiService');
  await migrateAiProviderSetting();
  await normalizeAiSettings(context, extensionVersion || 'dev');
  initializeAiSettingsSyncSnapshot();

  let projectInitializedAtStartup = false;
  let autoWelcomeShownThisSession = false;
  let autoWhatsNewShownThisSession = false;
  const tablePreviewContextByDocUri = new Map<string, {
    sql: string;
    source: QueryResultSource;
    primaryKeyColumns: string[];
    editableColumns: string[];
    columns?: ColumnModel[];
  }>();
  const lastRunContextByDocUri = new Map<string, {
    refreshSql: string;
    userSql: string;
  }>();

  // 1. Register Panel View Providers IMMEDIATELY
  const resultsViewProvider = new ResultsViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ResultsViewProvider.viewType, resultsViewProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  const erdViewProvider = new ERDViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ERDViewProvider.viewType, erdViewProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  const markdownViewProvider = new MarkdownViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(MarkdownViewProvider.viewType, markdownViewProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // 2. Initialize Core Systems
  try {
    initConnectionStore(context);

    // Wire up SecureQL adapter's save callback so it can persist profile changes
    setSecureQLSaveProfile(saveConnectionProfile);

    // Check project initialization status (read-only)
    const initialized = await updateProjectInitializedContext();
    projectInitializedAtStartup = initialized;

    // Only initialize write-path systems if project is already initialized
    // This prevents automatic file creation before user explicitly initializes
    if (initialized) {
      // Initialize all project components
      await initializeProjectComponents(context);
    }

    // Startup refresh: sync server-controlled flags for all SecureQL connections (background, non-blocking)
    refreshAllSecureQLProfiles(loadConnectionProfiles, getConnectionSecrets, saveConnectionProfile).catch(() => {
      // Silently ignore startup refresh errors — flags will be refreshed on next query
    });
  } catch (err) {
    Logger.error("Failed to initialize core systems", err);
  }

  // -----------------------------
  // Tree Views registration
  // -----------------------------
  const explorerProvider = new ExplorerViewProvider(context);
  const savedQueriesProvider = new SavedQueriesViewProvider();
  // CodeLens Provider & Store (New)
  const codeLensStore = new DPDocConnectionStore(context.workspaceState);
  codeLensStore.loadFromWorkspaceState();

  // Simple cache for synchronous label lookup and default fallback
  // LOAD from workspace state immediately to avoid "pop-in" delay
  const CACHE_KEY = "runql.connectionNamesCache.v1";
  const FIRST_ID_KEY = "runql.firstConnectionId.v1";

  const savedCache = context.workspaceState.get<Record<string, string>>(CACHE_KEY, {});
  const connectionNameCache = new Map<string, string>(Object.entries(savedCache));

  let firstConnectionId: string | undefined = context.workspaceState.get<string>(FIRST_ID_KEY);
  const productionWarningItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  productionWarningItem.text = '$(warning) PRODUCTION CONNECTION';
  productionWarningItem.tooltip = 'RunQL warning: this SQL editor is using a production-tagged connection.';
  productionWarningItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  productionWarningItem.color = new vscode.ThemeColor('statusBarItem.errorForeground');
  productionWarningItem.hide();
  context.subscriptions.push(productionWarningItem);

  const updateConnectionCache = async () => {
    try {
      const profiles = await loadConnectionProfiles();
      connectionNameCache.clear();
      profiles.forEach(p => {
        connectionNameCache.set(p.id, p.name);
      });

      if (profiles.length > 0) {
        firstConnectionId = profiles[0].id;
      } else {
        firstConnectionId = undefined;
      }

      // Persist the cache for next session speedup
      await context.workspaceState.update(CACHE_KEY, Object.fromEntries(connectionNameCache));
      await context.workspaceState.update(FIRST_ID_KEY, firstConnectionId);

      // Trigger forced refresh of lenses
      codeLensProvider.refresh();
      await refreshProductionWarningBar();
    } catch (e) {
      Logger.error("Failed to update connection cache", e);
    }
  };


  const getEffectiveConnectionId = (docId?: string) => {
    // 1. Check doc specific
    if (docId) return docId;
    // 2. Check global active
    const active = context.workspaceState.get<string>("runql.activeConnectionId");
    if (active) return active;
    // 3. Fallback to first
    return firstConnectionId;
  };

  const buildResultMeta = async (
    profile: ConnectionProfile,
    docUri: vscode.Uri,
    userSql: string,
    columns: QueryColumn[]
  ): Promise<QueryResultMeta> => {
    const resultId = createResultId();
    const editingEnabled = vscode.workspace.getConfiguration('runql').get<boolean>('results.editing.enabled', true);
    const base: QueryResultMeta = {
      resultId,
      editable: {
        enabled: false,
        reason: 'Resultset editing is disabled in settings.',
        primaryKeyColumns: [],
        editableColumns: []
      }
    };

    if (!editingEnabled) {
      return base;
    }

    if (profile.allowDataEdit === false) {
      base.editable.reason = 'Connection is configured as read-only for edits.';
      return base;
    }

    const previewCtx = tablePreviewContextByDocUri.get(docUri.toString());
    if (!previewCtx) {
      const resolved = await resolveEditableSourceFromQuery(profile, userSql);
      if (!resolved) {
        base.editable.reason = 'Only table preview or simple single-table SELECT queries are editable.';
        return base;
      }

      const mapped = mapEditableMetadataToResultColumns(columns, resolved.primaryKeyColumns, resolved.editableColumns);
      if (!mapped.ok) {
        base.editable.reason = mapped.reason;
        return base;
      }

      applyColumnMetadataToResultColumns(columns, resolved.columns);
      base.source = resolved.source;
      base.editable = {
        enabled: true,
        primaryKeyColumns: mapped.primaryKeyColumns,
        editableColumns: mapped.editableColumns
      };
      return base;
    }

    if (normalizeSqlForComparison(userSql) !== normalizeSqlForComparison(previewCtx.sql)) {
      const resolved = await resolveEditableSourceFromQuery(profile, userSql);
      if (!resolved) {
        base.editable.reason = 'Query text changed from table preview and is not a supported editable query.';
        return base;
      }

      const mapped = mapEditableMetadataToResultColumns(columns, resolved.primaryKeyColumns, resolved.editableColumns);
      if (!mapped.ok) {
        base.editable.reason = mapped.reason;
        return base;
      }

      applyColumnMetadataToResultColumns(columns, resolved.columns);
      base.source = resolved.source;
      base.editable = {
        enabled: true,
        primaryKeyColumns: mapped.primaryKeyColumns,
        editableColumns: mapped.editableColumns
      };
      return base;
    }

    const mappedPreview = mapEditableMetadataToResultColumns(columns, previewCtx.primaryKeyColumns, previewCtx.editableColumns);
    if (!mappedPreview.ok) {
      base.editable.reason = mappedPreview.reason;
      return base;
    }

    applyColumnMetadataToResultColumns(columns, previewCtx.columns);
    base.source = previewCtx.source;
    base.editable = {
      enabled: true,
      primaryKeyColumns: mappedPreview.primaryKeyColumns,
      editableColumns: mappedPreview.editableColumns
    };

    return base;
  };

  type QueryApprovalPoller = {
    docUri: vscode.Uri;
    opts: SecureQLRequestOptions;
    profile: ConnectionProfile;
    secrets: ConnectionSecrets;
    userSql: string;
    schemaContext?: QuerySchemaContext;
    selection?: vscode.Range;
    requestId: string;
    startedAt: number;
    consecutiveFailures: number;
    timer?: NodeJS.Timeout;
    stopped: boolean;
  };

  const approvalPollersByDocUri = new Map<string, QueryApprovalPoller>();

  const getSchemaContextForDocUri = (
    docUri: vscode.Uri,
  ): QuerySchemaContext | undefined => {
    const doc = vscode.workspace.textDocuments.find((document) => document.uri.toString() === docUri.toString());
    return doc ? codeLensStore.getSchemaContext(doc) : undefined;
  };

  const savedSchemaContextIsAvailable = async (
    connectionId: string,
    schemaName: string,
    catalogName?: string | null,
  ): Promise<boolean> => {
    const allSchemas = await loadSchemas();
    const schemaInfo = allSchemas.find((schema) => schema.connectionId === connectionId);
    return Boolean(schemaInfo?.schemas.some((schema) =>
      schema.name === schemaName && (schema.catalog ?? null) === (catalogName ?? null),
    ));
  };

  const isApprovalRequiredError = (error: unknown): error is SecureQLApprovalRequiredError => {
    const candidate = error as SecureQLApprovalRequiredError | undefined;
    return Boolean(
      candidate
      && candidate.statusCode === 202
      && candidate.name === 'SecureQLApprovalRequiredError'
      && candidate.approval?.request_id !== undefined
      && candidate.approval?.request_id !== null
    );
  };

  const isServerNoApprovalRequiredError = (error: unknown): boolean => {
    const candidate = error as { statusCode?: number; message?: string; userMessage?: string; serverMessage?: string } | undefined;
    if (candidate?.statusCode !== 400) {
      return false;
    }
    return [candidate.message, candidate.userMessage, candidate.serverMessage].some((message) =>
      typeof message === 'string' && message.includes('This query does not require approval'),
    );
  };

  const toApprovalViewStatus = (status: string): QueryApprovalViewState['status'] => {
    switch (status) {
      case 'approval_required':
        return 'approval_required';
      case 'Pending':
        return 'pending';
      case 'Approved':
        return 'approved';
      case 'Executing':
        return 'executing';
      case 'Executed':
        return 'executed';
      case 'Expired':
        return 'expired';
      case 'Denied':
        return 'denied';
      case 'Cancelled':
        return 'cancelled';
      case 'Execution Failed':
        return 'execution_failed';
      default:
        return 'polling_failed';
    }
  };

  const isTerminalApprovalStatus = (status: string): boolean => {
    return status === 'Executed'
      || status === 'Denied'
      || status === 'Cancelled'
      || status === 'Execution Failed';
  };

  const buildApprovalViewState = (
    response: SecureQLApprovalRequestResponse,
    overrides: Partial<QueryApprovalViewState> = {},
  ): QueryApprovalViewState => {
    const status = overrides.status ?? toApprovalViewStatus(response.status);
    const terminal = isTerminalApprovalStatus(response.status);
    return {
      requestId: String(response.request_id),
      status,
      message: response.message || 'This query requires approval before execution. Approval has been requested.',
      submittedAt: response.submitted_at,
      connectionName: response.connection_name,
      primaryCommandTag: response.primary_command_tag,
      reviewerDisplayName: response.reviewer_display_name,
      reviewedAt: response.reviewed_at,
      approvalExpiresAt: response.approval_expires_at,
      denialReason: response.denial_reason,
      executionStartedAt: response.execution_started_at,
      executionCompletedAt: response.execution_completed_at,
      runtimeMs: response.runtime_ms,
      executionErrorMessage: response.execution_error_message,
      nextCheckAt: overrides.nextCheckAt,
      manualCheckAvailableAt: overrides.manualCheckAvailableAt,
      canStop: !terminal && status !== 'polling_stopped',
      canCheckStatus: status === 'polling_stopped' || status === 'polling_failed',
      canResume: status === 'polling_stopped' || status === 'polling_failed',
      ...overrides,
    };
  };

  const postApprovalState = (docUri: vscode.Uri, state: QueryApprovalViewState) => {
    resultsViewProvider.show(docUri);
    resultsViewProvider.postMessage(docUri, 'updateQueryApproval', state);
  };

  const approvalCommandTagForSql = (sql: string): string | undefined => {
    const cleaned = sql
      .replace(/^\s*(?:--[^\n]*\n\s*)+/g, '')
      .replace(/^\s*(?:\/\*[\s\S]*?\*\/\s*)+/g, '')
      .trim();
    const match = cleaned.match(/^(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|REVOKE)\b/i);
    return match?.[1]?.toUpperCase();
  };

  const secureQLApprovalRequiredForSql = (profile: ConnectionProfile, sql: string): boolean => {
    if (profile.dialect !== 'secureql' || !profile.secureqlQueryApprovalEnabled) {
      return false;
    }
    const required = new Set((profile.secureqlQueryApprovalRequiredCommandTags ?? []).map((tag) => tag.toUpperCase()));
    if (required.size === 0) {
      return false;
    }
    const { splitStatements } = require('./core/sqlSplitter');
    return splitStatements(sql).some((statement: { sql: string }) => {
      const tag = approvalCommandTagForSql(statement.sql);
      return !!tag && required.has(tag);
    });
  };

  const refreshSecureQLApprovalPolicyForRun = async (
    profile: ConnectionProfile,
    secrets: ConnectionSecrets,
  ): Promise<SecureQLKeyInfo | undefined> => {
    if (profile.dialect !== 'secureql' || !profile.secureqlBaseUrl || !secrets.apiKey) {
      return undefined;
    }

    try {
      const info = await getKeyInfo(profile.secureqlBaseUrl, secrets.apiKey);
      const requiredTags = info.query_approval?.required_command_tags ?? [];
      let changed = false;

      const setIfChanged = <K extends keyof ConnectionProfile>(key: K, value: ConnectionProfile[K]) => {
        if (profile[key] !== value) {
          profile[key] = value;
          changed = true;
        }
      };

      setIfChanged('secureqlConnectionId', String(info.connection_id));
      setIfChanged('secureqlTargetDbms', info.dbms);
      setIfChanged('sqlDialect', info.dbms as DbDialect);
      setIfChanged('allowCsvExport', info.allow_csv_export);
      setIfChanged('secureqlQueryApprovalEnabled', info.query_approval?.enabled ?? false);

      if (JSON.stringify(profile.secureqlQueryApprovalRequiredCommandTags ?? []) !== JSON.stringify(requiredTags)) {
        profile.secureqlQueryApprovalRequiredCommandTags = requiredTags;
        changed = true;
      }

      if (changed) {
        await saveConnectionProfile(profile);
      }
      return info;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      Logger.debug(`SecureQL approval policy refresh skipped for connection ${profile.id}: ${message}`);
      return undefined;
    }
  };

  const getCurrentApprovalSql = (poller: QueryApprovalPoller): string => {
    const doc = vscode.workspace.textDocuments.find((document) => document.uri.toString() === poller.docUri.toString());
    if (!doc) {
      return poller.userSql;
    }
    return poller.selection ? doc.getText(poller.selection) : doc.getText();
  };

  const clearApprovalTimer = (poller: QueryApprovalPoller) => {
    if (poller.timer) {
      clearTimeout(poller.timer);
      poller.timer = undefined;
    }
  };

  const removeApprovalPoller = (docUri: vscode.Uri) => {
    const key = docUri.toString();
    const existing = approvalPollersByDocUri.get(key);
    if (existing) {
      clearApprovalTimer(existing);
      approvalPollersByDocUri.delete(key);
    }
  };

  const getSchemaNameForHistory = (profile: ConnectionProfile, sql: string): string => {
    if (profile.database) {
      return profile.database;
    }
    const identifier = String.raw`(?:"([^"]+)"|` + "`([^`]+)`" + String.raw`|\[([^\]]+)\]|([a-zA-Z_][a-zA-Z0-9_$]*))`;
    const schemaMatch = sql.match(
      new RegExp(String.raw`\b(?:FROM|JOIN|INTO|UPDATE|TABLE|VIEW|INDEX|SEQUENCE|TRUNCATE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?${identifier}\s*\.`, 'i'),
    );
    const matchedSchema = schemaMatch?.slice(1).find((part) => part !== undefined);
    if (matchedSchema) {
      return matchedSchema;
    }
    return context.workspaceState.get<string>("runql.activeSchemaName") || 'main';
  };

  const addQueryHistoryEntry = (
    profile: ConnectionProfile,
    sql: string,
    status: 'success' | 'error',
    rows?: number,
    duration?: number,
  ) => {
    const { HistoryService } = require('./services/historyService');
    HistoryService.getInstance().addEntry({
      query: sql,
      connectionName: profile.name,
      schemaName: getSchemaNameForHistory(profile, sql),
      connectionId: profile.id,
      status,
      rows,
      duration,
    });
  };

  const runSqlWithoutApproval = async (
    docUri: vscode.Uri,
    profile: ConnectionProfile,
    secrets: ConnectionSecrets,
    sql: string,
    bypassLimit = false,
    schemaContext = getSchemaContextForDocUri(docUri),
  ) => {
    const adapter = getAdapter(profile.dialect);
    const config = vscode.workspace.getConfiguration('runql');
    const maxRowsLimit = bypassLimit ? 0 : config.get<number>('query.maxRowsLimit', 10000);
    const { splitStatements } = require('./core/sqlSplitter');
    const statements = splitStatements(sql);

    removeApprovalPoller(docUri);
    resultsViewProvider.show(docUri);

    if (statements.length > 1) {
      const { executeScript } = require('./core/scriptRunner');
      const scriptResult: ScriptExecutionResult = await executeScript(statements, adapter, profile, secrets, {
        maxRows: maxRowsLimit,
        bypassLimit,
        schemaContext,
      });

      lastRunContextByDocUri.set(docUri.toString(), {
        refreshSql: sql,
        userSql: sql,
      });
      resultsViewProvider.postMessage(docUri, 'setAllowCsvExport', profile.allowCsvExport ?? true);
      resultsViewProvider.postMessage(docUri, 'updateScriptResults', scriptResult);
      await queryIndex.updateLastRun(docUri);
      addQueryHistoryEntry(
        profile,
        sql,
        scriptResult.failedAtIndex ? 'error' : 'success',
        scriptResult.lastTabularResult?.rows?.length,
        scriptResult.statements.reduce((sum, statement) => sum + (statement.elapsedMs || 0), 0),
      );

      const anyDDL = scriptResult.statements.some(
        (statement) => statement.status === 'success' && checkForDDL(statement.sql),
      );
      if (anyDDL) {
        vscode.commands.executeCommand("runql.view.refreshSchemas");
      }
      if (scriptResult.failedAtIndex) {
        const failedStmt = scriptResult.statements.find((statement) => statement.status === 'error');
        vscode.window.showErrorMessage(
          `Statement ${scriptResult.failedAtIndex} failed: ${failedStmt?.errorMessage || 'Unknown error'}`,
        );
      }
      return;
    }

    const { applyRowLimit } = require('./core/sqlLimitHelper');
    const limitResult = applyRowLimit(sql, maxRowsLimit);
    lastRunContextByDocUri.set(docUri.toString(), {
      refreshSql: limitResult.sql,
      userSql: sql,
    });

    const results = await adapter.runQuery(profile, secrets, limitResult.sql, {
      maxRows: limitResult.effectiveLimit,
      schemaContext,
    });
    results.meta = await buildResultMeta(profile, docUri, sql, results.columns);
    resultsViewProvider.postMessage(docUri, 'setAllowCsvExport', profile.allowCsvExport ?? true);
    resultsViewProvider.postMessage(docUri, 'updateResults', results);
    await queryIndex.updateLastRun(docUri);
    addQueryHistoryEntry(profile, sql, 'success', results.rows?.length, results.elapsedMs);

    if (limitResult.clamped) {
      vscode.window.showInformationMessage(
        `Query LIMIT was capped to ${maxRowsLimit} rows. Use "Run (no LIMIT)" to bypass.`,
      );
    }
    if (checkForDDL(sql)) {
      vscode.commands.executeCommand("runql.view.refreshSchemas");
    }
  };

  const getApprovalPollDelay = (poller: QueryApprovalPoller): number | null => {
    const elapsed = Date.now() - poller.startedAt;
    if (elapsed >= 30 * 60 * 1000) {
      return null;
    }
    return elapsed < 2 * 60 * 1000 ? 5000 : 15000;
  };

  const scheduleApprovalPoll = (poller: QueryApprovalPoller, delay?: number) => {
    clearApprovalTimer(poller);
    if (poller.stopped) {
      return;
    }
    const pollDelay = delay ?? getApprovalPollDelay(poller);
    if (pollDelay === null) {
      poller.stopped = true;
      postApprovalState(poller.docUri, {
        requestId: poller.requestId,
        status: 'polling_stopped',
        message: 'Automatic checking stopped after 30 minutes. The approval request remains active in SecureQL.',
        canStop: false,
        canCheckStatus: true,
        canResume: true,
      });
      return;
    }
    poller.timer = setTimeout(() => {
      pollApprovalRequest(poller, { automatic: true }).catch((error) => {
        handleApprovalPollFailure(poller, error, true);
      });
    }, pollDelay);
  };

  const pollApprovalRequest = async (
    poller: QueryApprovalPoller,
    options: { automatic: boolean },
  ) => {
    clearApprovalTimer(poller);
    const response = await getQueryApprovalRequest(poller.opts, poller.requestId);
    poller.consecutiveFailures = 0;

    if (response.status === 'Executed') {
      removeApprovalPoller(poller.docUri);
      postApprovalState(poller.docUri, buildApprovalViewState(response, {
        message: response.message || 'Approved query has already been run.',
        canStop: false,
        canCheckStatus: false,
        canResume: false,
      }));
      if (options.automatic) {
        vscode.window.showInformationMessage('Approved query has already been run.');
      }
      return;
    }

    if (response.status === 'Approved') {
      clearApprovalTimer(poller);
      poller.stopped = true;
      postApprovalState(poller.docUri, buildApprovalViewState(response, {
        message: response.message || 'This query was approved. Run it within 30 minutes.',
        canStop: false,
        canCheckStatus: false,
        canResume: false,
        canRunApprovedQuery: true,
      }));
      if (options.automatic) {
        vscode.window.showInformationMessage('Query approved. Run it from the Results panel.');
      }
      return;
    }

    if (response.status === 'Expired') {
      clearApprovalTimer(poller);
      poller.stopped = true;
      postApprovalState(poller.docUri, buildApprovalViewState(response, {
        status: 'expired',
        message: 'This approval expired. Request approval again for this query.',
        canStop: false,
        canCheckStatus: false,
        canResume: false,
        canRequestApproval: true,
      }));
      return;
    }

    if (response.status === 'Execution Failed') {
      removeApprovalPoller(poller.docUri);
      postApprovalState(poller.docUri, buildApprovalViewState(response, {
        canStop: false,
        canCheckStatus: false,
        canResume: false,
      }));
      addQueryHistoryEntry(poller.profile, poller.userSql, 'error', undefined, response.runtime_ms);
      vscode.window.showErrorMessage(`Approved query failed during execution: ${response.execution_error_message || response.message || 'Unknown error'}`);
      return;
    }

    if (response.status === 'Denied' || response.status === 'Cancelled') {
      removeApprovalPoller(poller.docUri);
      postApprovalState(poller.docUri, buildApprovalViewState(response, {
        canStop: false,
        canCheckStatus: false,
        canResume: false,
      }));
      vscode.window.showWarningMessage(response.status === 'Denied' ? 'Query approval denied.' : 'Query approval cancelled.');
      return;
    }

    if (response.status !== 'Pending' && response.status !== 'Executing') {
      poller.stopped = true;
      postApprovalState(poller.docUri, buildApprovalViewState(response, {
        status: 'polling_failed',
        message: `Unsupported approval status: ${response.status}`,
        canStop: false,
        canCheckStatus: true,
        canResume: false,
      }));
      return;
    }

    const nextDelay = options.automatic ? getApprovalPollDelay(poller) : null;
    postApprovalState(poller.docUri, buildApprovalViewState(response, {
      canStop: options.automatic,
      canCheckStatus: !options.automatic,
      canResume: !options.automatic,
      nextCheckAt: nextDelay === null ? undefined : new Date(Date.now() + nextDelay).toISOString(),
      manualCheckAvailableAt: options.automatic ? undefined : new Date(Date.now() + 5000).toISOString(),
    }));
    if (options.automatic) {
      scheduleApprovalPoll(poller, nextDelay ?? undefined);
    }
  };

  const handleApprovalPollFailure = (
    poller: QueryApprovalPoller,
    error: unknown,
    automatic: boolean,
  ) => {
    poller.consecutiveFailures += 1;
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = (error as { statusCode?: number } | undefined)?.statusCode;
    const shouldStop = statusCode === 401
      || statusCode === 403
      || statusCode === 404
      || poller.consecutiveFailures >= 6
      || !automatic;

    if (shouldStop) {
      poller.stopped = true;
      postApprovalState(poller.docUri, {
        requestId: poller.requestId,
        status: 'polling_failed',
        message: statusCode === 401 || statusCode === 403
          ? `Could not continue checking approval status: ${message}`
          : 'Could not continue checking approval status. The approval request remains active in SecureQL.',
        canStop: false,
        canCheckStatus: true,
        canResume: statusCode !== 401 && statusCode !== 403 && statusCode !== 404,
      });
      return;
    }

    if (poller.consecutiveFailures >= 3) {
      const nextDelay = getApprovalPollDelay(poller);
      postApprovalState(poller.docUri, {
        requestId: poller.requestId,
        status: 'polling_failed',
        message: `Still checking approval status, but the last ${poller.consecutiveFailures} checks failed: ${message}`,
        canStop: true,
        canCheckStatus: false,
        canResume: false,
        nextCheckAt: nextDelay === null ? undefined : new Date(Date.now() + nextDelay).toISOString(),
      });
    }
    scheduleApprovalPoll(poller);
  };

  const startApprovalPolling = (
    docUri: vscode.Uri,
    profile: ConnectionProfile,
    secrets: ConnectionSecrets,
    userSql: string,
    error: SecureQLApprovalRequiredError,
    schemaContext?: QuerySchemaContext,
  ) => {
    if (!profile.secureqlBaseUrl || !profile.secureqlConnectionId || !secrets.apiKey) {
      vscode.window.showErrorMessage('Submitted for approval, but RunQL could not start status checking because SecureQL connection metadata is incomplete.');
      return;
    }

    removeApprovalPoller(docUri);

    const poller: QueryApprovalPoller = {
      docUri,
      opts: {
        baseUrl: profile.secureqlBaseUrl,
        apiKey: secrets.apiKey,
        connectionId: profile.secureqlConnectionId,
      },
      profile,
      secrets,
      userSql,
      schemaContext,
      requestId: String(error.approval.request_id),
      startedAt: Date.now(),
      consecutiveFailures: 0,
      stopped: false,
    };
    approvalPollersByDocUri.set(docUri.toString(), poller);

    vscode.window.showInformationMessage('Submitted for approval: This query requires approval before execution and approval has been requested.');
    postApprovalState(docUri, {
      requestId: String(error.approval.request_id),
      status: 'approval_required',
      message: 'This query requires approval before execution. Approval has been requested.',
      submittedAt: error.approval.submitted_at,
      connectionName: error.approval.connection_name ?? profile.name,
      primaryCommandTag: error.approval.primary_command_tag,
      canStop: true,
      canCheckStatus: false,
      canResume: false,
    });

    pollApprovalRequest(poller, { automatic: true }).catch((pollError) => {
      handleApprovalPollFailure(poller, pollError, true);
    });
  };

  const showApprovalRequiredForSql = (
    docUri: vscode.Uri,
    profile: ConnectionProfile,
    secrets: ConnectionSecrets,
    userSql: string,
    schemaContext?: QuerySchemaContext,
    selection?: vscode.Range,
  ) => {
    if (!profile.secureqlBaseUrl || !profile.secureqlConnectionId || !secrets.apiKey) {
      vscode.window.showErrorMessage('This query requires approval, but SecureQL connection metadata is incomplete.');
      return;
    }
    removeApprovalPoller(docUri);
    const poller: QueryApprovalPoller = {
      docUri,
      opts: {
        baseUrl: profile.secureqlBaseUrl,
        apiKey: secrets.apiKey,
        connectionId: profile.secureqlConnectionId,
      },
      profile,
      secrets,
      userSql,
      schemaContext,
      selection,
      requestId: '',
      startedAt: Date.now(),
      consecutiveFailures: 0,
      stopped: true,
    };
    approvalPollersByDocUri.set(docUri.toString(), poller);
    postApprovalState(docUri, {
      status: 'approval_required',
      message: 'This query must be approved before it can run.',
      connectionName: profile.name,
      primaryCommandTag: approvalCommandTagForSql(userSql),
      canStop: false,
      canCheckStatus: false,
      canResume: false,
      canRequestApproval: true,
    });
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('runql.queryApproval.requestApproval', async (docUri: vscode.Uri) => {
      const poller = approvalPollersByDocUri.get(docUri.toString());
      if (!poller) {
        return;
      }
      try {
        const response = await createQueryApprovalRequest(
          poller.opts,
          getCurrentApprovalSql(poller),
          poller.schemaContext,
        );
        poller.requestId = String(response.request_id);
        poller.startedAt = Date.now();
        poller.stopped = false;
        poller.consecutiveFailures = 0;
        postApprovalState(docUri, buildApprovalViewState(response, {
          message: response.message || 'This query has been submitted for approval. Keep this tab open to continue automatically when it is approved.',
          canStop: true,
          canCheckStatus: false,
          canResume: false,
        }));
        vscode.window.showInformationMessage('Submitted for approval.');
        await pollApprovalRequest(poller, { automatic: true }).catch((error) => {
          handleApprovalPollFailure(poller, error, true);
        });
      } catch (error) {
        if (isServerNoApprovalRequiredError(error)) {
          const sql = getCurrentApprovalSql(poller);
          try {
            await runSqlWithoutApproval(docUri, poller.profile, poller.secrets, sql, false, poller.schemaContext);
            vscode.window.showInformationMessage('SecureQL did not require approval, so the query was run.');
          } catch (runError) {
            const message = runError instanceof Error ? runError.message : String(runError);
            vscode.window.showErrorMessage(`Query failed: ${message}`);
          }
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        postApprovalState(docUri, {
          requestId: poller.requestId || undefined,
          status: 'polling_failed',
          message,
          connectionName: poller.profile.name,
          canStop: false,
          canCheckStatus: false,
          canResume: false,
          canRequestApproval: true,
        });
      }
    }),
    vscode.commands.registerCommand('runql.queryApproval.runApproved', async (docUri: vscode.Uri) => {
      const poller = approvalPollersByDocUri.get(docUri.toString());
      if (!poller?.requestId) {
        return;
      }
      try {
        const adapter = getAdapter(poller.profile.dialect);
        const sql = getCurrentApprovalSql(poller);
        const results = await adapter.runQuery(poller.profile, poller.secrets, sql, {
          maxRows: 0,
          approvalRequestId: poller.requestId,
          schemaContext: poller.schemaContext,
        });
        results.meta = await buildResultMeta(poller.profile, poller.docUri, sql, results.columns);
        removeApprovalPoller(poller.docUri);
        resultsViewProvider.show(poller.docUri);
        resultsViewProvider.postMessage(poller.docUri, 'setAllowCsvExport', poller.profile.allowCsvExport ?? true);
        resultsViewProvider.postMessage(poller.docUri, 'updateResults', results);
        await queryIndex.updateLastRun(poller.docUri);
        addQueryHistoryEntry(poller.profile, sql, 'success', results.rows?.length, results.elapsedMs);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        postApprovalState(docUri, {
          requestId: poller.requestId,
          status: 'approval_required',
          message,
          connectionName: poller.profile.name,
          canStop: false,
          canCheckStatus: false,
          canResume: false,
          canRequestApproval: true,
        });
        vscode.window.showErrorMessage(message);
      }
    }),
    vscode.commands.registerCommand('runql.queryApproval.stopChecking', async (docUri: vscode.Uri) => {
      const poller = approvalPollersByDocUri.get(docUri.toString());
      if (!poller) {
        return;
      }
      clearApprovalTimer(poller);
      poller.stopped = true;
      postApprovalState(docUri, {
        requestId: poller.requestId,
        status: 'polling_stopped',
        message: 'Auto-checking is paused. Check now or resume auto-checking when you are ready.',
        canStop: false,
        canCheckStatus: true,
        canResume: true,
      });
      vscode.window.showInformationMessage('Polling stopped. The approval request remains active in SecureQL.');
    }),
    vscode.commands.registerCommand('runql.queryApproval.checkStatus', async (docUri: vscode.Uri) => {
      const poller = approvalPollersByDocUri.get(docUri.toString());
      if (!poller) {
        return;
      }
      clearApprovalTimer(poller);
      await pollApprovalRequest(poller, { automatic: false }).catch((error) => {
        handleApprovalPollFailure(poller, error, false);
      });
    }),
    vscode.commands.registerCommand('runql.queryApproval.resumeChecking', async (docUri: vscode.Uri) => {
      const poller = approvalPollersByDocUri.get(docUri.toString());
      if (!poller) {
        return;
      }
      poller.stopped = false;
      poller.consecutiveFailures = 0;
      poller.startedAt = Date.now();
      postApprovalState(docUri, {
        requestId: poller.requestId,
        status: 'pending',
        message: 'Auto-checking is on. You can run the query from here when it is approved.',
        canStop: true,
        canCheckStatus: false,
        canResume: false,
      });
      await pollApprovalRequest(poller, { automatic: true }).catch((error) => {
        handleApprovalPollFailure(poller, error, true);
      });
    })
  );

  const resolveEditableSourceFromQuery = async (
    profile: ConnectionProfile,
    sql: string
  ): Promise<{ source: QueryResultSource; primaryKeyColumns: string[]; editableColumns: string[]; columns?: ColumnModel[] } | null> => {
    const parsed = parseSimpleSelectSource(sql);
    if (!parsed) {
      return null;
    }

    const { loadSchemas } = require('./schema/schemaStore');
    const allSchemas = await loadSchemas();
    const intro = allSchemas.find((s: SchemaIntrospection) => s.connectionId === profile.id);
    if (!intro) {
      return null;
    }

    const schemaMatches = (schemaName: string, target: string | undefined): boolean => {
      if (!target) return true;
      const left = schemaName.toLowerCase();
      const right = target.toLowerCase();
      return left === right || left.endsWith(`.${right}`);
    };

    const tableMatches = (tableName: string, target: string): boolean =>
      tableName.toLowerCase() === target.toLowerCase();

    const candidates: Array<{ schemaName: string; table: TableModel }> = [];
    for (const schema of intro.schemas || []) {
      if (!schemaMatches(schema.name, parsed.schema)) continue;
      for (const table of schema.tables || []) {
        if (tableMatches(table.name, parsed.table)) {
          candidates.push({ schemaName: schema.name, table });
        }
      }
      for (const view of (schema.views || [])) {
        if (tableMatches(view.name, parsed.table)) {
          candidates.push({ schemaName: schema.name, table: view });
        }
      }
    }

    if (candidates.length !== 1) {
      return null;
    }

    const match = candidates[0];
    const primaryKeyColumns: string[] = Array.isArray(match.table.primaryKey) ? match.table.primaryKey : [];
    if (primaryKeyColumns.length === 0) {
      return null;
    }

    const editableColumns: string[] = Array.isArray(match.table.columns)
      ? match.table.columns.map((c: ColumnModel) => c.name)
      : [];

    return {
      source: {
        catalog: parsed.catalog,
        schema: parsed.schema || match.schemaName,
        table: match.table.name
      },
      primaryKeyColumns,
      editableColumns,
      columns: match.table.columns
    };
  };

  const applyColumnMetadataToResultColumns = (
    resultColumns: QueryColumn[],
    sourceColumns?: ColumnModel[]
  ): void => {
    if (!Array.isArray(sourceColumns) || sourceColumns.length === 0) return;

    const sourceByExactName = new Map<string, ColumnModel>();
    const sourceByLowerName = new Map<string, ColumnModel[]>();
    for (const col of sourceColumns) {
      if (typeof col.name === 'string') {
        sourceByExactName.set(col.name, col);
        const lowerName = col.name.toLowerCase();
        const matches = sourceByLowerName.get(lowerName) || [];
        matches.push(col);
        sourceByLowerName.set(lowerName, matches);
      }
    }

    for (const resultCol of resultColumns) {
      const sourceCol = sourceByExactName.get(resultCol.name)
        || (() => {
          const matches = sourceByLowerName.get(resultCol.name.toLowerCase()) || [];
          return matches.length === 1 ? matches[0] : undefined;
        })();
      if (!sourceCol) continue;

      if (resultCol.type === undefined && sourceCol.type !== undefined) {
        resultCol.type = sourceCol.type;
      }
      if (resultCol.normalizedType === undefined && sourceCol.normalizedType !== undefined) {
        resultCol.normalizedType = sourceCol.normalizedType;
      }
      if (sourceCol.nullable !== undefined) {
        resultCol.nullable = sourceCol.nullable;
      }
      if (sourceCol.defaultValue !== undefined) {
        resultCol.defaultValue = sourceCol.defaultValue;
      }
      if (sourceCol.defaultExpression !== undefined) {
        resultCol.defaultExpression = sourceCol.defaultExpression;
      }
    }
  };

  const mapEditableMetadataToResultColumns = (
    columns: QueryColumn[],
    primaryKeyColumns: string[],
    editableColumns: string[]
  ): { ok: true; primaryKeyColumns: string[]; editableColumns: string[] } | { ok: false; reason: string } => {
    const resultColumns = columns.map((c) => c.name);
    const findResultColumn = (target: string): string | undefined =>
      resultColumns.find((col) => col.toLowerCase() === target.toLowerCase());

    const mappedPrimaryKeys: string[] = [];
    for (const pk of primaryKeyColumns) {
      const resolved = findResultColumn(pk);
      if (!resolved) {
        return { ok: false, reason: `Primary key column missing from result: ${pk}` };
      }
      mappedPrimaryKeys.push(resolved);
    }

    const pkSet = new Set(mappedPrimaryKeys.map((pk) => pk.toLowerCase()));
    const mappedEditable = editableColumns
      .map((name) => findResultColumn(name))
      .filter((name): name is string => !!name)
      .filter((name) => !pkSet.has(name.toLowerCase()));

    return {
      ok: true,
      primaryKeyColumns: mappedPrimaryKeys,
      editableColumns: Array.from(new Set(mappedEditable))
    };
  };

  const normalizeConnectionTag = (value: unknown): string => {
    if (typeof value !== 'string') return '';
    return value.trim().toLowerCase();
  };

  const getActiveSqlConnectionProfile = async (): Promise<ConnectionProfile | undefined> => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isSqlDoc(editor.document)) return undefined;

    const docConnectionId = codeLensStore.get(editor.document);
    const effectiveId = getEffectiveConnectionId(docConnectionId);
    if (!effectiveId) return undefined;

    const profiles = await loadConnectionProfiles();
    return profiles.find((p) => p.id === effectiveId);
  };

  const refreshProductionWarningBar = async (): Promise<void> => {
    if (!(await isProjectInitialized())) {
      productionWarningItem.hide();
      return;
    }

    const profile = await getActiveSqlConnectionProfile();
    const taggedProfile = profile as (ConnectionProfile & { tag?: string }) | undefined;
    const tag = normalizeConnectionTag(taggedProfile?.connectionTag ?? taggedProfile?.tag);

    if (!profile || tag !== 'production') {
      productionWarningItem.hide();
      return;
    }

    productionWarningItem.text = `$(warning) PRODUCTION: ${profile.name}`;
    productionWarningItem.tooltip = `RunQL warning: "${profile.name}" is tagged as production.`;
    productionWarningItem.show();
  };

  const getConnectionLabel = (id?: string) => {
    // If we passed an ID, look it up. 
    // BUT the provider logic usually passes the stored ID. 
    // If the stored ID is undefined, we need to resolve what the "effective" ID would be to show the label.
    // However, the provider calls this with the *result* of store.get(doc).
    // So if id is undefined, it means "no doc override".

    // We actually need to refactor the provider slightly or handle it here.
    // The provider currently calls store.get(doc), then passes that to us.
    // If that is undefined, we should check active -> first.

    const effectiveId = getEffectiveConnectionId(id);

    if (!effectiveId) return "Select Connection";

    // Return cached name or "Loading..." if not yet cached (avoid showing raw ID)
    const cachedName = connectionNameCache.get(effectiveId);
    if (cachedName) return cachedName;

    // If not in cache, return a placeholder - the cache will update and trigger refresh
    return "Loading...";
  };

  const getSchemaContextLabel = (document: vscode.TextDocument, connectionId?: string) => {
    const effectiveId = getEffectiveConnectionId(connectionId);
    if (!effectiveId) {
      return undefined;
    }
    const schemaContext = codeLensStore.getSchemaContext(document);
    return schemaContext?.defaultCatalog
      ? `${schemaContext.defaultCatalog}.${schemaContext.defaultSchema}`
      : (schemaContext?.defaultSchema ?? 'None');
  };

  const codeLensProvider = new DPSqlCodelensProvider(
    codeLensStore,
    getConnectionLabel,
    getSchemaContextLabel,
  );

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ language: "sql" }, codeLensProvider)
  );

  // SQL Formatting Provider
  const formattingProvider = new SqlFormattingProvider(codeLensStore, context);
  context.subscriptions.push(
    vscode.commands.registerCommand('runql.sql.formatDocument', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        await formattingProvider.formatDocument(editor);
      }
    })
  );

  // Initial cache load (only if project is initialized to avoid default connection creation)
  if (await isProjectInitialized()) {
    updateConnectionCache();
  }


  registerSqlCodelensCommands(
    context,
    codeLensStore,
    () => codeLensProvider.refresh(),
    () => { void refreshProductionWarningBar(); }
  );
  // Toggle System Schemas Command
  context.subscriptions.push(
    vscode.commands.registerCommand("runql.schema.toggleSystemSchemas", async () => {
      const key = 'runql.ui.showSystemSchemas';
      const current = context.workspaceState.get<boolean>(key, false);
      await context.workspaceState.update(key, !current);

      explorerProvider.refresh();
    })
  );

  // Explorer View
  const explorerTreeView = vscode.window.createTreeView("runql.explorerView", {
    treeDataProvider: explorerProvider
  });
  const explorerTreeViewBuiltin = vscode.window.createTreeView("runql.explorerViewBuiltin", {
    treeDataProvider: explorerProvider
  });
  // Attach selection tracking
  attachConnectionsSelectionTracking(explorerTreeView);
  attachConnectionsSelectionTracking(explorerTreeViewBuiltin);

  context.subscriptions.push(
    explorerTreeView,
    explorerTreeViewBuiltin,
    vscode.window.registerTreeDataProvider("runql.savedQueriesView", savedQueriesProvider)
  );

  // Register Query Search sidebar view
  registerQuerySearchView(context, queryIndex);

  // Register Menus
  registerActionsMenus(context);

  // Register Connection Commands
  registerConnectionCommands(context, explorerProvider);

  // Register Schema Diff Commands
  registerSchemaDiffCommands(context, explorerProvider);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('runql-diff', new SchemaDiffContentProvider())
  );

  // -----------------------------
  // Default contexts (NEW)
  // -----------------------------
  await setHasActiveConnection(false);
  await setHasActiveSchema(false);

  // -----------------------------
  // View header refresh commands (NEW)
  // -----------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand("runql.view.refreshConnections", async () => {
      explorerProvider.refresh();
      // Avoid creating RunQL files before explicit initialization
      if (await isProjectInitialized()) {
        updateConnectionCache(); // Also refresh our internal name cache
      }
    }),
    vscode.commands.registerCommand("runql.openSettings", async () => {
      await vscode.commands.executeCommand("workbench.action.openSettings", "runql");
    }),
    vscode.commands.registerCommand("runql.welcome.open", () => {
      WelcomeView.render(context.extensionUri);
    }),
    vscode.commands.registerCommand("runql.whatsNew.open", () => {
      WelcomeView.render(context.extensionUri, { mode: 'whatsNew', version: extensionVersion });
    }),
    vscode.commands.registerCommand("runql.project.initialize", async () => {
      try {
        if ((vscode.workspace.workspaceFolders?.length ?? 0) === 0) {
          vscode.window.showWarningMessage('Open a folder before initializing RunQL.');
          return;
        }

        const { ensureDPDirs, ensureAgentsMd } = require('./core/fsWorkspace');

        // Create folder structure
        await ensureDPDirs();
        await ensureAgentsMd();

        // Initialize all systems
        await initializeProjectComponents(context);

        await updateProjectInitializedContext();
        explorerProvider.refresh();

        vscode.window.showInformationMessage('RunQL project initialized successfully!');
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`Initialization failed: ${msg}`);
      }
    }),
    vscode.commands.registerCommand("runql.view.refreshSchemas", async (skipIntrospection?: boolean) => {
      const { loadConnectionProfiles } = require('./connections/connectionStore');
      const { performIntrospection } = require('./connections/connectionCommands');

      if (skipIntrospection !== true) {
        // Introspect ALL user connections (not just the active one)
        const profiles = await loadConnectionProfiles();
        for (const profile of profiles) {
          await performIntrospection(profile, true); // silent
        }
      }

      explorerProvider.refresh(); // Refreshes everything (connections + schemas)
    }),
    vscode.commands.registerCommand("runql.view.refreshSavedQueries", () => savedQueriesProvider.refresh()),
    vscode.commands.registerCommand("runql.query.deleteSaved", async (item: vscode.TreeItem | vscode.Uri) => {
      const { deleteSavedQuery } = require('./queryLibrary/deleteSavedQuery');
      await deleteSavedQuery(item);
    })
  );

  const maybeAutoOpenWelcome = async () => {
    try {
      if (autoWelcomeShownThisSession) return;
      if (autoWhatsNewShownThisSession) return;
      if (await isProjectInitialized()) return;

      await vscode.commands.executeCommand("workbench.view.extension.runql");
      await vscode.commands.executeCommand("runql.welcome.open");
      autoWelcomeShownThisSession = true;
    } catch (err) {
      Logger.error("Failed to auto-open welcome page", err);
    }
  };

  const maybeAutoOpenWhatsNew = async () => {
    try {
      if (autoWhatsNewShownThisSession) return;
      if (!previousExtensionVersion || !extensionVersion || previousExtensionVersion === extensionVersion) return;

      await vscode.commands.executeCommand("workbench.view.extension.runql");
      await vscode.commands.executeCommand("runql.whatsNew.open");
      autoWhatsNewShownThisSession = true;
    } catch (err) {
      Logger.error("Failed to auto-open What's New page", err);
    }
  };

  const focusRunQLActivityBar = async () => {
    try {
      await vscode.commands.executeCommand("workbench.view.extension.runql");
    } catch (err) {
      Logger.error("Failed to focus RunQL activity bar", err);
    }
  };

  await focusRunQLActivityBar();
  await maybeAutoOpenWhatsNew();

  // Auto-open sidebar + Welcome when project is not initialized.
  // Covers both activation-time workspaces and folders added after activation.
  if (!projectInitializedAtStartup) {
    await maybeAutoOpenWelcome();
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void updateProjectInitializedContext();
      void maybeAutoOpenWelcome();
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('runql.ai')) return;

      void (async () => {
        const { syncAiSettingsAcrossScopes, isAiSettingsSyncInProgress } = await import('./ai/aiService');
        if (isAiSettingsSyncInProgress()) return;
        await syncAiSettingsAcrossScopes();
      })();
    })
  );

  if (extensionVersion && previousExtensionVersion !== extensionVersion) {
    await context.globalState.update("runql.lastExtensionVersion", extensionVersion);
  }

  // Insert text helper used by schema tree clicks
  context.subscriptions.push(
    vscode.commands.registerCommand("runql.editor.insertText", async (text: string) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      await editor.edit((eb) => eb.insert(editor.selection.active, text));
    }),
    vscode.commands.registerCommand("runql.editor.insertRoutineCall", async (item?: ExplorerItem) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const routine = item?.routine;
      const schemaName = typeof item?.schemaName === 'string' ? item.schemaName : undefined;
      const routineName = typeof routine?.name === 'string' ? routine.name : undefined;
      const identifier = typeof routine?.schemaQualifiedName === 'string'
        ? routine.schemaQualifiedName
        : (schemaName && routineName ? `${schemaName}.${routineName}` : (routineName || 'routine_name'));

      const params: RoutineParameterModel[] = Array.isArray(routine?.parameters)
        ? routine.parameters
          .filter((p: RoutineParameterModel) => p?.mode !== 'return')
          .sort((a: RoutineParameterModel, b: RoutineParameterModel) => (a?.position ?? 0) - (b?.position ?? 0))
        : [];
      const args = params
        .map((p: RoutineParameterModel, index: number) => {
          const name = typeof p?.name === 'string' && p.name.length > 0 ? p.name : `arg${index + 1}`;
          const type = typeof p?.type === 'string' && p.type.length > 0 ? `: ${p.type}` : '';
          return `/* ${name}${type} */`;
        })
        .join(', ');

      const sql = routine?.kind === 'procedure'
        ? `CALL ${identifier}(${args});`
        : `SELECT ${identifier}(${args});`;

      await editor.edit((eb) => eb.insert(editor.selection.active, sql));
    })
  );

  // Active connection selection (UPDATED: persist + set context)
  context.subscriptions.push(
    vscode.commands.registerCommand("runql.connection.select", async (itemOrProfile) => {
      let profile = itemOrProfile;
      // Handle call from Tree View context (ConnectionItem)
      if (itemOrProfile && itemOrProfile.profile) {
        profile = itemOrProfile.profile;
      }

      if (!profile?.id) return;
      await context.workspaceState.update("runql.activeConnectionId", profile.id);
      await setHasActiveConnection(true);

      explorerProvider.setActiveId(profile.id); // Update view

      void vscode.window.setStatusBarMessage(`RunQL: selected connection "${profile.name}"`, 2500);

      // Persist to queryIndex for active editor
      const editor = vscode.window.activeTextEditor;
      if (editor && isSqlDoc(editor.document)) {
        await codeLensStore.clearSchemaContext(editor.document);
        await queryIndex.updateConnectionContext(editor.document.uri, profile.id, profile.name, resolveEffectiveSqlDialect(profile));
      }

      void refreshProductionWarningBar();
    })
  );

  // ERD Command
  context.subscriptions.push(
    vscode.commands.registerCommand("runql.erd.open", async () => {
      const connId = context.workspaceState.get<string>("runql.activeConnectionId");
      if (!connId) {
        vscode.window.showErrorMessage("No active connection selected.");
        return;
      }

      const { getConnection, getConnectionSecrets } = require('./connections/connectionStore');
      const profile = await getConnection(connId);
      const secrets = await getConnectionSecrets(connId);

      if (profile) {
        await erdViewProvider.showERD(profile, secrets);
      }
    })
  );

  // Initial load of active connection
  const initialConnId = context.workspaceState.get<string>("runql.activeConnectionId");
  if (initialConnId) {
    explorerProvider.setActiveId(initialConnId);
    await setHasActiveConnection(true);
  }
  void refreshProductionWarningBar();

  // RUN QUERY COMMAND
  context.subscriptions.push(
    vscode.commands.registerCommand("runql.query.createSqlFile", async () => {
      const { createSqlFile } = require('./queryLibrary/createSqlFile');
      await createSqlFile(context);
    }),
    vscode.commands.registerCommand("runql.query.saveSqlFile", async (uri?: vscode.Uri) => {
      const sourceEditor = vscode.window.activeTextEditor;
      const doc = uri
        ? await vscode.workspace.openTextDocument(uri)
        : sourceEditor?.document;

      if (!doc || !isSqlDoc(doc)) {
        vscode.window.showWarningMessage("RunQL: Open a SQL editor before saving a query.");
        return;
      }

      if (!doc.getText().trim()) {
        vscode.window.showWarningMessage("RunQL: There is no SQL to save.");
        return;
      }

      const docConnectionId = codeLensStore.get(doc);
      const connectionId = getEffectiveConnectionId(docConnectionId);
      const schemaContext = codeLensStore.getSchemaContext(doc);
      const sourceUri = doc.uri;
      const sourceViewColumn = sourceEditor?.document.uri.toString() === sourceUri.toString()
        ? sourceEditor.viewColumn
        : undefined;
      const { saveSqlFile } = require('./queryLibrary/createSqlFile');
      const savedUri: vscode.Uri | undefined = await saveSqlFile(context, doc, connectionId, schemaContext);

      if (!savedUri) {
        return;
      }

      if (
        sourceUri.toString() !== savedUri.toString()
        && vscode.window.activeTextEditor?.document.uri.toString() === sourceUri.toString()
      ) {
        try {
          await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        } catch (err) {
          Logger.warn('Failed to close source editor after saving query', err);
        }
      }

      const savedDoc = await vscode.workspace.openTextDocument(savedUri);
      await vscode.window.showTextDocument(savedDoc, {
        viewColumn: sourceViewColumn,
        preview: false,
      });

      if (connectionId) {
        await codeLensStore.set(savedDoc, connectionId);
      }
      if (schemaContext?.defaultSchema) {
        await codeLensStore.setSchemaContext(savedDoc, schemaContext);
      } else {
        await codeLensStore.clearSchemaContext(savedDoc);
      }

      codeLensProvider.refresh();
      savedQueriesProvider.refresh();
      vscode.window.showInformationMessage(`RunQL: Saved query "${savedUri.fsPath.split(/[\\/]/).pop() ?? 'query.sql'}".`);
    }),
    vscode.commands.registerCommand("runql.query.renameBundle", async (uri?: vscode.Uri) => {
      const { renameQueryBundle } = require('./queryLibrary/renameQueryBundle');
      await renameQueryBundle(context, uri);
    }),
    vscode.commands.registerCommand("runql.query.openSaved", async (uri: vscode.Uri, connectionId?: string) => {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
      if (connectionId) {
        // Set connection context
        await vscode.commands.executeCommand('runql.sql.setConnectionForDoc', doc.uri, connectionId);
      }
    }),
    vscode.commands.registerCommand("runql.query.openTablePreview", async (item?: ExplorerItem) => {
      await openTablePreviewAndRun(item);
    }),
    vscode.commands.registerCommand("runql.query.run", async () => {
      await runQuery(false);
    }),
    vscode.commands.registerCommand("runql.query.runNoLimit", async () => {
      await runQuery(true);
    }),
    vscode.commands.registerCommand("runql.query.runCurrentStatement", async () => {
      await runCurrentStatement();
    }),
    vscode.commands.registerCommand("runql.results.applyEdits", async (docUri: vscode.Uri, payload?: ApplyResultsetEditsCommandPayload) => {
      if (!docUri || !payload) {
        return;
      }

      const confirmed = payload.confirmed === true;
      const request: ApplyResultsetEditsRequest = {
        resultId: payload.resultId,
        source: payload.source,
        edits: payload.edits
      };

      const failure = (message: string): ApplyResultsetEditsResult => ({
        ok: false,
        summary: { applied: 0, conflicted: 0, failed: 1 },
        rowResults: [{ rowKey: {}, status: 'error', message }]
      });

      try {
        const lastResult = resultsViewProvider.getLastResult(docUri);
        if (!lastResult?.meta) {
          resultsViewProvider.postMessage(docUri, 'applyResultsetEditsResult', failure('No editable resultset is active.'));
          return;
        }

        if (lastResult.meta.resultId !== request.resultId) {
          resultsViewProvider.postMessage(docUri, 'applyResultsetEditsResult', failure('Resultset is stale. Re-run query and retry.'));
          return;
        }

        if (!lastResult.meta.editable.enabled || !lastResult.meta.source) {
          resultsViewProvider.postMessage(docUri, 'applyResultsetEditsResult', failure(lastResult.meta.editable.reason || 'Resultset is read-only.'));
          return;
        }

        let doc: vscode.TextDocument;
        try {
          doc = await vscode.workspace.openTextDocument(docUri);
        } catch {
          resultsViewProvider.postMessage(docUri, 'applyResultsetEditsResult', failure('Could not open source SQL document.'));
          return;
        }

        const docConnectionId = codeLensStore.get(doc);
        const activeConnId = getEffectiveConnectionId(docConnectionId);
        if (!activeConnId) {
          resultsViewProvider.postMessage(docUri, 'applyResultsetEditsResult', failure('No active connection found for this resultset.'));
          return;
        }

        const profiles: ConnectionProfile[] = await loadConnectionProfiles();
        const profile = profiles.find((p) => p.id === activeConnId);
        if (!profile) {
          resultsViewProvider.postMessage(docUri, 'applyResultsetEditsResult', failure('Connection profile was not found.'));
          return;
        }

        const adapter = getAdapter(profile.dialect);
        const dialect = resolveEffectiveSqlDialect(profile);
        const pkColumns = lastResult.meta.editable.primaryKeyColumns;
        const editableColumns = new Set(lastResult.meta.editable.editableColumns);
        const source = lastResult.meta.source;

        const rowResults: ApplyResultsetEditsResult['rowResults'] = [];
        let applied = 0;
        let conflicted = 0;
        let failed = 0;
        let attempted = 0;
        const stagedStatements: Array<{ rowEdit: ResultsetRowEdit; sql: string }> = [];

        for (const edit of request.edits || []) {
          const normalized = normalizeRowEdit(edit, editableColumns);
          if (!normalized) {
            continue;
          }
          attempted += 1;

          const missingPk = pkColumns.filter((pk) => !(pk in normalized.rowKey));
          if (missingPk.length > 0) {
            failed += 1;
            rowResults.push({
              rowKey: normalized.rowKey,
              status: 'error',
              message: `Missing primary key values: ${missingPk.join(', ')}`
            });
            continue;
          }

          const sql = buildUpdateStatement({
            dialect,
            source,
            rowEdit: normalized,
            primaryKeyColumns: pkColumns
          });

          stagedStatements.push({ rowEdit: normalized, sql });
        }

        if (attempted === 0) {
          resultsViewProvider.postMessage(docUri, 'applyResultsetEditsResult', failure('No editable changes were detected to save.'));
          return;
        }

        if (!confirmed && stagedStatements.length > 0) {
          resultsViewProvider.postMessage(docUri, 'applyResultsetEditsPreview', {
            request,
            connectionName: profile.name,
            targetLabel: formatSourceLabel(source),
            statements: stagedStatements.map((statement) => statement.sql)
          });
          return;
        }

        const { ensureConnectionSecrets } = require('./connections/connectionCommands');
        const secrets = await ensureConnectionSecrets(profile);
        if (!secrets) {
          resultsViewProvider.postMessage(docUri, 'applyResultsetEditsResult', failure('Credentials were not provided.'));
          return;
        }

        for (const statement of stagedStatements) {
          try {
            const execResult = await executeNonQueryCompat(adapter, profile, secrets, statement.sql);
            if (execResult.affectedRows === 0) {
              conflicted += 1;
              rowResults.push({ rowKey: statement.rowEdit.rowKey, status: 'conflict', message: 'Row changed since it was loaded.' });
              continue;
            }
            applied += 1;
            rowResults.push({ rowKey: statement.rowEdit.rowKey, status: 'applied' });
          } catch (e: unknown) {
            failed += 1;
            rowResults.push({
              rowKey: statement.rowEdit.rowKey,
              status: 'error',
              message: e instanceof Error ? e.message : 'Failed to apply row update.'
            });
          }
        }

        const response: ApplyResultsetEditsResult = {
          ok: conflicted === 0 && failed === 0,
          summary: { applied, conflicted, failed },
          rowResults
        };
        resultsViewProvider.postMessage(docUri, 'applyResultsetEditsResult', response);

        if (applied > 0) {
          try {
            const runCtx = lastRunContextByDocUri.get(docUri.toString());
            const previewCtx = tablePreviewContextByDocUri.get(docUri.toString());
            const refreshSql = runCtx?.refreshSql || previewCtx?.sql;
            const userSql = runCtx?.userSql || refreshSql;
            if (refreshSql && userSql) {
              const refreshed = await adapter.runQuery(profile, secrets, refreshSql, { maxRows: 0 });
              refreshed.meta = await buildResultMeta(profile, docUri, userSql, refreshed.columns);
              resultsViewProvider.postMessage(docUri, 'updateResults', refreshed);
            }
          } catch (e: unknown) {
            const message = e instanceof Error ? e.message : 'unknown error';
            vscode.window.showWarningMessage(`Edits applied, but result refresh failed: ${message}`);
          }
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Unexpected error while applying edits.';
        resultsViewProvider.postMessage(
          docUri,
          'applyResultsetEditsResult',
          failure(message)
        );
      }
    })
  );

  // Helper function for query execution
  async function runQuery(bypassLimit: boolean) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    // 1. Get SQL
    const selection = editor.selection;
    const text = selection.isEmpty ? editor.document.getText() : editor.document.getText(selection);
    if (!text.trim()) {
      vscode.window.showWarningMessage("No SQL to run.");
      return;
    }

    // 2. Get Connection for this Doc (CodeLens override)
    const docConnectionId = codeLensStore.get(editor.document);

    // Use the same effective ID logic as the label
    const activeConnId = getEffectiveConnectionId(docConnectionId);

    if (!activeConnId) {
      const choice = await vscode.window.showErrorMessage("No connections available. Add one first.", "Add DB Connection");
      if (choice === "Add DB Connection") {
        vscode.commands.executeCommand("runql.connection.add");
      }
      return;
    }

    // Load profile
    const { loadConnectionProfiles } = require('./connections/connectionStore');
    const profiles: ConnectionProfile[] = await loadConnectionProfiles();
    const profile = profiles.find((p: ConnectionProfile) => p.id === activeConnId);

    if (!profile) {
      vscode.window.showErrorMessage("Connection not found (maybe deleted?). Select another.");
      return;
    }

    // 3. Show Results Panel (loading state?)
    const docUri = editor.document.uri;
    resultsViewProvider.show(docUri);
    removeApprovalPoller(docUri);

    // 4. Run Query (with interaction feedback)
    const { splitStatements } = require('./core/sqlSplitter');
    const statements = splitStatements(text);
    const isScriptMode = statements.length > 1;

    vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: isScriptMode
        ? `Running script (${statements.length} statements) on ${profile.name}...`
        : `Running query on ${profile.name}...`,
      cancellable: true
    }, async (_progress, _token) => {
      let secrets: ConnectionSecrets | undefined;
      let schemaContext: QuerySchemaContext | undefined;
      try {
        const { ensureConnectionSecrets } = require('./connections/connectionCommands');
        secrets = await ensureConnectionSecrets(profile);
        if (!secrets) return; // User cancelled

        const secureqlKeyInfo = await refreshSecureQLApprovalPolicyForRun(profile, secrets);
        schemaContext = codeLensStore.getSchemaContext(editor.document);

        const adapter = getAdapter(profile.dialect);
        const config = vscode.workspace.getConfiguration('runql');
        const maxRowsLimit = bypassLimit ? 0 : config.get<number>('query.maxRowsLimit', 10000);

        if (secureQLApprovalRequiredForSql(profile, text)) {
          showApprovalRequiredForSql(
            docUri,
            profile,
            secrets,
            text,
            schemaContext,
            selection.isEmpty ? undefined : new vscode.Range(selection.start, selection.end),
          );
          return;
        }

        if (isScriptMode) {
          // ── Script mode: execute statements sequentially ──
          const { executeScript } = require('./core/scriptRunner');
          const scriptResult: ScriptExecutionResult = await executeScript(statements, adapter, profile, secrets, {
            maxRows: maxRowsLimit,
            bypassLimit,
            secureqlKeyInfo,
            schemaContext,
          });

          lastRunContextByDocUri.set(docUri.toString(), {
            refreshSql: text,
            userSql: text
          });

          // Update panel with script results
          resultsViewProvider.show(docUri);
          resultsViewProvider.postMessage(docUri, 'setAllowCsvExport', profile.allowCsvExport ?? true);
          resultsViewProvider.postMessage(docUri, 'updateScriptResults', scriptResult);

          // Notification for failures
          if (scriptResult.failedAtIndex) {
            const failedStmt = scriptResult.statements.find(s => s.status === 'error');
            vscode.window.showErrorMessage(
              `Statement ${scriptResult.failedAtIndex} failed: ${failedStmt?.errorMessage || 'Unknown error'}`
            );
          }

          // Update Last Run
          await queryIndex.updateLastRun(docUri);

          addQueryHistoryEntry(
            profile,
            text,
            scriptResult.failedAtIndex ? 'error' : 'success',
            scriptResult.lastTabularResult?.rows?.length,
            scriptResult.statements.reduce((sum, s) => sum + (s.elapsedMs || 0), 0),
          );

          // DDL Auto-Refresh — check all executed statements
          const anyDDL = scriptResult.statements.some(
            s => s.status === 'success' && checkForDDL(s.sql)
          );
          if (anyDDL) {
            vscode.commands.executeCommand("runql.view.refreshSchemas");
          }
        } else {
          // ── Single statement mode (unchanged) ──
          const { applyRowLimit } = require('./core/sqlLimitHelper');
          const limitResult = applyRowLimit(text, maxRowsLimit);
          lastRunContextByDocUri.set(docUri.toString(), {
            refreshSql: limitResult.sql,
            userSql: text
          });

          const results = await adapter.runQuery(profile, secrets, limitResult.sql, {
            maxRows: limitResult.effectiveLimit,
            secureqlKeyInfo,
            schemaContext,
          });
          results.meta = await buildResultMeta(profile, docUri, text, results.columns);

          // Show notice if user's limit was clamped
          if (limitResult.clamped) {
            vscode.window.showInformationMessage(
              `Query LIMIT was capped to ${maxRowsLimit} rows. Use "Run (no LIMIT)" to bypass.`
            );
          }

          // Update panel
          resultsViewProvider.show(docUri);
          resultsViewProvider.postMessage(docUri, 'setAllowCsvExport', profile.allowCsvExport ?? true);
          resultsViewProvider.postMessage(docUri, 'updateResults', results);

          // Update Last Run
          await queryIndex.updateLastRun(docUri);

          // MEMORY RECALL: Save to history
          addQueryHistoryEntry(profile, text, 'success', results.rows?.length, results.elapsedMs);

          // DDL Auto-Refresh
          if (checkForDDL(text)) {
            vscode.commands.executeCommand("runql.view.refreshSchemas");
          }
        }
      } catch (e: unknown) {
        if (isApprovalRequiredError(e) && secrets) {
          startApprovalPolling(docUri, profile, secrets, text, e, schemaContext);
          return;
        }
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`Query failed: ${msg}`);
      }
    });
  }

  // Run Current Statement — executes only the statement under the cursor
  async function runCurrentStatement() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const fullText = editor.document.getText();
    if (!fullText.trim()) {
      vscode.window.showWarningMessage("No SQL to run.");
      return;
    }

    const { findStatementAtOffset } = require('./core/sqlSplitter');
    const cursorOffset = editor.document.offsetAt(editor.selection.active);
    const stmt = findStatementAtOffset(fullText, cursorOffset);

    if (!stmt) {
      vscode.window.showWarningMessage("No statement found at cursor position.");
      return;
    }

    // Select the found statement in the editor for visual feedback
    const startPos = editor.document.positionAt(stmt.startOffset);
    const endPos = editor.document.positionAt(stmt.endOffset);
    editor.selection = new vscode.Selection(startPos, endPos);

    // Execute as single statement via runQuery — the selection will be picked up
    await runQuery(false);
  }

  async function openTablePreviewAndRun(item?: ExplorerItem) {
    if (!item) {
      vscode.window.showWarningMessage("No table/view item selected.");
      return;
    }

    const tableName: string | undefined = item.table?.name;
    const schemaName: string | undefined = item.schemaName;

    if (!tableName) {
      vscode.window.showWarningMessage("Could not determine the selected table/view.");
      return;
    }

    let connectionId: string | undefined = item.connectionId || item.introspection?.connectionId;

    if (!connectionId) {
      connectionId = context.workspaceState.get<string>("runql.activeConnectionId");
    }

    if (!connectionId) {
      vscode.window.showErrorMessage("No connection found for this table/view.");
      return;
    }

    const { getConnection } = require('./connections/connectionStore');
    const profile = await getConnection(connectionId);

    if (!profile) {
      vscode.window.showErrorMessage(`Connection not found for selected item (${connectionId}).`);
      return;
    }

    const effectiveDialect = resolveEffectiveSqlDialect(profile) || item.introspection?.dialect || 'duckdb';
    const tableFqn = buildTableFqnForPreview(schemaName, tableName, effectiveDialect);
    const sql = `SELECT * FROM ${tableFqn} LIMIT 100;`;

    const doc = await vscode.workspace.openTextDocument({ content: sql, language: 'sql' });
    const primaryKeyColumns: string[] = Array.isArray(item.table?.primaryKey) ? item.table.primaryKey : [];
    const editableColumns: string[] = Array.isArray(item.table?.columns)
      ? item.table.columns.map((c: ColumnModel) => c.name).filter((name): name is string => typeof name === 'string')
      : [];
    tablePreviewContextByDocUri.set(doc.uri.toString(), {
      sql,
      source: {
        schema: schemaName,
        table: tableName
      },
      primaryKeyColumns,
      editableColumns,
      columns: item.table?.columns
    });

    // Pre-set the connection in the CodeLens store BEFORE showing the document.
    // This prevents onDidChangeActiveTextEditor from overwriting it with the
    // global active connection before setConnectionForDoc has a chance to run.
    await codeLensStore.set(doc, connectionId);
    await vscode.window.showTextDocument(doc, { preview: false });
    await vscode.commands.executeCommand('runql.sql.setConnectionForDoc', doc.uri, connectionId);
    await vscode.commands.executeCommand('runql.query.runNoLimit');
  }

  const resolveCreateTableTarget = async (item?: ExplorerItem): Promise<CreateTablePanelContext | null> => {
    const schemaName = typeof item?.schemaName === 'string'
      ? item.schemaName
      : (typeof item?.schemaModel?.name === 'string' ? item.schemaModel.name : undefined);
    if (!schemaName) {
      vscode.window.showErrorMessage('Select a schema node in Explorer to create a table.');
      return null;
    }

    let connectionId = typeof item?.connectionId === 'string' ? item.connectionId : undefined;
    if (!connectionId && typeof item?.introspection?.connectionId === 'string') {
      connectionId = item.introspection.connectionId;
    }
    if (!connectionId) {
      connectionId = context.workspaceState.get<string>('runql.activeConnectionId');
    }
    if (!connectionId) {
      vscode.window.showErrorMessage('Could not resolve connection for selected schema.');
      return null;
    }

    const { getConnection } = require('./connections/connectionStore');
    const profile = await getConnection(connectionId) as ConnectionProfile | undefined;
    if (!profile) {
      vscode.window.showErrorMessage(`Connection not found (${connectionId}).`);
      return null;
    }

    const dialect = resolveEffectiveSqlDialect(profile) || profile.dialect || 'duckdb';
    return {
      connectionId: profile.id,
      connectionName: profile.name,
      schemaName,
      dialect,
      isLocalDuckDB: false
    };
  };

  const previewCreateTable = (target: CreateTablePanelContext, draft: CreateTableDraft) => {
    const buildResult = buildCreateTableSql({
      dialect: target.dialect as DbDialect,
      schemaName: target.schemaName,
      draft
    });
    return {
      connectionName: target.connectionName,
      targetLabel: buildResult.targetLabel,
      statements: buildResult.statements
    };
  };

  const executeCreateTable = async (
    target: CreateTablePanelContext,
    draft: CreateTableDraft
  ): Promise<CreateTableResultPayload> => {
    const { getConnection } = require('./connections/connectionStore');
    const profile = await getConnection(target.connectionId) as ConnectionProfile | undefined;
    if (!profile) {
      return { ok: false, message: `Connection not found (${target.connectionId}).` };
    }

    const effectiveDialect = (resolveEffectiveSqlDialect(profile) || target.dialect) as DbDialect;
    const sqlBatch = buildCreateTableSql({
      dialect: effectiveDialect,
      schemaName: target.schemaName,
      draft
    });

    const { ensureConnectionSecrets, performIntrospection } = require('./connections/connectionCommands');
    const secrets = await ensureConnectionSecrets(profile) as ConnectionSecrets | undefined;
    if (!secrets) {
      return { ok: false, message: 'Credentials were not provided.' };
    }

    const adapter = getAdapter(profile.dialect);
    for (const statement of sqlBatch.statements) {
      await executeNonQueryCompat(adapter, profile, secrets, statement);
    }

    await performIntrospection(profile, true);
    explorerProvider.refresh();

    return {
      ok: true,
      message: `Created ${sqlBatch.targetLabel} using ${sqlBatch.statements.length} statement${sqlBatch.statements.length === 1 ? '' : 's'}.`
    };
  };

  const resolveEditTableTarget = async (item?: ExplorerItem): Promise<CreateTablePanelContext | null> => {
    const tableName = typeof item?.table?.name === 'string'
      ? item.table.name
      : undefined;
    const schemaName = typeof item?.schemaName === 'string' ? item.schemaName : undefined;

    if (!tableName || !schemaName) {
      vscode.window.showErrorMessage('Select a table node in Explorer to edit.');
      return null;
    }

    let connectionId = typeof item?.connectionId === 'string' ? item.connectionId : undefined;
    if (!connectionId && typeof item?.introspection?.connectionId === 'string') {
      connectionId = item.introspection.connectionId;
    }
    if (!connectionId) {
      connectionId = context.workspaceState.get<string>('runql.activeConnectionId');
    }
    if (!connectionId) {
      vscode.window.showErrorMessage('Could not resolve connection for selected table.');
      return null;
    }

    const { getConnection } = require('./connections/connectionStore');
    const profile = await getConnection(connectionId) as ConnectionProfile | undefined;
    if (!profile) {
      vscode.window.showErrorMessage(`Connection not found (${connectionId}).`);
      return null;
    }

    // Get table model from introspection (available on ExplorerItem)
    const tableModel = item?.table;
    if (!tableModel || !tableModel.columns) {
      vscode.window.showErrorMessage('Table metadata not available. Try refreshing the explorer.');
      return null;
    }

    const dialect = resolveEffectiveSqlDialect(profile) || profile.dialect || 'duckdb';
    return {
      connectionId: profile.id,
      connectionName: profile.name,
      schemaName,
      dialect,
      isLocalDuckDB: false,
      editMode: {
        tableName: tableModel.name,
        columns: (tableModel.columns || []).map((c: ColumnModel) => ({
          name: c.name,
          type: c.type,
          nullable: c.nullable,
          comment: c.comment
        })),
        primaryKey: tableModel.primaryKey,
        foreignKeys: tableModel.foreignKeys,
        indexes: tableModel.indexes
      }
    };
  };

  const previewAlterTable = (target: CreateTablePanelContext, original: CreateTableDraft, current: CreateTableDraft) => {
    const buildResult = buildAlterTableSql({
      dialect: target.dialect as DbDialect,
      schemaName: target.schemaName,
      tableName: target.editMode!.tableName,
      original,
      current
    });
    return {
      connectionName: target.connectionName,
      targetLabel: buildResult.targetLabel,
      statements: buildResult.statements
    };
  };

  const executeAlterTable = async (
    target: CreateTablePanelContext,
    original: CreateTableDraft,
    current: CreateTableDraft
  ): Promise<CreateTableResultPayload> => {
    const { getConnection } = require('./connections/connectionStore');
    const profile = await getConnection(target.connectionId) as ConnectionProfile | undefined;
    if (!profile) {
      return { ok: false, message: `Connection not found (${target.connectionId}).` };
    }

    const effectiveDialect = (resolveEffectiveSqlDialect(profile) || target.dialect) as DbDialect;
    const sqlBatch = buildAlterTableSql({
      dialect: effectiveDialect,
      schemaName: target.schemaName,
      tableName: target.editMode!.tableName,
      original,
      current
    });

    const { ensureConnectionSecrets, performIntrospection } = require('./connections/connectionCommands');
    const secrets = await ensureConnectionSecrets(profile) as ConnectionSecrets | undefined;
    if (!secrets) {
      return { ok: false, message: 'Credentials were not provided.' };
    }

    const adapter = getAdapter(profile.dialect);
    for (const statement of sqlBatch.statements) {
      await executeNonQueryCompat(adapter, profile, secrets, statement);
    }

    await performIntrospection(profile, true);
    explorerProvider.refresh();

    return {
      ok: true,
      message: `Altered ${sqlBatch.targetLabel} using ${sqlBatch.statements.length} statement${sqlBatch.statements.length === 1 ? '' : 's'}.`
    };
  };

  const dropTable = async (target: CreateTablePanelContext): Promise<CreateTableResultPayload> => {
    const { getConnection } = require('./connections/connectionStore');
    const profile = await getConnection(target.connectionId) as ConnectionProfile | undefined;
    if (!profile) {
      return { ok: false, message: `Connection not found (${target.connectionId}).` };
    }

    const effectiveDialect = (resolveEffectiveSqlDialect(profile) || target.dialect) as DbDialect;
    const sqlBatch = buildDropTableSql({
      dialect: effectiveDialect,
      schemaName: target.schemaName,
      tableName: target.editMode!.tableName
    });

    const { ensureConnectionSecrets, performIntrospection } = require('./connections/connectionCommands');
    const secrets = await ensureConnectionSecrets(profile) as ConnectionSecrets | undefined;
    if (!secrets) {
      return { ok: false, message: 'Credentials were not provided.' };
    }

    const adapter = getAdapter(profile.dialect);
    for (const statement of sqlBatch.statements) {
      await executeNonQueryCompat(adapter, profile, secrets, statement);
    }

    await performIntrospection(profile, true);
    explorerProvider.refresh();

    return {
      ok: true,
      message: `Dropped ${sqlBatch.targetLabel}.`
    };
  };

  // Active schema selection (NEW)
  context.subscriptions.push(
    vscode.commands.registerCommand("runql.schema.createTable", async (item?: ExplorerItem) => {
      const target = await resolveCreateTableTarget(item);
      if (!target) {
        return;
      }

      CreateTableView.render(context.extensionUri, target, {
        onPreview: async (draft) => previewCreateTable(target, draft),
        onExecute: async (draft) => executeCreateTable(target, draft)
      });
    }),
    vscode.commands.registerCommand("runql.schema.editTable", async (item?: ExplorerItem) => {
      const target = await resolveEditTableTarget(item);
      if (!target) {
        return;
      }

      CreateTableView.render(context.extensionUri, target, {
        onPreview: async (draft) => previewCreateTable(target, draft),
        onExecute: async (draft) => executeCreateTable(target, draft),
        onPreviewAlter: async (original, current) => previewAlterTable(target, original, current),
        onExecuteAlter: async (original, current) => executeAlterTable(target, original, current),
        onDropTable: async () => dropTable(target)
      });
    }),
    vscode.commands.registerCommand("runql.schema.select", async (schemaName: string) => {
      await context.workspaceState.update("runql.activeSchemaName", schemaName);
      await setHasActiveSchema(!!schemaName);
      void vscode.window.setStatusBarMessage(`RunQL: selected schema "${schemaName}"`, 2500);
      explorerProvider.refresh();
    })
  );

  // Watchers to refresh the views when JSON files change
  const watchers = registerDPWatchers(
    () => {
      explorerProvider.refresh();
      updateConnectionCache();
    },
    () => explorerProvider.refresh(),
    () => savedQueriesProvider.refresh()
  );
  context.subscriptions.push(watchers);

  // Bundle Rename Watcher

  context.subscriptions.push(
    vscode.workspace.onDidDeleteFiles(async (e) => {
      const { handleDeletions } = require('./queryLibrary/deleteBundleWatcher');
      await handleDeletions(e.files);
    })
  );

  // -----------------------------
  // Query Logic
  // -----------------------------



  // Show Similar Query Command
  context.subscriptions.push(
    vscode.commands.registerCommand("runql.query.findSimilarSavedQueries", async (hash?: string) => {
      const { queryIndex } = require('./queryLibrary/queryIndex');
      // If hash is not provided (e.g. invoked from palette), get it from active editor
      if (!hash) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const { canonicalizeSql } = require('./core/hashing');
        hash = canonicalizeSql(editor.document.getText()).sqlHash;
      }

      const matches: QueryIndexEntry[] = queryIndex.getMatches(hash);
      if (matches.length === 0) return;

      const items = matches.map((m: QueryIndexEntry) => {
        const root = vscode.workspace.workspaceFolders?.[0].uri;
        if (!root) return undefined;
        const uri = vscode.Uri.joinPath(root, m.path);

        return {
          label: m.path,
          description: m.title || uri.fsPath,
          uri: uri
        };
      }).filter((item): item is { label: string; description: string; uri: vscode.Uri } => item !== undefined);

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: `Select a similar query (${matches.length} found)`
      });

      if (picked) {
        const doc = await vscode.workspace.openTextDocument(picked.uri);
        await vscode.window.showTextDocument(doc);
      }
    })
  );

  // -----------------------------
  // Query index (existing)
  // -----------------------------
  // queryIndex.initialize() is already called above

  // Helper to update similar queries context
  const updateSimilarQueriesContext = async (editor: vscode.TextEditor | undefined) => {
    if (!editor) {
      await setHasSimilarQueries(false);
      return;
    }
    if (!isSqlDoc(editor.document)) {
      await setHasSimilarQueries(false);
      return;
    }

    const { sqlHash } = canonicalizeSql(editor.document.getText());
    const matches = queryIndex.getMatches(sqlHash);
    const currentPath = vscode.workspace.asRelativePath(editor.document.uri, false);
    const others = matches.filter((m: QueryIndexEntry) => m.path !== currentPath);
    await setHasSimilarQueries(others.length > 0);
  };

  // -----------------------------
  // Comment overlays (existing)
  // -----------------------------

  // Re-render overlays when active editor changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      await refreshProductionWarningBar();

      // Update similar queries context
      await updateSimilarQueriesContext(editor);

      if (!editor || !isSqlDoc(editor.document)) {
        resultsViewProvider.showNoEditor();
        markdownViewProvider.showNoEditor();
        return;
      }

      // Auto-restore connection for the document
      const entry = queryIndex.getEntry(editor.document.uri);
      if (entry && entry.connectionId) {
        // Document has a previously stored connection - verify it still exists
        const { getConnection } = require('./connections/connectionStore');
        const exists = await getConnection(entry.connectionId);
        if (exists) {
          // Connection still exists - restore it to the CodeLens store (no change to queryIndex)
          await codeLensStore.set(editor.document, entry.connectionId);
          if (
            entry.schemaContext
            && await savedSchemaContextIsAvailable(entry.connectionId, entry.schemaContext, entry.catalogContext)
          ) {
            await codeLensStore.setSchemaContext(editor.document, {
              ...(entry.catalogContext ? { defaultCatalog: entry.catalogContext } : {}),
              defaultSchema: entry.schemaContext,
            });
          } else {
            await codeLensStore.clearSchemaContext(editor.document);
          }
          codeLensProvider.refresh();
        } else {
          // Stored connection no longer exists - fallback to active connection
          const active = context.workspaceState.get<string>("runql.activeConnectionId");
          if (active) await vscode.commands.executeCommand('runql.sql.setConnectionForDoc', editor.document.uri, active);
        }
      } else {
        // New/untracked file - only set connection if not already tracked in CodeLens store
        const currentDocConnection = codeLensStore.get(editor.document);
        if (!currentDocConnection) {
          const active = context.workspaceState.get<string>("runql.activeConnectionId");
          if (active) await vscode.commands.executeCommand('runql.sql.setConnectionForDoc', editor.document.uri, active);
        }
      }

      // Switch Results View to this doc just in case the panel is visible,
      // so we don't show stale results from potential previous run of another file.
      // (Assuming provider implementation of show(uri) handles updating existing view)
      resultsViewProvider.show(editor.document.uri);
      markdownViewProvider.show(editor.document.uri);
    })
  );

  // Re-render overlays when a SQL doc changes (light debounce recommended)
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(async (evt) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      if (evt.document.uri.toString() !== editor.document.uri.toString()) return;
      if (!isSqlDoc(evt.document)) return;

      await updateSimilarQueriesContext(editor);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      tablePreviewContextByDocUri.delete(doc.uri.toString());
      lastRunContextByDocUri.delete(doc.uri.toString());
    })
  );

  // Command: add inline comments (overlay). v0 uses heuristic comments; replace with AI later.
  context.subscriptions.push(
    vscode.commands.registerCommand("runql.query.addInlineComments", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !isSqlDoc(editor.document)) return;

      const { generateAndStreamInlineComments } = require('./ai/inlineComments');
      try {
        await generateAndStreamInlineComments(context, editor);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`Inline comments failed: ${msg}`);
      }
    })
  );

  // Initial render if editor already open
  if (vscode.window.activeTextEditor?.document && isSqlDoc(vscode.window.activeTextEditor.document)) {
    await updateSimilarQueriesContext(vscode.window.activeTextEditor);
  }

  // Initial refresh of tree views
  explorerProvider.refresh();
  savedQueriesProvider.refresh();

  // Completion Provider
  const completionProvider = new DPCompletionProvider((doc) => {
    const docId = codeLensStore.get(doc);
    return getEffectiveConnectionId(docId);
  });
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      [{ language: 'sql' }, { language: 'postgres' }],
      completionProvider,
      '.', ' '
    )
  );

  // AI Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("runql.query.generateMarkdownDoc", async () => {
      const { generateMarkdownDoc } = require('./ai/docGenerator');
      await generateMarkdownDoc(context);
    }),
    vscode.commands.registerCommand("runql.query.openMarkdownDoc", async () => {
      const { openMarkdownDoc } = require('./ai/docGenerator');
      await openMarkdownDoc(context);
    }),
    vscode.commands.registerCommand("runql.ai.selectModel", async () => {
      const { selectAIModel } = require('./ai/aiService');
      await selectAIModel();
    }),
    vscode.commands.registerCommand("runql.ai.selectInstalledExtension", async () => {
      const { selectInstalledExtensionChoice } = require('./ai/broker');
      await selectInstalledExtensionChoice();
    })
  );

  // Markdown Panel Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("runql.markdown.focus", () => {
      vscode.commands.executeCommand('runql.markdownView.focus');
    }),
    vscode.commands.registerCommand("runql.markdown.save", () => {
      markdownViewProvider.save();
    }),
    vscode.commands.registerCommand("runql.markdown.reload", () => {
      markdownViewProvider.reloadFromDisk();
    })
  );

  // Helper: Rename Watcher for SQL bundles
  context.subscriptions.push(
    vscode.workspace.onDidRenameFiles(async (e) => {
      const { handleRenames } = require('./queryLibrary/renameBundleWatcher');
      await handleRenames(e.files);
    })
  );

  // Commands: Open Schema ERD
  context.subscriptions.push(
    vscode.commands.registerCommand("runql.erd.openSchema", async (item: ExplorerItem) => {
      const { openSchemaErdCommand } = require('./erd/openSchemaCommand');
      await openSchemaErdCommand(context, item);
    }),
    vscode.commands.registerCommand("runql.schema.generateDescriptionsWithAI", async (item: ExplorerItem) => {
      const { generateDescriptionsWithAI } = require('./schema/descriptionGenerator');
      await generateDescriptionsWithAI(context, item);
    })
  );

  // Copy Prompt fallback commands
  context.subscriptions.push(
    vscode.commands.registerCommand("runql.ai.sendCommentToChat", async () => {
      const { sendCommentToChat } = require('./ai/sendToChat');
      await sendCommentToChat(context);
    }),
    vscode.commands.registerCommand("runql.ai.sendDocumentToChat", async () => {
      const { sendDocumentToChat } = require('./ai/sendToChat');
      await sendDocumentToChat(context);
    }),
    vscode.commands.registerCommand("runql.ai.sendSchemaDescriptionsToChat", async (item: ExplorerItem) => {
      const { sendSchemaDescriptionsToChat } = require('./ai/sendToChat');
      await sendSchemaDescriptionsToChat(context, item);
    }),
    vscode.commands.registerCommand("runql.ai.importSchemaDescriptionResponses", async () => {
      const { importSchemaDescriptionResponses } = require('./schema/descriptionImporter');
      await importSchemaDescriptionResponses(context);
    })
  );

  // -----------------------------
  // Memory Recall (History - NEW)
  // -----------------------------
  const { MemoryRecallProvider } = require('./panels/memoryRecallView');
  const { openMemoryRecallQuery } = require('./commands/memoryRecallCommands');



  // Register Provider
  const memoryRecallProvider = new MemoryRecallProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("runql.memoryRecallView", memoryRecallProvider)
  );

  // Register Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("runql.memoryRecall.openQuery", async (entry) => {
      await openMemoryRecallQuery(context, entry);
    }),
    vscode.commands.registerCommand("runql.memoryRecall.refresh", () => {
      memoryRecallProvider.refresh();
    })
  );

  return {
    registerProvider: (descriptor) => ProviderRegistry.getInstance().registerProvider(descriptor),
    registerAdapter: (dialect, factory) => registerAdapter(dialect, factory),
    registerProviderActionHandler: (dialect, handler) => ProviderRegistry.getInstance().registerProviderActionHandler(dialect, handler),
    getProviders: () => ProviderRegistry.getInstance().getProviders(),
    getConnectionProfiles: () => loadConnectionProfiles(),
    saveConnectionProfile: (profile) => saveConnectionProfile(profile),
    getConnectionSecrets: (id) => getConnectionSecrets(id),
  };
}

export function deactivate() {
  // Cleanup if needed
}

function isSqlDoc(doc: vscode.TextDocument): boolean {
  const id = doc.languageId.toLowerCase();
  return id.includes("sql") || id.includes("pgsql") || id.includes("mysql");
}

function checkForDDL(sql: string): boolean {
  return /\b(CREATE|DROP|ALTER|TRUNCATE)\s+/i.test(sql);
}

function buildTableFqnForPreview(schemaName: string | undefined, tableName: string, dialect: DbDialect): string {
  if (!schemaName) {
    return quoteIdentifier(dialect, tableName);
  }

  // Snowflake can represent schema as DATABASE.SCHEMA in introspection.
  if (dialect === 'snowflake' && schemaName.includes('.')) {
    const parts = schemaName.split('.');
    const database = parts.shift() ?? '';
    const schema = parts.join('.');
    if (database && schema) {
      return `${quoteIdentifier(dialect, database)}.${quoteIdentifier(dialect, schema)}.${quoteIdentifier(dialect, tableName)}`;
    }
  }

  return `${quoteIdentifier(dialect, schemaName)}.${quoteIdentifier(dialect, tableName)}`;
}

function createResultId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeSqlForComparison(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

function parseSimpleSelectSource(sql: string): QueryResultSource | null {
  const cleaned = stripSqlComments(sql).trim().replace(/;+\s*$/g, '');
  if (!/^select\b/i.test(cleaned)) {
    return null;
  }

  if (/\bjoin\b/i.test(cleaned)) {
    return null;
  }

  const ident = String.raw`(?:"[^"]+"|` + '`[^`]+`' + String.raw`|\[[^\]]+\]|[a-zA-Z_][\w$]*)`;
  const fromRegex = new RegExp(String.raw`\bfrom\s+(${ident}(?:\s*\.\s*${ident}){0,2})`, 'i');
  const match = cleaned.match(fromRegex);
  if (!match) {
    return null;
  }

  const fromExpr = match[1].trim();
  if (!fromExpr || fromExpr.startsWith('(')) {
    return null;
  }

  const parts = fromExpr
    .split(/\s*\.\s*/)
    .map(unquoteIdentifierPart)
    .filter((part) => part.length > 0);

  if (parts.length === 1) {
    return { table: parts[0] };
  }
  if (parts.length === 2) {
    return { schema: parts[0], table: parts[1] };
  }
  if (parts.length === 3) {
    return { catalog: parts[0], schema: parts[1], table: parts[2] };
  }

  return null;
}

function stripSqlComments(sql: string): string {
  return sql
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

function unquoteIdentifierPart(part: string): string {
  const trimmed = part.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith('`') && trimmed.endsWith('`'))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function formatSourceLabel(source: QueryResultSource): string {
  const parts = [source.catalog, source.schema, source.table].filter((part) => !!part);
  return parts.join('.');
}

function normalizeRowEdit(edit: ResultsetRowEdit, editableColumns: Set<string>): ResultsetRowEdit | null {
  const changes = (edit.changes || [])
    .filter((change) => editableColumns.has(change.column))
    .filter((change) => change.oldValue !== change.newValue);

  if (changes.length === 0) {
    return null;
  }

  return {
    rowKey: edit.rowKey,
    changes
  };
}

async function executeNonQueryCompat(
  adapter: {
    executeNonQuery?: (profile: ConnectionProfile, secrets: ConnectionSecrets, sql: string) => Promise<{ affectedRows: number | null } | undefined>;
    runQuery?: (profile: ConnectionProfile, secrets: ConnectionSecrets, sql: string, options: { maxRows: number }) => Promise<unknown>;
  },
  profile: ConnectionProfile,
  secrets: ConnectionSecrets,
  sql: string
): Promise<{ affectedRows: number | null }> {
  if (typeof adapter?.executeNonQuery === 'function') {
    const result = await adapter.executeNonQuery(profile, secrets, sql);
    const affectedRows = typeof result?.affectedRows === 'number'
      ? Number(result.affectedRows)
      : null;
    return { affectedRows };
  }

  // Backward compatibility: provider adapters that have not implemented executeNonQuery yet.
  if (typeof adapter?.runQuery === 'function') {
    await adapter.runQuery(profile, secrets, sql, { maxRows: 0 });
    return { affectedRows: null };
  }

  throw new Error('Connection adapter does not support updates. Upgrade the provider extension.');
}

function buildUpdateStatement(params: {
  dialect: DbDialect;
  source: QueryResultSource;
  rowEdit: ResultsetRowEdit;
  primaryKeyColumns: string[];
}): string {
  const { dialect, source, rowEdit, primaryKeyColumns } = params;
  const quote = (name: string) => quoteIdentifier(dialect, name);

  const tablePathParts = [source.catalog, source.schema, source.table]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .map((part) => quote(part));
  const tablePath = tablePathParts.join('.');

  const setClause = rowEdit.changes
    .map((change) => `${quote(change.column)} = ${toSqlLiteral(change.newValue, dialect)}`)
    .join(', ');

  const pkPredicate = primaryKeyColumns
    .map((pk) => {
      const value = rowEdit.rowKey[pk];
      if (value === null || value === undefined) {
        return `${quote(pk)} IS NULL`;
      }
      return `${quote(pk)} = ${toSqlLiteral(value, dialect)}`;
    })
    .join(' AND ');

  const optimisticPredicate = rowEdit.changes
    .map((change) => {
      if (change.oldValue === null || change.oldValue === undefined) {
        return `${quote(change.column)} IS NULL`;
      }
      return `${quote(change.column)} = ${toSqlLiteral(change.oldValue, dialect)}`;
    })
    .join(' AND ');

  return `UPDATE ${tablePath} SET ${setClause} WHERE ${pkPredicate} AND ${optimisticPredicate}`;
}


/**
 * Consolidates initialization of RunQL core systems.
 * AGENTS.md creation is intentionally handled only by explicit initialization flows.
 */
async function initializeProjectComponents(context: vscode.ExtensionContext) {
  try {
    const { queryIndex } = require('./queryLibrary/queryIndex');
    const { initializePromptFiles } = require('./ai/prompts');
    const { ensureReadmeMd } = require('./core/fsWorkspace');
    const { HistoryService } = require('./services/historyService');
    const { runSchemaBundleMigrationIfNeeded } = require('./schema/storageMigration');
    const { runQueryFolderMigrationIfNeeded } = require('./queryLibrary/queryMigration');

    // 1. Schema storage migration
    await runSchemaBundleMigrationIfNeeded();

    // 2. Query folder migration
    await runQueryFolderMigrationIfNeeded();

    // 3. Query Index
    await queryIndex.initialize();

    // 4. Prompt Files
    await initializePromptFiles();

    // 5. Documentation
    await ensureReadmeMd();
    // 6. History Service
    await HistoryService.getInstance().initialize(context);

  } catch (err) {
    Logger.error("Failed to initialize project components", err);
    throw err; // Re-throw to caller to handle/log
  }
}

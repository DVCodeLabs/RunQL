import * as vscode from 'vscode';
import { Logger } from '../core/logger';
import { formatAIError } from '../core/errorHandler';

const CONFIG_SECTION = 'runql';
const AI_SETTINGS_NORMALIZATION_KEY = 'runql.ai.settingsNormalizedVersion';
const AI_SETTINGS_RESET_TOKEN = '2026-04-ai-reset-v2';
const LEGACY_AI_SETTING_KEYS = [
    'ai.backend',
    'ai.broker',
    'ai.installedExtensionChoice',
    'ai.provider',
    'ai.endpoint'
] as const;
const SYNCED_AI_SETTING_KEYS = [
    'ai.source',
    'ai.extension',
    'ai.apiProvider',
    'ai.model',
    'ai.apiBaseUrl',
    'ai.sendSchemaContext',
    'ai.maxSchemaChars'
] as const;

type ConfigValue = string | number | boolean | undefined;
type SettingSnapshotEntry = { globalValue: ConfigValue; workspaceValue: ConfigValue };
type SettingSnapshot = Record<string, SettingSnapshotEntry>;
let isSyncingAiSettings = false;
let lastAiSettingsSnapshot: SettingSnapshot | null = null;

function getConfigTargets(): vscode.ConfigurationTarget[] {
    return vscode.workspace.workspaceFolders?.length
        ? [vscode.ConfigurationTarget.Global, vscode.ConfigurationTarget.Workspace]
        : [vscode.ConfigurationTarget.Global];
}

async function updateConfigForTargets(key: string, value: ConfigValue, targets = getConfigTargets()): Promise<void> {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    for (const target of targets) {
        await config.update(key, value, target);
    }
}

async function updateConfig(key: string, value: ConfigValue): Promise<void> {
    await updateConfigForTargets(key, value);
}

async function syncAiSettingKey<T extends ConfigValue>(config: vscode.WorkspaceConfiguration, key: string, value: T): Promise<void> {
    const inspection = config.inspect<T>(key);
    const targets = getConfigTargets();

    for (const target of targets) {
        const current =
            target === vscode.ConfigurationTarget.Global ? inspection?.globalValue :
            target === vscode.ConfigurationTarget.Workspace ? inspection?.workspaceValue :
            inspection?.workspaceFolderValue;

        if (current !== value) {
            await config.update(key, value, target);
        }
    }
}

function captureAiSettingsSnapshot(): SettingSnapshot {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const snapshot: SettingSnapshot = {};

    for (const key of [...SYNCED_AI_SETTING_KEYS, ...LEGACY_AI_SETTING_KEYS]) {
        const inspection = config.inspect<ConfigValue>(key);
        snapshot[key] = {
            globalValue: inspection?.globalValue,
            workspaceValue: inspection?.workspaceValue
        };
    }

    return snapshot;
}

function getChangedScopeValue(key: string, fallback: ConfigValue): ConfigValue {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const inspection = config.inspect<ConfigValue>(key);
    const previous = lastAiSettingsSnapshot?.[key];
    const currentGlobal = inspection?.globalValue;
    const currentWorkspace = inspection?.workspaceValue;

    if (!previous) {
        return fallback;
    }

    const globalChanged = currentGlobal !== previous.globalValue;
    const workspaceChanged = currentWorkspace !== previous.workspaceValue;

    if (globalChanged && !workspaceChanged) {
        return currentGlobal;
    }

    if (workspaceChanged && !globalChanged) {
        return currentWorkspace;
    }

    if (globalChanged && workspaceChanged) {
        if (currentWorkspace === currentGlobal) {
            return currentWorkspace;
        }
        return currentWorkspace !== undefined ? currentWorkspace : currentGlobal;
    }

    return fallback;
}

/** OpenAI / Azure OpenAI / OpenAI-compatible chat completion response shape */
interface OpenAIChatResponse {
    choices?: { message?: { content?: string } }[];
}

/** Anthropic Messages API response shape */
interface AnthropicResponse {
    content?: { text?: string }[];
}

/** Ollama generate API response shape */
interface OllamaGenerateResponse {
    response?: string;
}

/** Ollama tags API response shape */
interface OllamaTagsResponse {
    models?: { name: string }[];
}

/** Generic content part used in various LM response formats */
interface ContentPart {
    text?: string;
    value?: string;
}

/** VS Code LM model descriptor (experimental API) */
interface VsCodeLmModel {
    family?: string;
    name?: string;
    id?: string;
    sendRequest: (messages: unknown[], options: Record<string, unknown>, token: vscode.CancellationToken) => Promise<{ text: AsyncIterable<unknown> }>;
}

export interface AIProvider {
    generateCompletion(prompt: string): Promise<string>;
    streamCompletion?(prompt: string, onChunk: (chunk: string) => void): Promise<void>;
}

export class MockAIProvider implements AIProvider {
    async generateCompletion(_prompt: string): Promise<string> {
        await new Promise(resolve => setTimeout(resolve, 500));
        return `# What this query answers

This is a mock response. Configure an AI provider to generate real content.

# Inputs

- Example input

# Business logic

- Example logic

# Output

- Example output

# Caveats

- Example caveat

# Performance notes

- Example performance note
`;
    }
}

type ProviderName = "vscode" | "openai" | "anthropic" | "azureOpenAI" | "ollama" | "openaiCompatible";
type AISourceOption = "automatic" | "githubCopilot" | "aiExtension" | "directApi" | "off";
type DirectApiProviderOption = "openai" | "anthropic" | "azureOpenAI" | "ollama" | "openaiCompatible";

export type AIProviderOption =
    | "none"
    | "extensionManaged"
    | "vscodeChatModel"
    | "openai"
    | "anthropic"
    | "azureOpenAI"
    | "ollama"
    | "openaiCompatible";

interface ProviderConfig {
    provider: ProviderName;
    model: string;
    endpoint?: string;
    apiKey?: string;
    source: "agent" | "settings";
}

const DIRECT_API_PROVIDERS: DirectApiProviderOption[] = ["openai", "anthropic", "azureOpenAI", "ollama", "openaiCompatible"];

type ConfigInspection<T> = ReturnType<vscode.WorkspaceConfiguration['inspect']> & { globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T };

function hasExplicitConfigValue<T>(inspection: ConfigInspection<T> | undefined): boolean {
    return inspection?.globalValue !== undefined
        || inspection?.workspaceValue !== undefined
        || inspection?.workspaceFolderValue !== undefined;
}

function isDirectApiProviderOption(value: string): value is DirectApiProviderOption {
    return DIRECT_API_PROVIDERS.includes(value as DirectApiProviderOption);
}

function getConfiguredSource(config: vscode.WorkspaceConfiguration): AISourceOption {
    const source = config.get<string>('ai.source', 'githubCopilot');
    if (source === "githubCopilot" || source === "aiExtension" || source === "directApi" || source === "off") {
        return source;
    }
    return "githubCopilot";
}

function getConfiguredDirectApiProvider(config: vscode.WorkspaceConfiguration): DirectApiProviderOption | "" {
    const direct = config.get<string>('ai.apiProvider', '');
    if (isDirectApiProviderOption(direct)) return direct;

    const legacyBackend = config.get<string>('ai.backend', '');
    if (isDirectApiProviderOption(legacyBackend)) return legacyBackend;

    const legacyProvider = config.get<string>('ai.provider', '');
    if (isDirectApiProviderOption(legacyProvider)) return legacyProvider;

    return "";
}

function getConfiguredApiBaseUrl(config: vscode.WorkspaceConfiguration): string {
    return config.get<string>('ai.apiBaseUrl', '') || config.get<string>('ai.endpoint', '');
}

function mapBackendToSource(backend: string): AISourceOption | null {
    if (backend === "none") return "off";
    if (backend === "vscodeChatModel") return "githubCopilot";
    if (isDirectApiProviderOption(backend)) return "directApi";
    if (backend === "extensionManaged") return "automatic";
    return null;
}

function mapLegacyProviderToSource(provider: string): AISourceOption | null {
    if (provider === "none") return "off";
    if (provider === "vscode") return "githubCopilot";
    if (isDirectApiProviderOption(provider)) return "directApi";
    return null;
}

/** Maps the deprecated legacy provider setting value to the new AIProviderOption. */
function mapLegacyProvider(provider: string): AIProviderOption {
    if (provider === "vscode") return "vscodeChatModel";
    if (provider === "none") return "none";
    // openai, anthropic, azureOpenAI, ollama, openaiCompatible map 1:1
    if (["openai", "anthropic", "azureOpenAI", "ollama", "openaiCompatible"].includes(provider)) {
        return provider as AIProviderOption;
    }
    return "none";
}

/** Maps an AIProviderOption to the internal ProviderName used by HttpAIProvider / VscodeLmProvider. */
function providerOptionToName(option: AIProviderOption): ProviderName | null {
    switch (option) {
        case "vscodeChatModel": return "vscode";
        case "openai": return "openai";
        case "anthropic": return "anthropic";
        case "azureOpenAI": return "azureOpenAI";
        case "ollama": return "ollama";
        case "openaiCompatible": return "openaiCompatible";
        default: return null; // "none" and "extensionManaged" handled separately
    }
}

/**
 * Detects whether the host IDE is stock VS Code or a bundled/custom IDE (e.g. VSCodium).
 * Used to select appropriate defaults when no explicit AI provider is configured.
 */
function detectHostEnvironment(): "stockVSCode" | "bundledIDE" {
    const appName = (vscode.env.appName || "").toLowerCase();
    if (appName.includes("visual studio code")) {
        return "stockVSCode";
    }
    // VSCodium, custom bundled IDEs, or any non-stock VS Code host
    return "bundledIDE";
}

/**
 * Migrates legacy AI settings to the simplified source/provider model.
 * Safe to call multiple times — existing new settings win.
 */
export async function migrateAiProviderSetting(): Promise<void> {
    const config = vscode.workspace.getConfiguration('runql');
    const sourceInspection = config.inspect<string>('ai.source');
    const apiProviderInspection = config.inspect<string>('ai.apiProvider');
    const extensionInspection = config.inspect<string>('ai.extension');
    const apiBaseUrlInspection = config.inspect<string>('ai.apiBaseUrl');

    const legacyBackend = config.get<string>('ai.backend', '');
    const legacyProvider = config.get<string>('ai.provider', '');
    const legacyBroker = config.get<string>('ai.broker', 'auto');
    const legacyInstalledExtension = config.get<string>('ai.installedExtensionChoice', '');
    const legacyEndpoint = config.get<string>('ai.endpoint', '');

    if (!hasExplicitConfigValue(sourceInspection)) {
        let mappedSource: AISourceOption | null = null;

        if (legacyBroker === 'claudeExtension' || legacyBroker === 'codexExtension' || legacyInstalledExtension) {
            mappedSource = 'aiExtension';
        } else if (legacyBackend) {
            mappedSource = mapBackendToSource(legacyBackend);
        } else if (legacyProvider) {
            mappedSource = mapLegacyProviderToSource(legacyProvider);
        }

        if (mappedSource) {
            await updateConfig('ai.source', mappedSource);
            Logger.info(`Migrated legacy AI selection to runql.ai.source="${mappedSource}"`);
        }
    }

    if (!hasExplicitConfigValue(apiProviderInspection)) {
        const mappedProvider = getConfiguredDirectApiProvider(config);
        if (mappedProvider) {
            await updateConfig('ai.apiProvider', mappedProvider);
            Logger.info(`Migrated legacy AI provider to runql.ai.apiProvider="${mappedProvider}"`);
        }
    }

    if (!hasExplicitConfigValue(extensionInspection)) {
        const mappedExtension = legacyInstalledExtension || (legacyBroker === 'claudeExtension' || legacyBroker === 'codexExtension' ? legacyBroker : '');
        if (mappedExtension) {
            await updateConfig('ai.extension', mappedExtension);
            Logger.info(`Migrated legacy AI extension to runql.ai.extension="${mappedExtension}"`);
        }
    }

    if (!hasExplicitConfigValue(apiBaseUrlInspection) && legacyEndpoint) {
        await updateConfig('ai.apiBaseUrl', legacyEndpoint);
        Logger.info('Migrated runql.ai.endpoint to runql.ai.apiBaseUrl');
    }

}

export async function normalizeAiSettings(context: vscode.ExtensionContext, version: string): Promise<void> {
    const normalizedVersion = context.workspaceState.get<string>(AI_SETTINGS_NORMALIZATION_KEY);
    if (normalizedVersion === `${version}:${AI_SETTINGS_RESET_TOKEN}`) {
        return;
    }

    await updateConfigForTargets('ai.source', 'githubCopilot');
    await updateConfigForTargets('ai.extension', '');
    await updateConfigForTargets('ai.apiProvider', '');
    await updateConfigForTargets('ai.model', 'gpt-4.1');
    await updateConfigForTargets('ai.apiBaseUrl', '');
    await updateConfigForTargets('ai.sendSchemaContext', true);
    await updateConfigForTargets('ai.maxSchemaChars', 150000);

    for (const key of LEGACY_AI_SETTING_KEYS) {
        await updateConfigForTargets(key, undefined);
    }

    lastAiSettingsSnapshot = captureAiSettingsSnapshot();
    await context.workspaceState.update(AI_SETTINGS_NORMALIZATION_KEY, `${version}:${AI_SETTINGS_RESET_TOKEN}`);
    Logger.info(`Reset AI settings to release defaults across user/workspace scopes for version ${version} (${AI_SETTINGS_RESET_TOKEN})`);
}

export async function syncAiSettingsAcrossScopes(): Promise<void> {
    if (isSyncingAiSettings) {
        return;
    }

    isSyncingAiSettings = true;
    try {
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
        await syncAiSettingKey(config, 'ai.source', getChangedScopeValue('ai.source', getConfiguredSource(config)));
        await syncAiSettingKey(config, 'ai.extension', getChangedScopeValue('ai.extension', config.get<string>('ai.extension', '')));
        await syncAiSettingKey(config, 'ai.apiProvider', getChangedScopeValue('ai.apiProvider', getConfiguredDirectApiProvider(config)));
        await syncAiSettingKey(config, 'ai.model', getChangedScopeValue('ai.model', config.get<string>('ai.model', 'gpt-4.1')));
        await syncAiSettingKey(config, 'ai.apiBaseUrl', getChangedScopeValue('ai.apiBaseUrl', config.get<string>('ai.apiBaseUrl', '')));
        await syncAiSettingKey(config, 'ai.sendSchemaContext', getChangedScopeValue('ai.sendSchemaContext', config.get<boolean>('ai.sendSchemaContext', true)));
        await syncAiSettingKey(config, 'ai.maxSchemaChars', getChangedScopeValue('ai.maxSchemaChars', config.get<number>('ai.maxSchemaChars', 150000)));

        for (const key of LEGACY_AI_SETTING_KEYS) {
            await syncAiSettingKey(config, key, undefined);
        }

        lastAiSettingsSnapshot = captureAiSettingsSnapshot();
    } finally {
        isSyncingAiSettings = false;
    }
}

export function isAiSettingsSyncInProgress(): boolean {
    return isSyncingAiSettings;
}

export function initializeAiSettingsSyncSnapshot(): void {
    lastAiSettingsSnapshot = captureAiSettingsSnapshot();
}

/**
 * Resolves the effective AI provider, reading from settings with migration and host-aware defaults.
 * This is the single source of truth for which AI provider to use.
 */
async function resolveAIProvider(context: vscode.ExtensionContext): Promise<{ provider: AIProviderOption; config: ProviderConfig | null }> {
    const cfg = vscode.workspace.getConfiguration('runql');
    const source = getConfiguredSource(cfg);

    if (source === "off") {
        return { provider: "none", config: null };
    }

    if (source === "githubCopilot") {
        return { provider: "vscodeChatModel", config: await resolveConfigForProvider("vscodeChatModel", context) };
    }

    if (source === "directApi") {
        const selectedProvider = getConfiguredDirectApiProvider(cfg);
        if (!selectedProvider) {
            return { provider: "none", config: null };
        }
        return { provider: selectedProvider, config: await resolveConfigForProvider(selectedProvider, context) };
    }

    if (source === "aiExtension") {
        return { provider: "none", config: null };
    }

    // 1. Check new setting first
    const selected = cfg.get<string>('ai.backend', '');
    if (selected) {
        return { provider: selected as AIProviderOption, config: await resolveConfigForProvider(selected as AIProviderOption, context) };
    }

    // 2. Fall back to legacy provider (shouldn't hit this after migration, but defensive)
    const legacyProvider = cfg.get<string>('ai.provider', '');
    if (legacyProvider && legacyProvider !== 'vscode') {
        const mapped = mapLegacyProvider(legacyProvider);
        return { provider: mapped, config: await resolveConfigForProvider(mapped, context) };
    }

    // 3. Auto-detect default by host environment
    const host = detectHostEnvironment();
    if (host === "stockVSCode") {
        return { provider: "vscodeChatModel", config: await resolveConfigForProvider("vscodeChatModel", context) };
    }

    // Bundled IDE: prefer extensionManaged if agent panel is available
    const agentCfg = await getAgentPanelConfig();
    if (agentCfg) {
        return { provider: "extensionManaged", config: agentCfg };
    }

    // Bundled IDE with no agent panel — check for a direct API provider in settings
    const settingsCfg = await getSettingsConfig(context);
    if (settingsCfg) {
        const mapped = mapLegacyProvider(settingsCfg.provider);
        return { provider: mapped, config: settingsCfg };
    }

    return { provider: "none", config: null };
}

/**
 * Resolves the ProviderConfig for a given AI provider option.
 */
async function resolveConfigForProvider(option: AIProviderOption, context: vscode.ExtensionContext): Promise<ProviderConfig | null> {
    if (option === "none") return null;

    if (option === "extensionManaged") {
        return resolveConfig(await getAgentPanelConfig());
    }

    if (option === "vscodeChatModel") {
        // VscodeLmProvider doesn't need full config validation — model is optional
        const config = vscode.workspace.getConfiguration('runql');
        const model = config.get<string>('ai.model', '');
        return { provider: "vscode", model, source: "settings" };
    }

    // Direct API backends: build config from settings using the mapped provider name
    const provider = providerOptionToName(option);
    if (!provider) return null;

    const config = vscode.workspace.getConfiguration('runql');
    const model = config.get<string>('ai.model', '');
    const endpoint = getConfiguredApiBaseUrl(config);
    const apiKey = await context.secrets.get('runql.ai.apiKey');

    return resolveConfig({
        provider,
        model,
        endpoint,
        apiKey: apiKey || undefined,
        source: "settings"
    });
}

function normalizeBaseUrl(endpoint: string, defaultBase: string): string {
    const base = endpoint && endpoint.trim().length > 0 ? endpoint.trim() : defaultBase;
    return base.replace(/\/+$/, "");
}

async function getAgentPanelConfig(): Promise<ProviderConfig | null> {
    const commands = await vscode.commands.getCommands(true);
    const candidates = [
        "runql.agent.getSelectedProvider",
        "runql.agent.getProviderConfig",
        "runql.agentPanel.getSelectedProvider"
    ];
    const cmd = candidates.find(c => commands.includes(c));
    if (!cmd) return null;

    try {
        const cfg = await vscode.commands.executeCommand<Record<string, string> | undefined>(cmd);
        if (!cfg?.provider || !cfg?.model) return null;
        return {
            provider: cfg.provider as ProviderName,
            model: cfg.model,
            endpoint: cfg.endpoint || cfg.baseUrl,
            apiKey: cfg.apiKey,
            source: "agent"
        } as ProviderConfig;
    } catch {
        return null;
    }
}

export async function openAiProviderSettings(): Promise<void> {
    const commands = await vscode.commands.getCommands(true);
    const candidates = [
        "runql.agent.open",
        "runql.agentPanel.open",
        "runql.agent.show"
    ];
    const cmd = candidates.find(c => commands.includes(c));
    if (cmd) {
        await vscode.commands.executeCommand(cmd);
        return;
    }
    await vscode.commands.executeCommand("workbench.action.openSettings", "runql.ai");
}

async function getSettingsConfig(context: vscode.ExtensionContext): Promise<ProviderConfig | null> {
    const config = vscode.workspace.getConfiguration('runql');
    const source = getConfiguredSource(config);

    if (source === "off" || source === "aiExtension") return null;

    if (source === "githubCopilot") {
        return {
            provider: "vscode",
            model: config.get<string>('ai.model', ''),
            source: "settings"
        };
    }

    if (source === "directApi") {
        const directProvider = getConfiguredDirectApiProvider(config);
        if (!directProvider) return null;

        const model = config.get<string>('ai.model', '');
        const endpoint = getConfiguredApiBaseUrl(config);
        const apiKey = await context.secrets.get('runql.ai.apiKey');

        return {
            provider: directProvider,
            model,
            endpoint,
            apiKey: apiKey || undefined,
            source: "settings"
        };
    }

    const provider = config.get<string>('ai.provider', 'vscode');
    if (!provider || provider === "none") return null;

    const model = config.get<string>('ai.model', '');
    const endpoint = getConfiguredApiBaseUrl(config);
    const apiKey = await context.secrets.get('runql.ai.apiKey');

    return {
        provider: provider as ProviderName,
        model,
        endpoint,
        apiKey: apiKey || undefined,
        source: "settings"
    };
}

function requiresApiKey(provider: ProviderName): boolean {
    return provider === "openai" || provider === "anthropic" || provider === "azureOpenAI";
}

function resolveConfig(candidate: ProviderConfig | null): ProviderConfig | null {
    if (!candidate) return null;
    if (!candidate.provider) return null;
    if (candidate.provider !== "vscode" && candidate.provider !== "ollama" && !candidate.model) return null;
    if (requiresApiKey(candidate.provider) && !candidate.apiKey) return null;
    if ((candidate.provider === "openaiCompatible" || candidate.provider === "azureOpenAI") && !candidate.endpoint) return null;
    return candidate;
}

async function resolveProviderConfig(context: vscode.ExtensionContext): Promise<ProviderConfig | null> {
    const agent = resolveConfig(await getAgentPanelConfig());
    if (agent) return agent;
    return resolveConfig(await getSettingsConfig(context));
}

class HttpAIProvider implements AIProvider {
    constructor(private cfg: ProviderConfig) { }

    async generateCompletion(prompt: string): Promise<string> {
        switch (this.cfg.provider) {
            case "openai":
                return this.callOpenAI(prompt);
            case "openaiCompatible":
                return this.callOpenAICompatible(prompt);
            case "azureOpenAI":
                return this.callAzureOpenAI(prompt);
            case "anthropic":
                return this.callAnthropic(prompt);
            case "ollama":
                return this.callOllama(prompt);
            default:
                throw new Error(formatAIError(
                    'AI request',
                    this.cfg.provider,
                    'Provider not supported',
                    'Check AI provider settings'
                ));
        }
    }

    private async callOpenAI(prompt: string): Promise<string> {
        const base = normalizeBaseUrl(this.cfg.endpoint || "", "https://api.openai.com/v1");
        const res = await fetch(`${base}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${this.cfg.apiKey}`
            },
            body: JSON.stringify({
                model: this.cfg.model,
                messages: [{ role: "user", content: prompt }],
                temperature: 0.2
            })
        });

        if (!res.ok) {
            const errText = await res.text();
            let reason = `HTTP ${res.status}`;
            let suggestion = 'Check API key and try again';

            if (res.status === 401) {
                reason = 'Authentication failed';
                suggestion = 'Check your OpenAI API key in settings';
            } else if (res.status === 429) {
                reason = 'Rate limit exceeded';
                suggestion = 'Wait a moment and try again';
            } else if (res.status >= 500) {
                reason = 'OpenAI service error';
                suggestion = 'Try again later';
            } else if (errText) {
                reason = errText.substring(0, 100);
            }

            throw new Error(formatAIError('AI request', 'OpenAI', reason, suggestion));
        }
        const json = await res.json() as OpenAIChatResponse;
        return json.choices?.[0]?.message?.content ?? "";
    }

    private async callOpenAICompatible(prompt: string): Promise<string> {
        const base = normalizeBaseUrl(this.cfg.endpoint || "", "");
        const headers: Record<string, string> = {
            "Content-Type": "application/json"
        };
        if (this.cfg.apiKey) {
            headers["Authorization"] = `Bearer ${this.cfg.apiKey}`;
        }
        const res = await fetch(`${base}/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify({
                model: this.cfg.model,
                messages: [{ role: "user", content: prompt }],
                temperature: 0.2
            })
        });

        if (!res.ok) {
            const errText = await res.text();
            let reason = `HTTP ${res.status}`;
            let suggestion = 'Check endpoint and API key settings';

            if (res.status === 401) {
                reason = 'Authentication failed';
            } else if (res.status === 429) {
                reason = 'Rate limit exceeded';
                suggestion = 'Wait a moment and try again';
            } else if (res.status >= 500) {
                reason = 'Server error';
                suggestion = 'Check endpoint URL and try again later';
            } else if (errText) {
                reason = errText.substring(0, 100);
            }

            throw new Error(formatAIError('AI request', 'OpenAI-compatible', reason, suggestion));
        }
        const json = await res.json() as OpenAIChatResponse;
        return json.choices?.[0]?.message?.content ?? "";
    }

    private async callAzureOpenAI(prompt: string): Promise<string> {
        const base = normalizeBaseUrl(this.cfg.endpoint || "", "");
        const url = `${base}/openai/deployments/${encodeURIComponent(this.cfg.model)}/chat/completions?api-version=2024-02-15-preview`;
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "api-key": this.cfg.apiKey || ""
            },
            body: JSON.stringify({
                messages: [{ role: "user", content: prompt }],
                temperature: 0.2
            })
        });

        if (!res.ok) {
            const errText = await res.text();
            let reason = `HTTP ${res.status}`;
            let suggestion = 'Check Azure endpoint and API key';

            if (res.status === 401 || res.status === 403) {
                reason = 'Authentication failed';
            } else if (res.status === 429) {
                reason = 'Rate limit exceeded';
                suggestion = 'Wait a moment and try again';
            } else if (res.status >= 500) {
                reason = 'Azure service error';
                suggestion = 'Try again later';
            } else if (errText) {
                reason = errText.substring(0, 100);
            }

            throw new Error(formatAIError('AI request', 'Azure OpenAI', reason, suggestion));
        }
        const json = await res.json() as OpenAIChatResponse;
        return json.choices?.[0]?.message?.content ?? "";
    }

    private async callAnthropic(prompt: string): Promise<string> {
        const base = normalizeBaseUrl(this.cfg.endpoint || "", "https://api.anthropic.com");
        const res = await fetch(`${base}/v1/messages`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": this.cfg.apiKey || "",
                "anthropic-version": "2023-06-01"
            },
            body: JSON.stringify({
                model: this.cfg.model,
                max_tokens: 1200,
                messages: [{ role: "user", content: prompt }]
            })
        });

        if (!res.ok) {
            const errText = await res.text();
            let reason = `HTTP ${res.status}`;
            let suggestion = 'Check API key and try again';

            if (res.status === 401) {
                reason = 'Authentication failed';
                suggestion = 'Check your Anthropic API key in settings';
            } else if (res.status === 429) {
                reason = 'Rate limit exceeded';
                suggestion = 'Wait a moment and try again';
            } else if (res.status >= 500) {
                reason = 'Anthropic service error';
                suggestion = 'Try again later';
            } else if (errText) {
                reason = errText.substring(0, 100);
            }

            throw new Error(formatAIError('AI request', 'Anthropic', reason, suggestion));
        }
        const json = await res.json() as AnthropicResponse;
        const content = json.content?.[0]?.text ?? "";
        return content;
    }

    private async callOllama(prompt: string): Promise<string> {
        const base = normalizeBaseUrl(this.cfg.endpoint || "", "http://localhost:11434");
        const res = await fetch(`${base}/api/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: this.cfg.model,
                prompt,
                stream: false
            })
        });

        if (!res.ok) {
            const errText = await res.text();
            let reason = `HTTP ${res.status}`;
            let suggestion = 'Check that Ollama is running and the model is available';

            if (res.status === 404) {
                reason = 'Model not found';
                suggestion = 'Pull the model with "ollama pull" first';
            } else if (res.status >= 500) {
                reason = 'Ollama service error';
                suggestion = 'Check Ollama logs';
            } else if (errText) {
                reason = errText.substring(0, 100);
            }

            throw new Error(formatAIError('AI request', 'Ollama', reason, suggestion));
        }
        const json = await res.json() as OllamaGenerateResponse;
        return json.response ?? "";
    }
}

class VscodeLmProvider implements AIProvider {
    constructor(private cfg: ProviderConfig) { }

    async generateCompletion(prompt: string): Promise<string> {
        // VS Code Language Model API is experimental/proposed; access via `any` is necessary
        const lm = (vscode as Record<string, unknown>).lm as { selectChatModels?: (selector: Record<string, string>) => Promise<VsCodeLmModel[]> } | undefined;
        if (!lm || !lm.selectChatModels) {
            throw new Error(formatAIError(
                'AI request',
                'VS Code LM',
                'Language Model API not available',
                'Update to VS Code version that supports Language Models'
            ));
        }

        const selector: Record<string, string> = {};
        if (this.cfg.model && this.cfg.model.trim().length > 0) {
            selector.family = this.cfg.model;
        }

        let models = await lm.selectChatModels(selector);

        // If specific model not found, fall back to any
        if ((!models || models.length === 0) && selector.family) {

            models = await lm.selectChatModels({});
        }

        if (!models || models.length === 0) {
            const host = detectHostEnvironment();
            const suggestion = host === "bundledIDE"
                ? 'No VS Code chat models are available in this IDE. Choose another AI provider or use Copy Prompt.'
                : 'No VS Code chat models available. Install a VS Code chat/model provider or choose another AI provider.';
            throw new Error(formatAIError(
                'AI request',
                'VS Code LM',
                'No chat models available',
                suggestion
            ));
        }

        // Prefer one that matches our config if we fell back
        let model = models[0];
        if (selector.family) {
            const best = models.find((m) => m.family === selector.family || m.id === selector.family);
            if (best) model = best;
        }



        // VS Code experimental LanguageModelChatMessage API
        const msgFactory = (vscode as Record<string, unknown>).LanguageModelChatMessage as { User?: (content: string) => unknown } | undefined;
        const messages = msgFactory?.User
            ? [msgFactory.User(prompt)]
            : [{ role: "user", content: prompt }];

        const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

        // The response is an async iterable. Each chunk should have a 'value' property for text.
        let result = "";
        for await (const part of response.text) {
            // VS Code LM API: part is a LanguageModelTextPart with .value
            if (typeof part === "string") {
                result += part;
            } else if (part && typeof (part as Record<string, unknown>).value === "string") {
                result += (part as Record<string, unknown>).value;
            } else if (part && typeof part === "object") {
                // Fallback: try to extract text in various ways
                const p = part as Record<string, unknown>;
                const text = p.text ?? p.content ?? "";
                if (typeof text === "string") {
                    result += text;
                }
            }
        }


        return result;
    }
}

/** Loosely-typed LM response — shape varies by provider/version */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function _extractLmTextNonStreaming(response: Record<string, any> | string | null | undefined): Promise<string> {
    if (!response) return "";
    if (typeof response === "string") return response;
    if (typeof response.text === "string") return response.text;
    if (response.text?.stream && Symbol.asyncIterator in response.text.stream) return "";
    if (typeof response.text === "function") {
        try {
            const value = await response.text();
            if (typeof value === "string") return value;
        } catch (e) {
            // Extraction method failed, trying next approach
            Logger.debug(`Text extraction via response.text() failed: ${e}`);
        }
    }
    if (typeof response.response?.text === "function") {
        try {
            const value = await response.response.text();
            if (typeof value === "string") return value;
        } catch (e) {
            // Extraction method failed, trying next approach
            Logger.debug(`Text extraction via response.response.text() failed: ${e}`);
        }
    }
    if (typeof response.response?.text === "string") return response.response.text;
    if (response.content && Array.isArray(response.content)) {
        return response.content.map((c: ContentPart) => c.text ?? c.value ?? "").join("");
    }
    if (response.response?.content && Array.isArray(response.response.content)) {
        return response.response.content.map((c: ContentPart) => c.text ?? c.value ?? "").join("");
    }
    return "";
}

/** Loosely-typed LM response — shape varies by provider/version */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function _extractLmText(response: Record<string, any> | string | null | undefined): Promise<string> {
    if (!response) return "";
    if (typeof response === "string") return response;
    if (typeof response.text === "string") return response.text;
    if (typeof response.text === "function") {
        try {
            const value = await response.text();
            if (typeof value === "string") return value;
            if (value && Symbol.asyncIterator in value) return await consumeAsyncText(value);
        } catch (e) {
            // LM text extraction method failed, trying next approach
            Logger.debug(`LM text extraction via response.text() failed: ${e}`);
        }
    }
    if (typeof response.response?.text === "function") {
        try {
            const value = await response.response.text();
            if (typeof value === "string") return value;
            if (value && Symbol.asyncIterator in value) return await consumeAsyncText(value);
        } catch (e) {
            // LM text extraction method failed, trying next approach
            Logger.debug(`LM text extraction via response.response.text() failed: ${e}`);
        }
    }
    if (response.text && Symbol.asyncIterator in response.text) {
        return await consumeAsyncText(response.text);
    }
    if (response.stream && Symbol.asyncIterator in response.stream) {
        return await consumeAsyncText(response.stream);
    }
    if (response.text?.stream && Symbol.asyncIterator in response.text.stream) {
        return await consumeAsyncText(response.text.stream);
    }
    if (response.response?.stream && Symbol.asyncIterator in response.response.stream) {
        return await consumeAsyncText(response.response.stream);
    }
    if (typeof response.text?.value === "string") return response.text.value;
    if (typeof response.text?.text === "string") return response.text.text;
    if (typeof response.response?.text === "string") return response.response.text;
    if (typeof response.response?.text === "string") return response.response.text;
    if (response.content && Array.isArray(response.content)) {
        return response.content.map((c: ContentPart) => c.text ?? c.value ?? "").join("");
    }
    if (response.response?.content && Array.isArray(response.response.content)) {
        return response.response.content.map((c: ContentPart) => c.text ?? c.value ?? "").join("");
    }
    if (Symbol.asyncIterator in response) {
        return await consumeAsyncText(response as AsyncIterable<unknown>);
    }
    try {
        return JSON.stringify(response);
    } catch {
        return String(response);
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function consumeAsyncText(stream: AsyncIterable<any>): Promise<string> {
    let acc = "";
    for await (const chunk of stream) {
        if (typeof chunk === "string") {
            acc += chunk;
            continue;
        }

        // Handle VS Code LanguageModelChatResponseChunk (it often uses 'part' for new API)
        if (chunk.part) {
            if (typeof chunk.part === "string") acc += chunk.part;
            else if (chunk.part.value) acc += chunk.part.value;
            else if (chunk.part.text) acc += chunk.part.text;
            continue;
        }

        if (chunk?.text?.value) {
            acc += chunk.text.value;
        } else if (chunk?.text?.text) {
            acc += chunk.text.text;
        } else if (chunk?.text) {
            acc += chunk.text;
        } else if (chunk?.value) {
            acc += chunk.value;
        } else if (chunk?.content) {
            acc += chunk.content;
        } else if (Array.isArray(chunk?.content)) {
            acc += chunk.content.map((c: ContentPart) => c.text ?? c.value ?? "").join("");
        } else if (Array.isArray(chunk?.parts)) {
            acc += chunk.parts.map((p: ContentPart) => p.text ?? p.value ?? "").join("");
        }
    }
    return acc;
}

async function pickOllamaModel(endpoint?: string): Promise<string | undefined> {
    try {
        const base = normalizeBaseUrl(endpoint || "", "http://localhost:11434");
        const res = await fetch(`${base}/api/tags`);
        if (!res.ok) return undefined;
        const json = await res.json() as OllamaTagsResponse;
        const models = (json.models || []).map((m) => m.name).filter(Boolean);
        if (models.length === 0) return undefined;
        const picked = await vscode.window.showQuickPick(models, { title: "Select Ollama model" });
        return picked || undefined;
    } catch {
        return undefined;
    }
}

export async function getConfiguredAIProvider(
    context: vscode.ExtensionContext,
    options?: { requireConfigured?: boolean }
): Promise<AIProvider | null> {
    const { provider, config: cfg } = await resolveAIProvider(context);

    if (provider === "none" || !cfg) {
        if (options?.requireConfigured) return null;
        return new MockAIProvider();
    }
    if (cfg.provider === "vscode") {
        return new VscodeLmProvider(cfg);
    }
    if (cfg.provider === "ollama" && !cfg.model) {
        const picked = await pickOllamaModel(cfg.endpoint);
        if (picked) {
            await updateConfig("ai.model", picked);
            cfg.model = picked;
        }
    }
    return new HttpAIProvider(cfg);
}

export async function selectAIModel(): Promise<void> {
    // VS Code Language Model API is experimental/proposed; access via cast is necessary
    const lm = (vscode as Record<string, unknown>).lm as { selectChatModels?: (selector: Record<string, string>) => Promise<VsCodeLmModel[]> } | undefined;
    if (!lm || !lm.selectChatModels) {
        vscode.window.showErrorMessage("VS Code Language Model API not available.");
        return;
    }

    try {
        const models = await lm.selectChatModels({});
        if (!models || models.length === 0) {
            vscode.window.showWarningMessage("No VS Code chat models found.");
            return;
        }

        // Gather unique families
        const items = models.map((m) => {
            return {
                label: `$(hubot) ${m.family}`,
                description: m.name ?? m.id,
                family: m.family
            };
        });

        // Deduplicate by family to avoid showing same thing multiple times if multiple instances exist
        const uniqueItems = [];
        const seen = new Set();
        for (const item of items) {
            if (!seen.has(item.family)) {
                seen.add(item.family);
                uniqueItems.push(item);
            }
        }

        const picked = await vscode.window.showQuickPick(uniqueItems, {
            placeHolder: "Select an AI model family",
            title: "Select VS Code AI Model"
        });

        if (picked) {
            await updateConfig("ai.model", picked.family);
            vscode.window.showInformationMessage(`AI Model set to: ${picked.family}`);
        }

    } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`Failed to select model: ${message}`);
    }
}

export async function getAIProvider(
    context?: vscode.ExtensionContext
): Promise<AIProvider> {
    if (!context) return new MockAIProvider();
    return (await getConfiguredAIProvider(context)) ?? new MockAIProvider();
}

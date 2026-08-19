import * as vscode from 'vscode';
import { SchemaIntrospection } from '../core/types';
import { loadSchemas } from './schemaStore';
import { loadDescriptions, saveDescriptions, SchemaDescriptionsFile } from './descriptionStore';
import { Logger } from '../core/logger';

export interface SchemaDocumentationReminderState {
    state: 'prompted' | 'dismissed' | 'actioned';
    promptedAt: string | null;
    dismissedAt: string | null;
    actionedAt: string | null;
}

interface QueueItem {
    connectionId: string;
    connectionName: string;
    schemaName: string;
}

const UNRESOLVED_PROMPT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const NOTIFICATION_WATCHDOG_MS = 2 * 60 * 1000;

let queue: QueueItem[] = [];
let activeItem: QueueItem | null = null;
let activeReminderToken = 0;
let _activeWatchdogTimer: ReturnType<typeof setTimeout> | null = null;

function itemKey(item: QueueItem): string {
    return `${item.connectionId}::${item.schemaName}`;
}

function isEligible(reminder: SchemaDocumentationReminderState | undefined): boolean {
    if (!reminder) return true;

    if (reminder.state === 'dismissed' || reminder.state === 'actioned') return false;

    if (reminder.state === 'prompted' && reminder.promptedAt) {
        const elapsed = Date.now() - new Date(reminder.promptedAt).getTime();
        if (elapsed < UNRESOLVED_PROMPT_COOLDOWN_MS) return false;
    }

    return true;
}

function isUndocumented(desc: SchemaDescriptionsFile): boolean {
    return !desc.tables || Object.keys(desc.tables).length === 0;
}

async function loadReminderState(
    connectionId: string,
    connectionName: string | undefined,
    schemaName: string
): Promise<{ desc: SchemaDescriptionsFile | null; reminder: SchemaDocumentationReminderState | undefined }> {
    const desc = await loadDescriptions(connectionId, connectionName, schemaName);
    const reminder = (desc as unknown as Record<string, unknown> | null)?.schemaDocumentationReminder as SchemaDocumentationReminderState | undefined;
    return { desc, reminder };
}

async function writeReminderState(
    connectionId: string,
    connectionName: string | undefined,
    schemaName: string,
    reminderState: SchemaDocumentationReminderState,
    existingDesc?: SchemaDescriptionsFile | null
): Promise<void> {
    const desc = existingDesc ?? await loadDescriptions(connectionId, connectionName, schemaName);
    if (!desc) return;
    (desc as unknown as Record<string, unknown>).schemaDocumentationReminder = reminderState;
    await saveDescriptions(connectionId, connectionName, desc);
}

export async function enqueueSchemaReminders(
    connectionId: string,
    connectionName: string,
    schemaNames: string[]
): Promise<void> {
    const sorted = [...schemaNames].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);

    for (const schemaName of sorted) {
        const candidate: QueueItem = { connectionId, connectionName, schemaName };
        const key = itemKey(candidate);

        if (activeItem && itemKey(activeItem) === key) continue;
        if (queue.some(q => itemKey(q) === key)) continue;

        const { desc, reminder } = await loadReminderState(connectionId, connectionName, schemaName);
        if (!desc || !isUndocumented(desc) || !isEligible(reminder)) continue;

        queue.push(candidate);
    }

    await drainAll();
}

export async function enqueueFromIntrospectionResult(
    introspection: SchemaIntrospection
): Promise<void> {
    const connectionId = introspection.connectionId;
    const connectionName = introspection.connectionName || connectionId;
    const schemaNames = introspection.schemas.map(s => s.name);
    await enqueueSchemaReminders(connectionId, connectionName, schemaNames);
}

export async function scanExistingSchemas(): Promise<void> {
    let allSchemas: SchemaIntrospection[];
    try {
        allSchemas = await loadSchemas();
    } catch (e) {
        Logger.warn('Schema documentation reminder: failed to load schemas for activation scan', e);
        return;
    }

    const batches: QueueItem[] = [];

    const sortedSchemas = [...allSchemas].sort((a, b) => {
        const nameA = a.connectionName || '';
        const nameB = b.connectionName || '';
        const nameCmp = nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
        if (nameCmp !== 0) return nameCmp;
        return a.connectionId < b.connectionId ? -1 : a.connectionId > b.connectionId ? 1 : 0;
    });

    for (const introspection of sortedSchemas) {
        const connectionId = introspection.connectionId;
        const connectionName = introspection.connectionName || connectionId;

        const schemaNames = introspection.schemas
            .map(s => s.name)
            .sort((a, b) => a < b ? -1 : a > b ? 1 : 0);

        for (const schemaName of schemaNames) {
            const { desc, reminder } = await loadReminderState(connectionId, connectionName, schemaName);
            if (!desc || !isUndocumented(desc) || !isEligible(reminder)) continue;

            const candidate: QueueItem = { connectionId, connectionName, schemaName };
            const key = itemKey(candidate);
            if (queue.some(q => itemKey(q) === key)) continue;
            if (activeItem && itemKey(activeItem) === key) continue;

            batches.push(candidate);
        }
    }

    queue.push(...batches);
    await drainAll();
}

async function drainAll(): Promise<void> {
    while (queue.length > 0 && !activeItem) {
        const item = queue.shift()!;
        activeItem = item;
        await showReminder(item);
    }
}

async function showReminder(item: QueueItem): Promise<void> {
    const { desc, reminder } = await loadReminderState(item.connectionId, item.connectionName, item.schemaName);
    if (!desc || !isUndocumented(desc) || !isEligible(reminder)) {
        activeItem = null;
        return;
    }

    let introspection: SchemaIntrospection | undefined;
    let schemaModel: { name: string } | undefined;
    try {
        const allSchemas = await loadSchemas();
        introspection = allSchemas.find(s => s.connectionId === item.connectionId);
        if (introspection) {
            const found = introspection.schemas.find(s => s.name === item.schemaName);
            if (found) schemaModel = { name: found.name };
        }
    } catch (e) {
        Logger.warn('Schema documentation reminder: failed to reconstruct context', e);
    }

    if (!introspection || !schemaModel) {
        activeItem = null;
        return;
    }

    const promptedState: SchemaDocumentationReminderState = {
        state: 'prompted',
        promptedAt: new Date().toISOString(),
        dismissedAt: null,
        actionedAt: null,
    };
    await writeReminderState(item.connectionId, item.connectionName, item.schemaName, promptedState, desc);

    const message = `You've added ${item.connectionName}.${item.schemaName}. Add context now with your AI for this schema. This will help your AI provide better queries when asked and better query documentation.`;

    const myToken = ++activeReminderToken;
    let watchdogFired = false;
    let myWatchdogTimer: ReturnType<typeof setTimeout> | null = null;

    const watchdogPromise = new Promise<'watchdog'>(resolve => {
        myWatchdogTimer = setTimeout(() => {
            watchdogFired = true;
            if (activeReminderToken === myToken) {
                activeItem = null;
            }
            resolve('watchdog');
        }, NOTIFICATION_WATCHDOG_MS);

        _activeWatchdogTimer = myWatchdogTimer;
    });

    const notificationPromise = vscode.window.showInformationMessage(
        message,
        'Document Schema Now',
        "I'll do this later"
    );

    const result = await Promise.race([
        notificationPromise.then(choice => ({ kind: 'notification' as const, choice })),
        watchdogPromise.then(() => ({ kind: 'watchdog' as const })),
    ]);

    if (result.kind === 'watchdog') {
        // Watchdog won — release the queue slot (already done above).
        // Fire-and-forget: if the user clicks later, honor their choice
        // on this schema without touching activeItem or the current queue.
        Promise.resolve(notificationPromise).then(async (choice) => {
            await handleChoice(choice, item, introspection, schemaModel, promptedState);
        }).catch((e: unknown) => Logger.warn('Late notification handler failed', e));
        return;
    }

    if (myWatchdogTimer) {
        clearTimeout(myWatchdogTimer);
        myWatchdogTimer = null;
    }

    await handleChoice(result.choice, item, introspection, schemaModel, promptedState);
    activeItem = null;
}

async function handleChoice(
    choice: string | undefined,
    item: QueueItem,
    introspection: SchemaIntrospection,
    schemaModel: { name: string },
    promptedState: SchemaDocumentationReminderState,
): Promise<void> {
    const { desc, reminder: current } = await loadReminderState(item.connectionId, item.connectionName, item.schemaName);
    if (current && (current.state === 'dismissed' || current.state === 'actioned')) return;
    if (current && current.state === 'prompted' && current.promptedAt !== promptedState.promptedAt) return;

    if (choice === 'Document Schema Now') {
        const actionedState: SchemaDocumentationReminderState = {
            state: 'actioned',
            promptedAt: promptedState.promptedAt,
            dismissedAt: null,
            actionedAt: new Date().toISOString(),
        };
        await writeReminderState(item.connectionId, item.connectionName, item.schemaName, actionedState, desc);

        try {
            await vscode.commands.executeCommand('runql.schema.generateDescriptionsWithAI', {
                introspection,
                schemaModel,
            });
        } catch (e) {
            Logger.warn('Schema documentation reminder: AI generation failed', e);
        }

        await ensureActionedState(item, promptedState.promptedAt);
    } else {
        const dismissedState: SchemaDocumentationReminderState = {
            state: 'dismissed',
            promptedAt: promptedState.promptedAt,
            dismissedAt: new Date().toISOString(),
            actionedAt: null,
        };
        await writeReminderState(item.connectionId, item.connectionName, item.schemaName, dismissedState, desc);
    }
}

// Defense-in-depth: re-applies actioned state if generateDescriptionsWithAI overwrites description.json and drops the field
async function ensureActionedState(item: QueueItem, originalPromptedAt: string | null): Promise<void> {
    const { reminder } = await loadReminderState(item.connectionId, item.connectionName, item.schemaName);
    if (!reminder || reminder.state !== 'actioned') {
        const reapplied: SchemaDocumentationReminderState = {
            state: 'actioned',
            promptedAt: originalPromptedAt,
            dismissedAt: null,
            actionedAt: new Date().toISOString(),
        };
        await writeReminderState(item.connectionId, item.connectionName, item.schemaName, reapplied);
    }
}

export function _getQueueForTesting(): QueueItem[] {
    return queue;
}

export function _getActiveItemForTesting(): QueueItem | null {
    return activeItem;
}

export function _resetForTesting(): void {
    queue = [];
    activeItem = null;
    activeReminderToken = 0;
    if (_activeWatchdogTimer) {
        clearTimeout(_activeWatchdogTimer);
        _activeWatchdogTimer = null;
    }
}

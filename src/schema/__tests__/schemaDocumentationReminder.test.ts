import * as vscode from 'vscode';
import {
    enqueueSchemaReminders,
    enqueueFromIntrospectionResult,
    scanExistingSchemas,
    _getQueueForTesting,
    _getActiveItemForTesting,
    _resetForTesting,
    SchemaDocumentationReminderState,
} from '../schemaDocumentationReminder';
import { SchemaIntrospection } from '../../core/types';

jest.mock('../schemaStore');
jest.mock('../descriptionStore');

const mockLoadSchemas = require('../schemaStore').loadSchemas as jest.Mock;
const mockLoadDescriptions = require('../descriptionStore').loadDescriptions as jest.Mock;
const mockSaveDescriptions = require('../descriptionStore').saveDescriptions as jest.Mock;
const mockShowInformationMessage = vscode.window.showInformationMessage as jest.Mock;
const mockExecuteCommand = vscode.commands.executeCommand as jest.Mock;

function makeDescriptionFile(
    tables: Record<string, unknown> = {},
    reminder?: SchemaDocumentationReminderState
): Record<string, unknown> {
    const desc: Record<string, unknown> = {
        __runqlHeader: '#RunQL created',
        version: '0.1',
        generatedAt: '2026-01-01T00:00:00.000Z',
        connectionId: 'conn-1',
        connectionName: 'TestConn',
        dialect: 'postgres',
        schemaName: 'public',
        tables: { ...tables },
        columns: {},
    };
    if (reminder) {
        desc.schemaDocumentationReminder = { ...reminder };
    }
    return desc;
}

function freshDescFactory(
    tables: Record<string, unknown> = {},
    reminder?: SchemaDocumentationReminderState
) {
    return () => makeDescriptionFile(tables, reminder);
}

function makeIntrospection(overrides?: Partial<SchemaIntrospection>): SchemaIntrospection {
    return {
        version: '0.2',
        generatedAt: '2026-01-01T00:00:00.000Z',
        connectionId: 'conn-1',
        connectionName: 'TestConn',
        dialect: 'postgres',
        schemas: [{ name: 'public', tables: [], views: [] }],
        ...overrides,
    };
}

beforeEach(() => {
    _resetForTesting();
    jest.useFakeTimers();
    mockLoadDescriptions.mockReset();
    mockSaveDescriptions.mockReset();
    mockLoadSchemas.mockReset();
    mockShowInformationMessage.mockReset();
    mockExecuteCommand.mockReset();
    mockShowInformationMessage.mockResolvedValue(undefined);
});

afterEach(() => {
    jest.useRealTimers();
});

describe('eligibility', () => {
    test('detects undocumented schemas by empty tables', async () => {
        mockLoadDescriptions.mockImplementation(freshDescFactory());
        mockLoadSchemas.mockResolvedValue([makeIntrospection()]);

        await enqueueSchemaReminders('conn-1', 'TestConn', ['public']);

        expect(mockShowInformationMessage).toHaveBeenCalledWith(
            expect.stringContaining('TestConn.public'),
            'Document Schema Now',
            "I'll do this later"
        );
    });

    test('skips documented schemas with non-empty tables', async () => {
        mockLoadDescriptions.mockImplementation(
            freshDescFactory({ 'public.users': { description: 'Users', source: 'ai' } })
        );

        await enqueueSchemaReminders('conn-1', 'TestConn', ['public']);

        expect(_getQueueForTesting()).toHaveLength(0);
        expect(mockShowInformationMessage).not.toHaveBeenCalled();
    });

    test('skips schemas with existing dismissed state', async () => {
        mockLoadDescriptions.mockImplementation(freshDescFactory({}, {
            state: 'dismissed',
            promptedAt: '2026-01-01T00:00:00.000Z',
            dismissedAt: '2026-01-01T00:01:00.000Z',
            actionedAt: null,
        }));

        await enqueueSchemaReminders('conn-1', 'TestConn', ['public']);

        expect(_getQueueForTesting()).toHaveLength(0);
        expect(mockShowInformationMessage).not.toHaveBeenCalled();
    });

    test('skips schemas with existing actioned state', async () => {
        mockLoadDescriptions.mockImplementation(freshDescFactory({}, {
            state: 'actioned',
            promptedAt: '2026-01-01T00:00:00.000Z',
            dismissedAt: null,
            actionedAt: '2026-01-01T00:01:00.000Z',
        }));

        await enqueueSchemaReminders('conn-1', 'TestConn', ['public']);

        expect(_getQueueForTesting()).toHaveLength(0);
        expect(mockShowInformationMessage).not.toHaveBeenCalled();
    });

    test('skips recently prompted schemas within cooldown', async () => {
        const recentTime = new Date(Date.now() - 1000).toISOString();
        mockLoadDescriptions.mockImplementation(freshDescFactory({}, {
            state: 'prompted',
            promptedAt: recentTime,
            dismissedAt: null,
            actionedAt: null,
        }));

        await enqueueSchemaReminders('conn-1', 'TestConn', ['public']);

        expect(_getQueueForTesting()).toHaveLength(0);
        expect(mockShowInformationMessage).not.toHaveBeenCalled();
    });

    test('re-queues stale prompted schemas after cooldown expires', async () => {
        const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
        mockLoadDescriptions.mockImplementation(freshDescFactory({}, {
            state: 'prompted',
            promptedAt: oldTime,
            dismissedAt: null,
            actionedAt: null,
        }));
        mockLoadSchemas.mockResolvedValue([makeIntrospection()]);

        await enqueueSchemaReminders('conn-1', 'TestConn', ['public']);

        expect(mockShowInformationMessage).toHaveBeenCalled();
    });
});

describe('persistence', () => {
    test('marks prompted before showing the notification', async () => {
        mockLoadDescriptions.mockImplementation(freshDescFactory());
        mockLoadSchemas.mockResolvedValue([makeIntrospection()]);

        await enqueueSchemaReminders('conn-1', 'TestConn', ['public']);

        const promptedCall = mockSaveDescriptions.mock.calls.find(
            (call: unknown[]) => {
                const data = call[2] as Record<string, unknown>;
                const reminder = data?.schemaDocumentationReminder as SchemaDocumentationReminderState | undefined;
                return reminder?.state === 'prompted';
            }
        );
        expect(promptedCall).toBeDefined();

        const promptedCallIndex = mockSaveDescriptions.mock.calls.indexOf(promptedCall);
        const firstShowCall = mockShowInformationMessage.mock.invocationCallOrder[0];
        const promptedSaveOrder = mockSaveDescriptions.mock.invocationCallOrder[promptedCallIndex];
        expect(promptedSaveOrder).toBeLessThan(firstShowCall);
    });

    test('marks dismissed when user chooses I\'ll do this later', async () => {
        mockLoadDescriptions.mockImplementation(freshDescFactory());
        mockLoadSchemas.mockResolvedValue([makeIntrospection()]);
        mockShowInformationMessage.mockResolvedValue("I'll do this later");

        await enqueueSchemaReminders('conn-1', 'TestConn', ['public']);

        const dismissedCall = mockSaveDescriptions.mock.calls.find(
            (call: unknown[]) => {
                const data = call[2] as Record<string, unknown>;
                const reminder = data?.schemaDocumentationReminder as SchemaDocumentationReminderState | undefined;
                return reminder?.state === 'dismissed';
            }
        );
        expect(dismissedCall).toBeDefined();
    });

    test('marks dismissed when notification returns undefined', async () => {
        mockLoadDescriptions.mockImplementation(freshDescFactory());
        mockLoadSchemas.mockResolvedValue([makeIntrospection()]);
        mockShowInformationMessage.mockResolvedValue(undefined);

        await enqueueSchemaReminders('conn-1', 'TestConn', ['public']);

        const dismissedCall = mockSaveDescriptions.mock.calls.find(
            (call: unknown[]) => {
                const data = call[2] as Record<string, unknown>;
                const reminder = data?.schemaDocumentationReminder as SchemaDocumentationReminderState | undefined;
                return reminder?.state === 'dismissed';
            }
        );
        expect(dismissedCall).toBeDefined();
    });

    test('marks actioned and executes generateDescriptionsWithAI when user chooses Document Schema Now', async () => {
        mockLoadDescriptions.mockImplementation(freshDescFactory());
        mockLoadSchemas.mockResolvedValue([makeIntrospection()]);
        mockShowInformationMessage.mockResolvedValue('Document Schema Now');
        mockExecuteCommand.mockResolvedValue(undefined);

        await enqueueSchemaReminders('conn-1', 'TestConn', ['public']);

        const actionedCall = mockSaveDescriptions.mock.calls.find(
            (call: unknown[]) => {
                const data = call[2] as Record<string, unknown>;
                const reminder = data?.schemaDocumentationReminder as SchemaDocumentationReminderState | undefined;
                return reminder?.state === 'actioned';
            }
        );
        expect(actionedCall).toBeDefined();

        expect(mockExecuteCommand).toHaveBeenCalledWith(
            'runql.schema.generateDescriptionsWithAI',
            expect.objectContaining({
                introspection: expect.objectContaining({ connectionId: 'conn-1' }),
                schemaModel: expect.objectContaining({ name: 'public' }),
            })
        );
    });
});

describe('queue behavior', () => {
    test('deduplicates queued schemas', async () => {
        let savedState: SchemaDocumentationReminderState | undefined;
        mockLoadDescriptions.mockImplementation(() => {
            const desc = makeDescriptionFile({}, savedState);
            return Promise.resolve(desc);
        });
        mockSaveDescriptions.mockImplementation(async (_cid: string, _cn: string, data: Record<string, unknown>) => {
            const r = data?.schemaDocumentationReminder as SchemaDocumentationReminderState | undefined;
            if (r) savedState = { ...r };
        });
        mockLoadSchemas.mockResolvedValue([makeIntrospection()]);

        await enqueueSchemaReminders('conn-1', 'TestConn', ['public']);

        expect(mockShowInformationMessage).toHaveBeenCalledTimes(1);

        await enqueueSchemaReminders('conn-1', 'TestConn', ['public']);

        expect(mockShowInformationMessage).toHaveBeenCalledTimes(1);
    });

    test('shows queued schemas sequentially', async () => {
        const introspection = makeIntrospection({
            schemas: [
                { name: 'alpha', tables: [], views: [] },
                { name: 'beta', tables: [], views: [] },
            ],
        });

        const calls: string[] = [];
        mockLoadDescriptions.mockImplementation(freshDescFactory());
        mockLoadSchemas.mockResolvedValue([introspection]);
        mockShowInformationMessage.mockImplementation(async (msg: string) => {
            calls.push(msg.includes('alpha') ? 'alpha' : 'beta');
            return undefined;
        });

        await enqueueSchemaReminders('conn-1', 'TestConn', ['alpha', 'beta']);

        expect(calls).toEqual(['alpha', 'beta']);
    });

    test('enqueues schemas alphabetically', async () => {
        const introspection = makeIntrospection({
            schemas: [
                { name: 'zeta', tables: [], views: [] },
                { name: 'alpha', tables: [], views: [] },
                { name: 'middle', tables: [], views: [] },
            ],
        });

        const calls: string[] = [];
        mockLoadDescriptions.mockImplementation(freshDescFactory());
        mockLoadSchemas.mockResolvedValue([introspection]);
        mockShowInformationMessage.mockImplementation(async (msg: string) => {
            if (msg.includes('alpha')) calls.push('alpha');
            else if (msg.includes('middle')) calls.push('middle');
            else if (msg.includes('zeta')) calls.push('zeta');
            return undefined;
        });

        await enqueueSchemaReminders('conn-1', 'TestConn', ['zeta', 'alpha', 'middle']);

        expect(calls).toEqual(['alpha', 'middle', 'zeta']);
    });
});

describe('watchdog', () => {
    test('releases active queue slot when watchdog expires without marking terminal', async () => {
        let resolveFirst: ((value: string | undefined) => void) | undefined;
        const secondSchemaShown = jest.fn().mockReturnValue(undefined);

        mockLoadDescriptions.mockImplementation(freshDescFactory());
        mockLoadSchemas.mockResolvedValue([
            makeIntrospection({
                schemas: [
                    { name: 'first', tables: [], views: [] },
                    { name: 'second', tables: [], views: [] },
                ],
            }),
        ]);

        let callCount = 0;
        mockShowInformationMessage.mockImplementation(() => {
            callCount++;
            if (callCount === 1) {
                return new Promise<string | undefined>(resolve => {
                    resolveFirst = resolve;
                });
            }
            secondSchemaShown();
            return Promise.resolve(undefined);
        });

        const enqueuePromise = enqueueSchemaReminders('conn-1', 'TestConn', ['first', 'second']);

        await jest.advanceTimersByTimeAsync(2 * 60 * 1000);

        expect(secondSchemaShown).toHaveBeenCalled();

        const firstTerminalCalls = mockSaveDescriptions.mock.calls.filter(
            (call: unknown[]) => {
                const data = call[2] as Record<string, unknown>;
                const reminder = data?.schemaDocumentationReminder as SchemaDocumentationReminderState | undefined;
                return (reminder?.state === 'dismissed' || reminder?.state === 'actioned') && data?.schemaName === 'first';
            }
        );
        expect(firstTerminalCalls).toHaveLength(0);

        if (resolveFirst) resolveFirst(undefined);
        await enqueuePromise;
    });

    test('late notification resolution does not overwrite a newer terminal state', async () => {
        // Simulates: prompt1 watchdog fires → cooldown expires → prompt2
        // resolves as dismissed → prompt1 resolves late → must NOT overwrite.
        const stateBySchema = new Map<string, SchemaDocumentationReminderState>();

        mockLoadDescriptions.mockImplementation(() => {
            const saved = stateBySchema.get('public');
            return Promise.resolve(makeDescriptionFile({}, saved ? { ...saved } : undefined));
        });
        mockSaveDescriptions.mockImplementation(async (_cid: string, _cn: string, data: Record<string, unknown>) => {
            const r = data?.schemaDocumentationReminder as SchemaDocumentationReminderState | undefined;
            if (r && data?.schemaName === 'public') stateBySchema.set('public', { ...r });
        });
        mockLoadSchemas.mockResolvedValue([makeIntrospection()]);

        // Round 1: notification never resolves, watchdog fires
        let resolveOldNotification: ((v: string | undefined) => void) | undefined;
        mockShowInformationMessage.mockImplementation(() => {
            return new Promise<string | undefined>(resolve => {
                resolveOldNotification = resolve;
            });
        });

        const round1 = enqueueSchemaReminders('conn-1', 'TestConn', ['public']);
        await jest.advanceTimersByTimeAsync(2 * 60 * 1000);
        await round1;

        // State should be 'prompted' (not terminal)
        expect(stateBySchema.get('public')?.state).toBe('prompted');
        const round1PromptedAt = stateBySchema.get('public')?.promptedAt;

        // Simulate cooldown expiry so the schema becomes eligible again
        const expiredTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
        stateBySchema.set('public', {
            state: 'prompted',
            promptedAt: expiredTime,
            dismissedAt: null,
            actionedAt: null,
        });

        // Round 2: new prompt resolves immediately as dismissed
        mockShowInformationMessage.mockResolvedValue("I'll do this later");

        await enqueueSchemaReminders('conn-1', 'TestConn', ['public']);

        expect(stateBySchema.get('public')?.state).toBe('dismissed');
        const dismissedAt = stateBySchema.get('public')?.dismissedAt;

        // Now the old notification resolves late with "Document Schema Now"
        resolveOldNotification!('Document Schema Now');
        // Flush the fire-and-forget microtask chain
        await jest.advanceTimersByTimeAsync(0);
        await Promise.resolve();
        await Promise.resolve();

        // The dismissed state must NOT be overwritten
        expect(stateBySchema.get('public')?.state).toBe('dismissed');
        expect(stateBySchema.get('public')?.dismissedAt).toBe(dismissedAt);
    });

    test('cancels watchdog when notification resolves', async () => {
        mockLoadDescriptions.mockImplementation(freshDescFactory());
        mockLoadSchemas.mockResolvedValue([makeIntrospection()]);
        mockShowInformationMessage.mockResolvedValue(undefined);

        await enqueueSchemaReminders('conn-1', 'TestConn', ['public']);

        expect(_getActiveItemForTesting()).toBeNull();
        expect(_getQueueForTesting()).toHaveLength(0);
    });
});

describe('activation scan', () => {
    test('scans existing undocumented schemas', async () => {
        mockLoadSchemas.mockResolvedValue([makeIntrospection()]);
        mockLoadDescriptions.mockImplementation(freshDescFactory());
        mockShowInformationMessage.mockResolvedValue(undefined);

        await scanExistingSchemas();

        expect(mockShowInformationMessage).toHaveBeenCalledWith(
            expect.stringContaining('TestConn.public'),
            'Document Schema Now',
            "I'll do this later"
        );
    });

    test('skips schemas with existing reminder state', async () => {
        mockLoadSchemas.mockResolvedValue([makeIntrospection()]);
        mockLoadDescriptions.mockImplementation(freshDescFactory({}, {
            state: 'dismissed',
            promptedAt: '2026-01-01T00:00:00.000Z',
            dismissedAt: '2026-01-01T00:01:00.000Z',
            actionedAt: null,
        }));

        await scanExistingSchemas();

        expect(mockShowInformationMessage).not.toHaveBeenCalled();
    });

    test('sorts activation scan by connection name then schema name', async () => {
        const calls: string[] = [];
        mockLoadSchemas.mockResolvedValue([
            makeIntrospection({
                connectionId: 'conn-2',
                connectionName: 'Bravo',
                schemas: [{ name: 'public', tables: [], views: [] }],
            }),
            makeIntrospection({
                connectionId: 'conn-1',
                connectionName: 'Alpha',
                schemas: [
                    { name: 'staging', tables: [], views: [] },
                    { name: 'public', tables: [], views: [] },
                ],
            }),
        ]);
        mockLoadDescriptions.mockImplementation(freshDescFactory());
        mockShowInformationMessage.mockImplementation(async (msg: string) => {
            calls.push(msg);
            return undefined;
        });

        await scanExistingSchemas();

        expect(calls).toHaveLength(3);
        expect(calls[0]).toContain('Alpha.public');
        expect(calls[1]).toContain('Alpha.staging');
        expect(calls[2]).toContain('Bravo.public');
    });
});

describe('enqueueFromIntrospectionResult', () => {
    test('enqueues eligible schemas from introspection result', async () => {
        const introspection = makeIntrospection();
        mockLoadDescriptions.mockImplementation(freshDescFactory());
        mockLoadSchemas.mockResolvedValue([introspection]);
        mockShowInformationMessage.mockResolvedValue(undefined);

        await enqueueFromIntrospectionResult(introspection);

        expect(mockShowInformationMessage).toHaveBeenCalledWith(
            expect.stringContaining('TestConn.public'),
            'Document Schema Now',
            "I'll do this later"
        );
    });
});

describe('description file write safety', () => {
    test('re-applies actioned state after generation if field was dropped', async () => {
        mockLoadDescriptions.mockImplementation(freshDescFactory());
        mockLoadSchemas.mockResolvedValue([makeIntrospection()]);
        mockShowInformationMessage.mockResolvedValue('Document Schema Now');
        mockExecuteCommand.mockResolvedValue(undefined);

        await enqueueSchemaReminders('conn-1', 'TestConn', ['public']);

        const actionedCalls = mockSaveDescriptions.mock.calls.filter(
            (call: unknown[]) => {
                const data = call[2] as Record<string, unknown>;
                const reminder = data?.schemaDocumentationReminder as SchemaDocumentationReminderState | undefined;
                return reminder?.state === 'actioned';
            }
        );
        expect(actionedCalls.length).toBeGreaterThanOrEqual(1);
    });
});

import * as vscode from 'vscode';
import { SchemaIntrospection } from '../../core/types';

jest.mock('../../ai/aiService', () => ({
    getConfiguredAIProvider: jest.fn(),
    openAiProviderSettings: jest.fn(),
}));
jest.mock('../../ai/broker', () => ({
    createFileEditingBrokerPrompt: jest.fn((prompt: string) => `wrapped:${prompt}`),
    maybeHandleBrokerTask: jest.fn(),
}));
jest.mock('../descriptionStore', () => ({
    loadDescriptions: jest.fn(),
    saveDescriptions: jest.fn(),
}));

const { generateDescriptionsWithAI } = require('../descriptionGenerator') as typeof import('../descriptionGenerator');
const { getConfiguredAIProvider } = require('../../ai/aiService') as { getConfiguredAIProvider: jest.Mock };
const { createFileEditingBrokerPrompt, maybeHandleBrokerTask } = require('../../ai/broker') as {
    createFileEditingBrokerPrompt: jest.Mock;
    maybeHandleBrokerTask: jest.Mock;
};
const { loadDescriptions, saveDescriptions } = require('../descriptionStore') as {
    loadDescriptions: jest.Mock;
    saveDescriptions: jest.Mock;
};

function makeIntrospection(): SchemaIntrospection {
    return {
        version: '0.2',
        generatedAt: '2026-08-19T12:00:00.000Z',
        connectionId: 'conn-1',
        connectionName: 'Analytics',
        dialect: 'postgres',
        schemas: [
            {
                name: 'public',
                tables: [
                    {
                        name: 'users',
                        columns: [
                            { name: 'id', type: 'integer' },
                            { name: 'email', type: 'text' },
                        ],
                    },
                ],
                views: [],
            },
        ],
    };
}

describe('generateDescriptionsWithAI', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (vscode.workspace as unknown as { workspaceFolders: vscode.WorkspaceFolder[] }).workspaceFolders = [
            { uri: vscode.Uri.file('/workspace'), name: 'workspace', index: 0 },
        ];
        (vscode.workspace as unknown as { getWorkspaceFolder?: jest.Mock }).getWorkspaceFolder = jest.fn(() => undefined);
        (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
            get: jest.fn((key: string, fallback: unknown) => {
                if (key === 'location') return 'workspace';
                if (key === 'userPath') return '~/.runql';
                if (key === 'codespacesPath') return '/workspaces/.runql';
                if (key === 'customPath') return '';
                if (key === 'workspaceFolder') return '';
                return fallback;
            }),
            has: jest.fn().mockReturnValue(true),
            inspect: jest.fn(),
            update: jest.fn(),
        }));
        (vscode.workspace.fs.createDirectory as jest.Mock).mockResolvedValue(undefined);
        (vscode.workspace.fs.stat as jest.Mock).mockRejectedValue(new Error('ENOENT'));
        (vscode.workspace.fs.readDirectory as jest.Mock).mockResolvedValue([]);
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);
        (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue({ uri: vscode.Uri.file('/workspace/RunQL/schemas/Analytics/public/description.json') });
        (vscode.window.showTextDocument as jest.Mock).mockResolvedValue(undefined);
        loadDescriptions.mockResolvedValue(null);
        saveDescriptions.mockResolvedValue(undefined);
        maybeHandleBrokerTask.mockResolvedValue({
            handled: true,
            providerId: 'claudeExtension',
            mode: 'handoff',
            status: 'userActionRequired',
        });
    });

    test('routes schema description generation through the AI extension broker before provider fallback', async () => {
        await generateDescriptionsWithAI({} as vscode.ExtensionContext, {
            introspection: makeIntrospection(),
            schemaModel: { name: 'public' },
        });

        expect(saveDescriptions).toHaveBeenCalledWith(
            'conn-1',
            'Analytics',
            expect.objectContaining({
                connectionId: 'conn-1',
                schemaName: 'public',
                tables: {},
                columns: {},
            }),
            'public'
        );
        expect(createFileEditingBrokerPrompt).toHaveBeenCalledWith(
            expect.stringContaining('"users"'),
            expect.objectContaining({
                workspaceRoot: '/workspace',
                targetFiles: ['/workspace/RunQL/schemas/Analytics/public/description.json'],
                primaryTarget: '/workspace/RunQL/schemas/Analytics/public/description.json',
                allowCommands: false,
            })
        );
        expect(maybeHandleBrokerTask).toHaveBeenCalledWith(expect.objectContaining({
            targetFiles: ['/workspace/RunQL/schemas/Analytics/public/description.json'],
            expectedWriteTargets: ['/workspace/RunQL/schemas/Analytics/public/description.json'],
            primaryTarget: '/workspace/RunQL/schemas/Analytics/public/description.json',
        }));
        expect(getConfiguredAIProvider).not.toHaveBeenCalled();
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalledWith(
            'No AI provider configured. Click Copy Prompt to paste it into your AI tool of choice.',
            'Open AI Settings',
            'Copy Prompt'
        );
    });
});

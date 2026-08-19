import * as vscode from 'vscode';
import { createFileEditingBrokerPrompt, maybeHandleBrokerTask, promptForDetectedAIExtension } from '../broker';

describe('broker file-editing handoff', () => {
    let configGet: jest.Mock;
    let configUpdate: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        configGet = jest.fn((key: string, fallback: unknown) => {
            if (key === 'ai.source') return 'aiExtension';
            if (key === 'ai.extension') return 'codexExtension';
            if (key === 'ai.installedExtensionChoice') return '';
            return fallback;
        });
        configUpdate = jest.fn().mockResolvedValue(undefined);
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
            get: configGet,
            update: configUpdate,
        });
        (vscode.workspace as unknown as { workspaceFolders: vscode.WorkspaceFolder[] }).workspaceFolders = [];
        (vscode as unknown as { extensions: { getExtension: jest.Mock } }).extensions = {
            getExtension: jest.fn((id: string) => id === 'openai.chatgpt' ? { id } : undefined),
        };
        (vscode.commands.getCommands as jest.Mock).mockResolvedValue([
            'chatgpt.implementTodo',
            'chatgpt.openSidebar',
            'chatgpt.newChat',
            'chatgpt.addFileToThread',
            'chatgpt.addToThread',
        ]);
        (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);
        (vscode.workspace.openTextDocument as jest.Mock).mockImplementation(async (uri: vscode.Uri) => ({ uri }));
        (vscode.window.showTextDocument as jest.Mock).mockResolvedValue({});
        (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue(undefined);
        (vscode.env.clipboard.writeText as jest.Mock).mockResolvedValue(undefined);
    });

    test('file-editing prompts require direct target file edits', () => {
        const prompt = createFileEditingBrokerPrompt('Update the docs.', {
            workspaceRoot: '/workspace',
            targetFiles: ['/workspace/query.md'],
            primaryTarget: '/workspace/query.md',
            allowCommands: false,
        });

        expect(prompt).toContain('Only modify these files:');
        expect(prompt).toContain('- /workspace/query.md');
        expect(prompt).toContain('Edit the target file directly. Do not return the full file content as a chat-only answer.');
        expect(prompt).toContain('After editing, respond with a short summary of the file changed.');
    });

    test('sends direct file-edit instructions to Codex through implementTodo when available', async () => {
        const result = await maybeHandleBrokerTask({
            title: 'Generate docs',
            prompt: 'Edit /workspace/query.md directly.',
            workspaceRoot: '/workspace',
            targetFiles: ['/workspace/query.md'],
            expectedWriteTargets: ['/workspace/query.md'],
            contextFiles: ['/workspace/query.sql'],
            primaryTarget: '/workspace/query.md',
            allowCommands: false,
        });

        expect(result).toEqual(expect.objectContaining({
            handled: true,
            providerId: 'codexExtension',
            status: 'userActionRequired',
            message: 'Direct file-edit instructions sent to Codex. Submit there to continue.',
        }));
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('chatgpt.implementTodo', {
            fileName: '/workspace/query.md',
            cwd: '/workspace',
            line: 1,
            comment: 'Edit /workspace/query.md directly.',
        });
        expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith('chatgpt.openSidebar');
        expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(vscode.Uri.file('/workspace/query.md'));
        expect(vscode.window.showTextDocument).toHaveBeenCalledWith(
            expect.objectContaining({ uri: vscode.Uri.file('/workspace/query.md') }),
            { preview: false, preserveFocus: false }
        );
        expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
    });

    test('falls back to clipboard for Codex without opening an instruction document', async () => {
        (vscode.commands.getCommands as jest.Mock).mockResolvedValue([
            'chatgpt.openSidebar',
            'chatgpt.addFileToThread',
        ]);

        const result = await maybeHandleBrokerTask({
            title: 'Generate docs',
            prompt: 'Edit /workspace/query.md directly.',
            workspaceRoot: '/workspace',
            targetFiles: ['/workspace/query.md'],
            expectedWriteTargets: ['/workspace/query.md'],
            primaryTarget: '/workspace/query.md',
            allowCommands: false,
        });

        expect(result?.message).toBe('Context attached to Codex. Direct file-edit instructions were copied to your clipboard; paste them into the Codex composer to continue.');
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('chatgpt.openSidebar');
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('chatgpt.addFileToThread', vscode.Uri.file('/workspace/query.md'));
        expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(vscode.Uri.file('/workspace/query.md'));
        expect(vscode.workspace.openTextDocument).not.toHaveBeenCalledWith(expect.objectContaining({
            content: expect.any(String),
        }));
        expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('Edit /workspace/query.md directly.');
    });

    test('prompts to configure Codex when the extension is detected', async () => {
        configGet.mockImplementation((key: string, fallback: unknown) => {
            if (key === 'ai.source') return 'githubCopilot';
            if (key === 'ai.extension') return '';
            if (key === 'ai.installedExtensionChoice') return '';
            return fallback;
        });
        (vscode.window.showInformationMessage as jest.Mock)
            .mockResolvedValueOnce('Use Codex for RunQL')
            .mockResolvedValue(undefined);
        const context = {
            globalState: {
                get: jest.fn().mockReturnValue(false),
                update: jest.fn().mockResolvedValue(undefined),
            },
        } as unknown as vscode.ExtensionContext;

        await promptForDetectedAIExtension(context);

        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
            expect.stringContaining('RunQL detected Codex'),
            'Use Codex for RunQL',
            'Ignore'
        );
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
            expect.stringContaining('RunQL will update settings automatically.'),
            'Use Codex for RunQL',
            'Ignore'
        );
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('RunQL AI configured for Codex.');
        expect(configUpdate).toHaveBeenCalledWith('ai.source', 'aiExtension', vscode.ConfigurationTarget.Global);
        expect(configUpdate).toHaveBeenCalledWith('ai.extension', 'codexExtension', vscode.ConfigurationTarget.Global);
        expect(configUpdate).toHaveBeenCalledWith('ai.installedExtensionChoice', 'codexExtension', vscode.ConfigurationTarget.Global);
        expect(context.globalState.update).toHaveBeenCalledWith('runql.ai.detectedExtensionPromptIgnored.v1', true);
    });

    test('maps the selected button correctly when Claude Code and Codex are both detected', async () => {
        configGet.mockImplementation((key: string, fallback: unknown) => {
            if (key === 'ai.source') return 'githubCopilot';
            if (key === 'ai.extension') return '';
            if (key === 'ai.installedExtensionChoice') return '';
            return fallback;
        });
        (vscode as unknown as { extensions: { getExtension: jest.Mock } }).extensions.getExtension
            .mockImplementation((id: string) => id === 'openai.chatgpt' || id === 'anthropic.claude-code' ? { id } : undefined);
        (vscode.window.showInformationMessage as jest.Mock)
            .mockResolvedValueOnce('Use Claude Code for RunQL')
            .mockResolvedValue(undefined);
        const context = {
            globalState: {
                get: jest.fn().mockReturnValue(false),
                update: jest.fn().mockResolvedValue(undefined),
            },
        } as unknown as vscode.ExtensionContext;

        await promptForDetectedAIExtension(context);

        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
            expect.stringContaining('RunQL detected Codex and Claude Code'),
            'Use Codex for RunQL',
            'Use Claude Code for RunQL',
            'Ignore'
        );
        expect(configUpdate).toHaveBeenCalledWith('ai.source', 'aiExtension', vscode.ConfigurationTarget.Global);
        expect(configUpdate).toHaveBeenCalledWith('ai.extension', 'claudeExtension', vscode.ConfigurationTarget.Global);
        expect(configUpdate).toHaveBeenCalledWith('ai.installedExtensionChoice', 'claudeExtension', vscode.ConfigurationTarget.Global);
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('RunQL AI configured for Claude Code.');
        expect(context.globalState.update).toHaveBeenCalledWith('runql.ai.detectedExtensionPromptIgnored.v1', true);
    });

    test('stores the ignore choice when the detected extension prompt is ignored', async () => {
        configGet.mockImplementation((key: string, fallback: unknown) => {
            if (key === 'ai.source') return 'githubCopilot';
            if (key === 'ai.extension') return '';
            if (key === 'ai.installedExtensionChoice') return '';
            return fallback;
        });
        (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Ignore');
        const context = {
            globalState: {
                get: jest.fn().mockReturnValue(false),
                update: jest.fn().mockResolvedValue(undefined),
            },
        } as unknown as vscode.ExtensionContext;

        await promptForDetectedAIExtension(context);

        expect(context.globalState.update).toHaveBeenCalledWith('runql.ai.detectedExtensionPromptIgnored.v1', true);
        expect(configUpdate).not.toHaveBeenCalled();
    });

    test('stores the handled choice when the detected extension prompt is dismissed', async () => {
        configGet.mockImplementation((key: string, fallback: unknown) => {
            if (key === 'ai.source') return 'githubCopilot';
            if (key === 'ai.extension') return '';
            if (key === 'ai.installedExtensionChoice') return '';
            return fallback;
        });
        (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue(undefined);
        const context = {
            globalState: {
                get: jest.fn().mockReturnValue(false),
                update: jest.fn().mockResolvedValue(undefined),
            },
        } as unknown as vscode.ExtensionContext;

        await promptForDetectedAIExtension(context);

        expect(context.globalState.update).toHaveBeenCalledWith('runql.ai.detectedExtensionPromptIgnored.v1', true);
        expect(configUpdate).not.toHaveBeenCalled();
    });

    test('does not prompt again after the detected extension prompt is ignored', async () => {
        const context = {
            globalState: {
                get: jest.fn().mockReturnValue(true),
                update: jest.fn().mockResolvedValue(undefined),
            },
        } as unknown as vscode.ExtensionContext;

        await promptForDetectedAIExtension(context);

        expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
        expect(configUpdate).not.toHaveBeenCalled();
    });

    test('marks the prompt handled when RunQL is already configured for an AI extension', async () => {
        const context = {
            globalState: {
                get: jest.fn().mockReturnValue(false),
                update: jest.fn().mockResolvedValue(undefined),
            },
        } as unknown as vscode.ExtensionContext;

        await promptForDetectedAIExtension(context);

        expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
        expect(configUpdate).not.toHaveBeenCalled();
        expect(context.globalState.update).toHaveBeenCalledWith('runql.ai.detectedExtensionPromptIgnored.v1', true);
    });
});

import * as vscode from 'vscode';
import { createFileEditingBrokerPrompt, maybeHandleBrokerTask } from '../broker';

describe('broker file-editing handoff', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
            get: jest.fn((key: string, fallback: unknown) => {
                if (key === 'ai.source') return 'aiExtension';
                if (key === 'ai.extension') return 'codexExtension';
                if (key === 'ai.installedExtensionChoice') return '';
                return fallback;
            }),
            update: jest.fn(),
        });
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
});

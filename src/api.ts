import * as vscode from 'vscode';
import { Duplex } from 'stream';
import { DbAdapter } from './connections/adapters/adapter';
import { ConnectionProfile, ConnectionSecrets, DPProviderActionHandler, DPProviderDescriptor } from './core/types';

export interface SshTunnelResult {
    stream: Duplex;
    close: () => void;
}

export interface RunQLExtensionApi {
    registerProvider(descriptor: DPProviderDescriptor): vscode.Disposable;
    registerAdapter(dialect: string, factory: () => DbAdapter): vscode.Disposable;
    registerProviderActionHandler(dialect: string, handler: DPProviderActionHandler): vscode.Disposable;
    getProviders(): DPProviderDescriptor[];

    // Profile access for connector extensions (e.g. SecureQL)
    getConnectionProfiles(): Promise<ConnectionProfile[]>;
    saveConnectionProfile(profile: ConnectionProfile): Promise<void>;
    getConnectionSecrets(id: string): Promise<ConnectionSecrets>;

    // SSH tunnel for connector extensions
    openSshTunnel(profile: ConnectionProfile, secrets: ConnectionSecrets): Promise<SshTunnelResult>;
}

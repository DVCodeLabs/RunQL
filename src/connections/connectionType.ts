import { ConnectionProfile, ConnectionType, DPConnectionFieldSchema, DPProviderDescriptor } from '../core/types';

const SSH_TUNNEL_FIELDS: DPConnectionFieldSchema[] = [
    { key: 'sshEnabled', label: 'Enable SSH Tunnel', type: 'checkbox', tab: 'ssh', storage: 'profile', defaultValue: false, width: 'full' },
    { key: 'sshHost', label: 'SSH Host', type: 'text', tab: 'ssh', storage: 'profile', required: true, placeholder: 'bastion.example.com', width: 'half', visibleWhen: { storage: 'profile', key: 'sshEnabled', truthy: true } },
    { key: 'sshPort', label: 'SSH Port', type: 'number', tab: 'ssh', storage: 'profile', required: true, defaultValue: 22, min: 1, max: 65535, width: 'half', visibleWhen: { storage: 'profile', key: 'sshEnabled', truthy: true } },
    { key: 'sshUsername', label: 'SSH Username', type: 'text', tab: 'ssh', storage: 'profile', required: true, width: 'full', visibleWhen: { storage: 'profile', key: 'sshEnabled', truthy: true } },
    {
        key: 'sshAuthMethod', label: 'SSH Auth Method', type: 'select', tab: 'ssh', storage: 'profile', required: true, defaultValue: 'password', width: 'full',
        options: [
            { value: 'password', label: 'Password' },
            { value: 'privateKey', label: 'Private Key' }
        ],
        visibleWhen: { storage: 'profile', key: 'sshEnabled', truthy: true }
    },
    { key: 'sshPassword', label: 'SSH Password', type: 'password', tab: 'ssh', storage: 'secrets', required: true, width: 'full', visibleWhen: { storage: 'profile', key: 'sshEnabled', truthy: true, and: [{ storage: 'profile', key: 'sshAuthMethod', equals: 'password' }] } },
    {
        key: 'sshPrivateKeyPath', label: 'SSH Private Key File', type: 'file', tab: 'ssh', storage: 'profile', width: 'full',
        placeholder: '~/.ssh/id_rsa',
        description: 'Path to your SSH private key file. Alternatively, paste the key contents below.',
        picker: { mode: 'open', title: 'Select SSH Private Key', openLabel: 'Select Key', canSelectFiles: true, canSelectFolders: false },
        visibleWhen: { storage: 'profile', key: 'sshEnabled', truthy: true, and: [{ storage: 'profile', key: 'sshAuthMethod', equals: 'privateKey' }] }
    },
    { key: 'sshPrivateKey', label: 'SSH Private Key (paste)', type: 'textarea', tab: 'ssh', storage: 'secrets', width: 'full', placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----', description: 'Paste your private key here if not using a file path above.', visibleWhen: { storage: 'profile', key: 'sshEnabled', truthy: true, and: [{ storage: 'profile', key: 'sshAuthMethod', equals: 'privateKey' }] } },
    { key: 'sshPrivateKeyPassphrase', label: 'SSH Key Passphrase', type: 'password', tab: 'ssh', storage: 'secrets', width: 'full', placeholder: 'Leave empty if key is not encrypted', visibleWhen: { storage: 'profile', key: 'sshEnabled', truthy: true, and: [{ storage: 'profile', key: 'sshAuthMethod', equals: 'privateKey' }] } },
];

export const STANDARD_CONNECTION_TYPE_FIELD: DPConnectionFieldSchema = {
    key: 'connectionType',
    label: 'Connection Type',
    type: 'radio',
    tab: 'connection',
    storage: 'profile',
    required: true,
    defaultValue: 'data_access',
    width: 'full',
    options: [
        {
            value: 'data_access',
            label: 'Data Access',
            description: 'A connection to your analytics or application database.',
        },
        {
            value: 'db_admin',
            label: 'DB Admin',
            description: 'A connection to your database server admin schemas. e.g. information_schema',
        },
    ],
};

export function normalizeConnectionType(value: unknown): ConnectionType {
    if (value === 'db_admin' || value === 'dbadmin') {
        return 'db_admin';
    }
    return 'data_access';
}

export function normalizeProfileConnectionType(profile: ConnectionProfile): ConnectionType {
    const normalized = normalizeConnectionType((profile as unknown as Record<string, unknown>).connectionType);
    profile.connectionType = normalized;
    return normalized;
}

export function isDbAdminConnection(profile: ConnectionProfile): boolean {
    return normalizeConnectionType(profile.connectionType) === 'db_admin';
}

export function formatConnectionTypeLabel(value: unknown): string {
    return normalizeConnectionType(value) === 'db_admin' ? 'DB Admin' : 'Data Access';
}

export function withSshTunnelSupport(descriptor: DPProviderDescriptor): DPProviderDescriptor {
    if (!descriptor.supports.sshTunnel) {
        return descriptor;
    }

    const fields = descriptor.formSchema.fields;
    if (fields.some((f) => f.key === 'sshEnabled')) {
        return descriptor;
    }

    return {
        ...descriptor,
        formSchema: {
            ...descriptor.formSchema,
            fields: [...fields, ...SSH_TUNNEL_FIELDS],
        },
    };
}

export function withStandardConnectionTypeSupport(descriptor: DPProviderDescriptor): DPProviderDescriptor {
    if (!descriptor.supports.dbAdminConnectionType) {
        return descriptor;
    }

    const fields = descriptor.formSchema.fields.map((field) => {
        if ((field.key === 'database' || field.key === 'schema') && !field.visibleWhen) {
            return {
                ...field,
                visibleWhen: { storage: 'profile' as const, key: 'connectionType', notEquals: 'db_admin' },
            };
        }
        return field;
    });

    if (!fields.some((field) => field.key === 'connectionType')) {
        const databaseIndex = fields.findIndex((field) => field.key === 'database' || field.key === 'schema');
        const portIndex = fields.findIndex((field) => field.key === 'port');
        const insertAt = databaseIndex >= 0 ? databaseIndex : portIndex >= 0 ? portIndex + 1 : fields.length;
        fields.splice(insertAt, 0, STANDARD_CONNECTION_TYPE_FIELD);
    }

    const reuse = descriptor.formSchema.reuse;
    const includeProfileKeys = Array.from(new Set([...(reuse?.includeProfileKeys ?? []), 'connectionType']));

    return {
        ...descriptor,
        formSchema: {
            ...descriptor.formSchema,
            fields,
            reuse: {
                ...reuse,
                includeProfileKeys,
            },
        },
    };
}

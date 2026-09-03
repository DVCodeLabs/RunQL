import { DPProviderDescriptor } from '../core/types';

export const BUILTIN_PROVIDERS: DPProviderDescriptor[] = [
    {
        providerId: 'secureql',
        displayName: 'SecureQL',
        dialect: 'secureql',
        formSchema: {
            fields: [
                {
                    key: 'secureqlBaseUrl',
                    label: 'SecureQL Base URL',
                    type: 'text',
                    tab: 'connection',
                    storage: 'profile',
                    required: true,
                    placeholder: 'https://api.secureql.company.com',
                    description: 'The base URL of your SecureQL server (e.g. localhost:3000 for dev).',
                    width: 'full',
                },
                {
                    key: 'credentialStorageMode',
                    label: 'Credential Storage',
                    type: 'select',
                    tab: 'connection',
                    storage: 'profile',
                    defaultValue: 'secretStorage',
                    options: [
                        { value: 'secretStorage', label: 'VS Code Secret Storage (Recommended)' },
                        { value: 'session', label: 'Session Only' },
                    ],
                    width: 'full',
                },
                {
                    key: 'apiKey',
                    label: 'API Key',
                    type: 'password',
                    tab: 'auth',
                    storage: 'secrets',
                    required: true,
                    placeholder: 'Paste your SecureQL API key',
                    description: 'Your SecureQL API key. Click "Validate API Key" after entering to auto-detect your connection.',
                    width: 'full',
                },
            ],
            actions: [
                {
                    id: 'validate-api-key',
                    label: 'Validate API Key',
                    tab: 'auth',
                    style: 'primary',
                    payloadKeys: ['secureqlBaseUrl', 'apiKey'],
                },
            ],
            reuse: {
                excludeSecretKeys: ['apiKey'],
                autoApplyWhenSingle: true,
            },
        },
        supports: {
            ssl: false,
            oauth: false,
            keypair: false,
            introspection: true,
            cancellation: false,
        },
    },
    {
        providerId: 'postgres',
        displayName: 'PostgreSQL',
        dialect: 'postgres',
        formSchema: {
            fields: [
                { key: 'host', label: 'Host', type: 'text', tab: 'connection', storage: 'profile', required: true, defaultValue: 'localhost', width: 'half' },
                { key: 'port', label: 'Port', type: 'number', tab: 'connection', storage: 'profile', required: true, defaultValue: 5432, width: 'half' },
                { key: 'database', label: 'Database / Catalog', type: 'text', tab: 'connection', storage: 'profile', required: true, width: 'full' },
                { key: 'ssl', label: 'Use SSL', type: 'checkbox', tab: 'connection', storage: 'profile', defaultValue: false, width: 'full' },
                {
                    key: 'sslMode',
                    label: 'SSL Mode',
                    type: 'select',
                    tab: 'connection',
                    storage: 'profile',
                    defaultValue: 'require',
                    options: [
                        { value: 'require', label: 'Require' },
                        { value: 'verify-ca', label: 'Verify CA' },
                        { value: 'verify-full', label: 'Verify Full' }
                    ],
                    visibleWhen: { storage: 'profile', key: 'ssl', truthy: true }
                },
                { key: 'username', label: 'Username', type: 'text', tab: 'auth', storage: 'profile', required: true, width: 'full' },
                { key: 'password', label: 'Password', type: 'password', tab: 'auth', storage: 'secrets', required: true, width: 'full' },
            ]
        },
        supports: { ssl: true, oauth: false, keypair: false, introspection: true, cancellation: true, dbAdminConnectionType: true, sshTunnel: true }
    },
    {
        providerId: 'mysql',
        displayName: 'MySQL',
        dialect: 'mysql',
        formSchema: {
            fields: [
                { key: 'host', label: 'Host', type: 'text', tab: 'connection', storage: 'profile', required: true, defaultValue: 'localhost', width: 'half' },
                { key: 'port', label: 'Port', type: 'number', tab: 'connection', storage: 'profile', required: true, defaultValue: 3306, width: 'half' },
                { key: 'ssl', label: 'Use SSL', type: 'checkbox', tab: 'connection', storage: 'profile', defaultValue: false, width: 'full' },
                {
                    key: 'sslMode',
                    label: 'SSL Mode',
                    type: 'select',
                    tab: 'connection',
                    storage: 'profile',
                    defaultValue: 'require',
                    options: [
                        { value: 'require', label: 'Require' },
                        { value: 'verify-ca', label: 'Verify CA' },
                        { value: 'verify-full', label: 'Verify Full' }
                    ],
                    visibleWhen: { storage: 'profile', key: 'ssl', truthy: true }
                },
                { key: 'username', label: 'Username', type: 'text', tab: 'auth', storage: 'profile', required: true, width: 'full' },
                { key: 'password', label: 'Password', type: 'password', tab: 'auth', storage: 'secrets', required: true, width: 'full' },
            ]
        },
        supports: { ssl: true, oauth: false, keypair: false, introspection: true, cancellation: true, dbAdminConnectionType: true, sshTunnel: true }
    },
    {
        providerId: 'mariadb',
        displayName: 'MariaDB',
        dialect: 'mariadb',
        formSchema: {
            fields: [
                { key: 'host', label: 'Host', type: 'text', tab: 'connection', storage: 'profile', required: true, defaultValue: 'localhost', width: 'half' },
                { key: 'port', label: 'Port', type: 'number', tab: 'connection', storage: 'profile', required: true, defaultValue: 3306, width: 'half' },
                { key: 'ssl', label: 'Use SSL', type: 'checkbox', tab: 'connection', storage: 'profile', defaultValue: false, width: 'full' },
                {
                    key: 'sslMode',
                    label: 'SSL Mode',
                    type: 'select',
                    tab: 'connection',
                    storage: 'profile',
                    defaultValue: 'require',
                    options: [
                        { value: 'require', label: 'Require' },
                        { value: 'verify-ca', label: 'Verify CA' },
                        { value: 'verify-full', label: 'Verify Full' }
                    ],
                    visibleWhen: { storage: 'profile', key: 'ssl', truthy: true }
                },
                { key: 'username', label: 'Username', type: 'text', tab: 'auth', storage: 'profile', required: true, width: 'full' },
                { key: 'password', label: 'Password', type: 'password', tab: 'auth', storage: 'secrets', required: true, width: 'full' },
            ]
        },
        supports: { ssl: true, oauth: false, keypair: false, introspection: true, cancellation: true, dbAdminConnectionType: true, sshTunnel: true }
    }
];

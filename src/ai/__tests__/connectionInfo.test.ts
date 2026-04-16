jest.mock('../../connections/connectionStore', () => ({
  loadConnectionProfiles: jest.fn(),
}));

import * as vscode from 'vscode';
import { loadConnectionProfiles } from '../../connections/connectionStore';
import { resolveConnectionInfo } from '../connectionInfo';
import { ConnectionProfile } from '../../core/types';

const mockedLoadConnectionProfiles = loadConnectionProfiles as jest.MockedFunction<typeof loadConnectionProfiles>;

const createProfile = (overrides: Partial<ConnectionProfile> = {}): ConnectionProfile => ({
  id: 'conn-1',
  name: 'SecureQL Warehouse',
  dialect: 'secureql',
  sqlDialect: 'postgres',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('resolveConnectionInfo', () => {
  beforeEach(() => {
    mockedLoadConnectionProfiles.mockResolvedValue([]);
  });

  it('returns the effective SQL dialect for secureql-backed connections', async () => {
    mockedLoadConnectionProfiles.mockResolvedValue([createProfile()]);

    const context = {
      workspaceState: {
        get: jest.fn((key: string) => {
          if (key === 'runql.docConnections.v1') {
            return { 'file:///test.sql': 'conn-1' };
          }
          return undefined;
        }),
      },
    } as unknown as vscode.ExtensionContext;

    const doc = {
      uri: { toString: () => 'file:///test.sql' },
    } as vscode.TextDocument;

    const result = await resolveConnectionInfo(context, doc);

    expect(result).toEqual({
      connectionId: 'conn-1',
      connectionName: 'SecureQL Warehouse',
      dialect: 'postgres',
    });
  });

  it('returns unknown when no matching connection exists', async () => {
    const context = {
      workspaceState: {
        get: jest.fn((key: string) => {
          if (key === 'runql.docConnections.v1') {
            return {};
          }
          return undefined;
        }),
      },
    } as unknown as vscode.ExtensionContext;

    const doc = {
      uri: { toString: () => 'file:///test.sql' },
    } as vscode.TextDocument;

    const result = await resolveConnectionInfo(context, doc);

    expect(result).toEqual({
      connectionId: undefined,
      connectionName: 'none',
      dialect: 'unknown',
    });
  });
});

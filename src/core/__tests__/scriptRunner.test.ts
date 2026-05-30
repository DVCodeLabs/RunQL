import { executeScript } from '../scriptRunner';
import { DbAdapter } from '../../connections/adapters/adapter';
import { ConnectionProfile, ConnectionSecrets, QueryResult } from '../types';
import { SplitStatement } from '../sqlSplitter';

const profile = {
    id: 'conn-1',
    name: 'SecureQL',
    dialect: 'secureql',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
} as ConnectionProfile;

const secrets: ConnectionSecrets = { apiKey: 'secret' };

function makeStatement(sql: string, index: number): SplitStatement {
    return {
        sql,
        startOffset: index,
        endOffset: index + sql.length,
    };
}

function makeAdapter(runQuery: jest.Mock): DbAdapter {
    return {
        dialect: 'secureql',
        testConnection: jest.fn(),
        runQuery,
        executeNonQuery: jest.fn(),
        introspectSchema: jest.fn(),
    };
}

describe('executeScript', () => {
    it('propagates SecureQL approval-required errors instead of converting them to script failures', async () => {
        const approvalError = Object.assign(new Error('Approval required'), {
            name: 'SecureQLApprovalRequiredError',
            statusCode: 202,
        });
        const runQuery = jest
            .fn<Promise<QueryResult>, [ConnectionProfile, ConnectionSecrets, string, { maxRows: number }]>()
            .mockResolvedValueOnce({
                columns: [],
                rows: [],
                rowCount: 1,
                elapsedMs: 1,
            })
            .mockRejectedValueOnce(approvalError);
        const adapter = makeAdapter(runQuery);

        await expect(
            executeScript(
                [
                    makeStatement('UPDATE audit SET touched = true', 0),
                    makeStatement('UPDATE users SET enabled = false WHERE id = 1', 32),
                ],
                adapter,
                profile,
                secrets,
                { maxRows: 100, bypassLimit: false },
            ),
        ).rejects.toBe(approvalError);
    });
});

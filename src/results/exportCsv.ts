
import * as vscode from 'vscode';
import { QueryResult } from '../core/types';

export async function exportToCsv(data: QueryResult): Promise<void> {
    if (!data || !data.rows || data.rows.length === 0) {
        vscode.window.showWarningMessage("No results to export.");
        return;
    }

    const uri = await vscode.window.showSaveDialog({
        filters: { 'CSV': ['csv'] },
        saveLabel: 'Export CSV'
    });

    if (!uri) return;

    try {
        const csvContent = convertToCsv(data);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(`\ufeff${csvContent}`, 'utf8'));
        vscode.window.showInformationMessage(`Exported ${data.rowCount} rows to CSV.`);
    } catch (e: unknown) {
        vscode.window.showErrorMessage(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}

function convertToCsv(data: QueryResult): string {
    const header = data.columns.map(c => `"${escapeCsv(c.name)}"`).join(',');
    const rows = data.rows.map(row => {
        // If objects:
        return data.columns.map(c => {
            const val = (row as Record<string, unknown>)[c.name];
            return `"${escapeCsv(val)}"`;
        }).join(',');
    });

    return [header, ...rows].join('\r\n');
}

function escapeCsv(val: unknown): string {
    if (val === null || val === undefined) return '';
    const s = formatCsvValue(val);
    return s.replace(/"/g, '""'); // escape double quotes
}

function formatCsvValue(val: unknown): string {
    if (typeof val === 'string') return val;
    if (typeof val === 'number' || typeof val === 'boolean' || typeof val === 'bigint') {
        return String(val);
    }
    if (!isJsonLikeValue(val)) {
        return String(val);
    }
    try {
        const json = JSON.stringify(val);
        return json === undefined ? String(val) : json;
    } catch {
        return String(val);
    }
}

function isJsonLikeValue(val: unknown): boolean {
    return Array.isArray(val) || Object.prototype.toString.call(val) === '[object Object]';
}

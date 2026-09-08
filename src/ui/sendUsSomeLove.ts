import * as vscode from 'vscode';

const DEFAULT_SEND_US_SOME_LOVE_URL = 'https://runql.com/receiving-some-love.html';

export function isSendUsSomeLoveEnabled(): boolean {
  const cfg = vscode.workspace.getConfiguration('runql.welcome');
  const enabled = cfg.get<boolean>('sendUsSomeLove', true);
  const rawUrl = cfg.get<string>('sendUsSomeLoveUrl', DEFAULT_SEND_US_SOME_LOVE_URL).trim();
  return enabled && rawUrl.length > 0;
}

export async function sendUsSomeLove(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('runql.welcome');
  const enabled = cfg.get<boolean>('sendUsSomeLove', true);
  const rawUrl = cfg.get<string>('sendUsSomeLoveUrl', DEFAULT_SEND_US_SOME_LOVE_URL).trim();

  if (!enabled || !rawUrl) {
    throw new Error('This button is disabled.');
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (_e: unknown) {
    throw new Error('The configured URL is invalid.');
  }

  const isLocalHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !isLocalHttp) {
    throw new Error('The configured URL must use HTTPS, except for localhost development.');
  }

  const response = await fetch(url.toString(), {
    method: 'POST',
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
}


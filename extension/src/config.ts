import * as vscode from 'vscode';

export interface AnvilConfig {
  trueforgeUrl: string;
  models: string[];
  mcpPort: number;
  mcpPublicHost: string;
  contextBudgetTokens: number;
  retries: number;
  iterationLimit: number;
}

export function getConfig(): AnvilConfig {
  const c = vscode.workspace.getConfiguration('anvil');
  return {
    trueforgeUrl: (c.get<string>('trueforgeUrl') ?? 'http://localhost:8790').replace(/\/$/, ''),
    models: (c.get<string[]>('models') ?? []).filter(Boolean),
    mcpPort: c.get<number>('mcpPort') ?? 7337,
    mcpPublicHost: c.get<string>('mcpPublicHost') ?? '127.0.0.1',
    contextBudgetTokens: c.get<number>('contextBudgetTokens') ?? 6000,
    retries: c.get<number>('retries') ?? 2,
    iterationLimit: c.get<number>('iterationLimit') ?? 60,
  };
}

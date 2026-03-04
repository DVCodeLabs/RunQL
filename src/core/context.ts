import * as vscode from "vscode";

export async function setHasActiveConnection(value: boolean): Promise<void> {
  await vscode.commands.executeCommand("setContext", "runql.hasActiveConnection", value);
}

export async function setHasActiveSchema(value: boolean): Promise<void> {
  await vscode.commands.executeCommand("setContext", "runql.hasActiveSchema", value);
}

export async function setHasSimilarQueries(value: boolean): Promise<void> {
  await vscode.commands.executeCommand("setContext", "runql.hasSimilarQueries", value);
}

export async function setCompareSourceSet(value: boolean): Promise<void> {
  await vscode.commands.executeCommand("setContext", "runql.compareSourceSet", value);
}

export async function setCompareSourceKind(value: string | undefined): Promise<void> {
  await vscode.commands.executeCommand("setContext", "runql.compareSourceKind", value ?? "");
}

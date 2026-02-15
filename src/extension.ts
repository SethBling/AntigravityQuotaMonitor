/**
 * Antigravity Quota Monitor — VSCode Extension entry point.
 *
 * Displays the selected model's quota usage in the status bar.
 * Provides commands to pick a model and force-refresh quota data.
 */

import * as vscode from 'vscode';
import { discoverProcess } from './processDiscovery';
import { findWorkingPort, fetchQuota } from './apiClient';
import { ModelQuota, ProcessInfo } from './types';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let statusBarItem: vscode.StatusBarItem;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let cachedModels: ModelQuota[] = [];
let selectedModelLabel: string | null = null;

// Cache the discovered API port + token to avoid re-probing every refresh
let cachedPort: number | null = null;
let cachedCsrfToken: string | null = null;

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------
export function activate(context: vscode.ExtensionContext): void {
    console.log('[QuotaMonitor] Activating...');

    // Create status bar item (right-aligned, medium priority)
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
    statusBarItem.command = 'antigravityQuota.selectModel';
    statusBarItem.tooltip = 'Click to select a different model';
    statusBarItem.text = '$(pulse) Quota: …';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('antigravityQuota.selectModel', showModelPicker),
        vscode.commands.registerCommand('antigravityQuota.refresh', () => refreshQuota(true))
    );

    // Start periodic refresh
    startRefreshTimer(context);

    // Listen for config changes to adjust interval
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('antigravityQuota.refreshIntervalSeconds')) {
                startRefreshTimer(context);
            }
        })
    );

    // Initial fetch
    refreshQuota(false);
}

export function deactivate(): void {
    if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = undefined;
    }
}

// ---------------------------------------------------------------------------
// Refresh timer
// ---------------------------------------------------------------------------
function startRefreshTimer(context: vscode.ExtensionContext): void {
    if (refreshTimer) {
        clearInterval(refreshTimer);
    }

    const config = vscode.workspace.getConfiguration('antigravityQuota');
    const intervalSec = config.get<number>('refreshIntervalSeconds', 120);

    refreshTimer = setInterval(() => refreshQuota(false), intervalSec * 1000);

    // Ensure the interval is cleaned up on deactivation
    context.subscriptions.push({ dispose: () => clearInterval(refreshTimer!) });
}

// ---------------------------------------------------------------------------
// Core refresh logic
// ---------------------------------------------------------------------------
async function refreshQuota(isManual: boolean): Promise<void> {
    try {
        // Re-discover if we don't have a cached port
        if (!cachedPort || !cachedCsrfToken) {
            statusBarItem.text = '$(sync~spin) Quota: connecting…';

            const procInfo = await discoverProcess();
            if (!procInfo) {
                statusBarItem.text = '$(error) Quota: no process';
                statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                if (isManual) {
                    vscode.window.showErrorMessage(
                        'Antigravity Quota Monitor: Could not find the language_server process. Is Antigravity running?'
                    );
                }
                return;
            }

            cachedCsrfToken = procInfo.csrfToken;

            // Find working port
            let workingPort = await findWorkingPort(procInfo.listeningPorts, procInfo.csrfToken);
            if (!workingPort && procInfo.extensionPort) {
                workingPort = procInfo.extensionPort; // fallback
            }
            if (!workingPort) {
                statusBarItem.text = '$(error) Quota: no port';
                statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                if (isManual) {
                    vscode.window.showErrorMessage(
                        'Antigravity Quota Monitor: Could not find a working API port.'
                    );
                }
                return;
            }

            cachedPort = workingPort;
        }

        // Fetch quota data
        statusBarItem.text = '$(sync~spin) Quota: fetching…';
        const response = await fetchQuota(cachedPort!, cachedCsrfToken!);

        if (!response) {
            // Invalidate cache — might need re-discovery next time
            cachedPort = null;
            cachedCsrfToken = null;
            statusBarItem.text = '$(warning) Quota: fetch failed';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            if (isManual) {
                vscode.window.showErrorMessage('Antigravity Quota Monitor: Failed to fetch quota data.');
            }
            return;
        }

        // Parse model configs
        const configs = response.userStatus?.cascadeModelConfigData?.clientModelConfigs ?? [];
        cachedModels = configs.map((cfg) => ({
            label: cfg.label ?? 'Unknown',
            remainingFraction: cfg.quotaInfo?.remainingFraction ?? null,
            resetTime: cfg.quotaInfo?.resetTime ?? '',
        }));

        // Auto-select first model if nothing is selected
        if (!selectedModelLabel && cachedModels.length > 0) {
            selectedModelLabel = cachedModels[0].label;
        }

        updateStatusBar();

        if (isManual) {
            vscode.window.showInformationMessage(
                `Antigravity Quota Monitor: Refreshed — ${cachedModels.length} model(s) found.`
            );
        }
    } catch (e: any) {
        console.error('[QuotaMonitor] Refresh error:', e);
        statusBarItem.text = '$(error) Quota: error';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    }
}

// ---------------------------------------------------------------------------
// Status bar rendering
// ---------------------------------------------------------------------------
function updateStatusBar(): void {
    const model = cachedModels.find((m) => m.label === selectedModelLabel);

    if (!model) {
        statusBarItem.text = '$(pulse) Quota: no data';
        statusBarItem.backgroundColor = undefined;
        return;
    }

    if (model.remainingFraction !== null) {
        const pct = Math.round(model.remainingFraction * 100);
        let icon: string;
        let bgColor: vscode.ThemeColor | undefined;

        if (pct > 50) {
            icon = '$(check)';
            bgColor = undefined; // default
        } else if (pct > 20) {
            icon = '$(warning)';
            bgColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else {
            icon = '$(error)';
            bgColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        }

        statusBarItem.text = `${icon} ${model.label}: ${pct}%`;
        statusBarItem.backgroundColor = bgColor;
    } else {
        statusBarItem.text = `$(pulse) ${model.label}: N/A`;
        statusBarItem.backgroundColor = undefined;
    }

    // Build a rich tooltip
    const resetInfo = model.resetTime
        ? `Resets: ${model.resetTime.substring(0, 16).replace('T', ' ')}`
        : '';
    statusBarItem.tooltip = `${model.label} quota — click to switch model\n${resetInfo}`;
}

// ---------------------------------------------------------------------------
// Model picker (QuickPick)
// ---------------------------------------------------------------------------
async function showModelPicker(): Promise<void> {
    if (cachedModels.length === 0) {
        const action = await vscode.window.showInformationMessage(
            'No quota data yet. Refresh now?',
            'Refresh'
        );
        if (action === 'Refresh') {
            await refreshQuota(true);
        }
        return;
    }

    // Build a map from display label -> original model label
    const labelMap = new Map<string, string>();

    const items: vscode.QuickPickItem[] = cachedModels.map((m) => {
        const pct = m.remainingFraction !== null ? `${Math.round(m.remainingFraction * 100)}%` : 'N/A';
        let icon: string;
        if (m.remainingFraction === null) {
            icon = '—';
        } else if (m.remainingFraction > 0.5) {
            icon = '🟢';
        } else if (m.remainingFraction > 0.2) {
            icon = '🟡';
        } else {
            icon = '🔴';
        }

        const resetInfo = m.resetTime
            ? `Resets: ${m.resetTime.substring(0, 16).replace('T', ' ')}`
            : '';

        const displayLabel = `${icon} ${m.label}`;
        labelMap.set(displayLabel, m.label);

        return {
            label: displayLabel,
            description: pct,
            detail: resetInfo,
            picked: m.label === selectedModelLabel,
        };
    });

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a model to display in the status bar',
        title: 'Antigravity Model Quota',
    });

    if (picked) {
        selectedModelLabel = labelMap.get(picked.label) ?? picked.label;
        updateStatusBar();
    }
}

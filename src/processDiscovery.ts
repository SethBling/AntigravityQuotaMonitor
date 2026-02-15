/**
 * Process discovery module — finds the Antigravity language_server process
 * and extracts credentials needed to call its local API.
 *
 * Ported from probe_quota.py: find_antigravity_process() + get_listening_ports()
 */

import { execFile } from 'child_process';
import { ProcessInfo } from './types';

/**
 * Run a PowerShell command and return its stdout.
 */
function runPowerShell(command: string, timeoutMs: number = 15000): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            'powershell',
            ['-NoProfile', '-Command', command],
            { timeout: timeoutMs },
            (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(`PowerShell failed: ${error.message} — ${stderr?.trim()}`));
                } else {
                    resolve(stdout.trim());
                }
            }
        );
    });
}

/**
 * Find the Antigravity language_server process via PowerShell.
 * Extracts the PID, CSRF token, and extension server port from command-line args.
 */
export async function findAntigravityProcess(): Promise<Omit<ProcessInfo, 'listeningPorts'> | null> {
    const psCmd =
        "Get-CimInstance Win32_Process " +
        "| Where-Object { $_.Name -like '*language_server*' } " +
        "| Select-Object ProcessId, CommandLine " +
        "| ConvertTo-Json";

    let stdout: string;
    try {
        stdout = await runPowerShell(psCmd);
    } catch (e: any) {
        console.error('[QuotaMonitor] Process discovery failed:', e.message);
        return null;
    }

    if (!stdout) {
        console.warn('[QuotaMonitor] No language_server process found');
        return null;
    }

    let data: any;
    try {
        data = JSON.parse(stdout);
    } catch {
        console.error('[QuotaMonitor] Failed to parse PowerShell JSON output');
        return null;
    }

    const processes: any[] = Array.isArray(data) ? data : [data];

    for (const proc of processes) {
        const pid: number = proc.ProcessId;
        const cmdline: string = proc.CommandLine ?? '';

        // Extract --extension_server_port
        const portMatch = cmdline.match(/--extension_server_port[=\s]+(\d+)/);
        const extensionPort = portMatch ? parseInt(portMatch[1], 10) : null;

        // Extract --csrf_token (or --csrf-token)
        const csrfMatch = cmdline.match(/--csrf[_-]token[=\s]+(\S+)/i);
        const csrfToken = csrfMatch ? csrfMatch[1] : null;

        if (csrfToken) {
            return { pid, csrfToken, extensionPort };
        }
    }

    console.error('[QuotaMonitor] Found language_server but could not extract CSRF token');
    return null;
}

/**
 * Find all TCP ports that the given PID is listening on.
 */
export async function getListeningPorts(pid: number): Promise<number[]> {
    const psCmd =
        `Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue ` +
        '| Select-Object -ExpandProperty LocalPort ' +
        '| Sort-Object -Unique';

    let stdout: string;
    try {
        stdout = await runPowerShell(psCmd, 5000);
    } catch (e: any) {
        console.error('[QuotaMonitor] Port listing failed:', e.message);
        return [];
    }

    const ports: number[] = [];
    for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (/^\d+$/.test(trimmed)) {
            ports.push(parseInt(trimmed, 10));
        }
    }

    return ports;
}

/**
 * Full discovery: find process + get its listening ports.
 */
export async function discoverProcess(): Promise<ProcessInfo | null> {
    const proc = await findAntigravityProcess();
    if (!proc) {
        return null;
    }

    const listeningPorts = await getListeningPorts(proc.pid);
    return { ...proc, listeningPorts };
}

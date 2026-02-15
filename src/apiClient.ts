/**
 * API client module — probes ports and fetches quota data from the
 * Antigravity language_server local HTTPS API.
 *
 * Ported from probe_quota.py: probe_port(), find_working_port(), fetch_quota()
 */

import * as https from 'https';
import { QuotaResponse } from './types';

/** Shared HTTPS agent that ignores self-signed certs on localhost. */
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

/**
 * Send a JSON POST request to a localhost HTTPS endpoint.
 */
function postJson(port: number, path: string, body: object, csrfToken: string, timeoutMs: number = 10000): Promise<{ status: number; data: string }> {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);

        const req = https.request(
            {
                hostname: '127.0.0.1',
                port,
                path,
                method: 'POST',
                agent: insecureAgent,
                timeout: timeoutMs,
                headers: {
                    'Content-Type': 'application/json',
                    'Connect-Protocol-Version': '1',
                    'X-Codeium-Csrf-Token': csrfToken,
                    'Content-Length': Buffer.byteLength(payload),
                },
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    resolve({
                        status: res.statusCode ?? 0,
                        data: Buffer.concat(chunks).toString('utf-8'),
                    });
                });
            }
        );

        req.on('error', (err) => reject(err));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`Request to port ${port} timed out`));
        });

        req.write(payload);
        req.end();
    });
}

/**
 * Probe a single port by sending a lightweight GetUnleashData request.
 * Returns true if the port responds with HTTP 200.
 */
export async function probePort(port: number, csrfToken: string): Promise<boolean> {
    try {
        const body = {
            context: {
                properties: {
                    devMode: 'false',
                    ide: 'antigravity',
                    language: 'UNSPECIFIED',
                },
            },
        };
        const result = await postJson(
            port,
            '/exa.language_server_pb.LanguageServerService/GetUnleashData',
            body,
            csrfToken,
            3000
        );
        return result.status === 200;
    } catch {
        return false;
    }
}

/**
 * Try each candidate port and return the first one that responds.
 */
export async function findWorkingPort(ports: number[], csrfToken: string): Promise<number | null> {
    for (const port of ports) {
        if (await probePort(port, csrfToken)) {
            return port;
        }
    }
    return null;
}

/**
 * Fetch quota data by calling the GetUserStatus endpoint.
 */
export async function fetchQuota(port: number, csrfToken: string): Promise<QuotaResponse | null> {
    try {
        const body = {
            metadata: {
                ideName: 'antigravity',
                extensionName: 'antigravity',
                locale: 'en',
            },
        };
        const result = await postJson(
            port,
            '/exa.language_server_pb.LanguageServerService/GetUserStatus',
            body,
            csrfToken,
            10000
        );

        if (result.status !== 200) {
            console.error(`[QuotaMonitor] GetUserStatus returned HTTP ${result.status}`);
            return null;
        }

        return JSON.parse(result.data) as QuotaResponse;
    } catch (e: any) {
        console.error('[QuotaMonitor] GetUserStatus failed:', e.message);
        return null;
    }
}

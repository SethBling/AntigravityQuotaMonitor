/**
 * TypeScript interfaces for the Antigravity Quota Monitor.
 */

/** Information about a discovered Antigravity language_server process. */
export interface ProcessInfo {
    pid: number;
    csrfToken: string;
    extensionPort: number | null;
    listeningPorts: number[];
}

/** Quota information for a single model. */
export interface ModelQuota {
    label: string;
    remainingFraction: number | null;
    resetTime: string;
}

/** Parsed shape of the GetUserStatus API response. */
export interface QuotaResponse {
    userStatus?: {
        name?: string;
        email?: string;
        planStatus?: {
            planInfo?: {
                planName?: string;
            };
            availablePromptCredits?: number;
            availableFlowCredits?: number;
        };
        cascadeModelConfigData?: {
            clientModelConfigs?: ClientModelConfig[];
        };
    };
}

/** A single model config entry from the API. */
export interface ClientModelConfig {
    label?: string;
    modelOrAlias?: {
        model?: string;
    };
    quotaInfo?: {
        remainingFraction?: number;
        resetTime?: string;
    };
}

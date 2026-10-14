import type { ClaustrumClientOptions } from '@cortexkit/claustrum-client';
/** Insula's window fields are open: plugins choose which limits they understand. */
export interface InsulaUsageWindow {
    usedPercent: number;
    rawUsedPercent?: number;
    resetsAt?: string;
    windowMinutes?: number;
    windowKind?: string;
    [field: string]: unknown;
}
export interface InsulaUsageEntry {
    provider: string;
    account?: string;
    fetchedAt?: string;
    source?: string;
    stale?: unknown;
    errorClass?: unknown;
    usage?: {
        primary?: InsulaUsageWindow;
        secondary?: InsulaUsageWindow;
        tertiary?: InsulaUsageWindow;
        extraRateWindows?: Array<{
            id?: string;
            title?: string;
            window?: InsulaUsageWindow;
        }>;
        [field: string]: unknown;
    };
    [field: string]: unknown;
}
export interface InsulaQuotaContext {
    /** Milliseconds since the epoch, parsed from the producer's fetchedAt. */
    fetchedAt: number;
    source?: string;
}
export interface InsulaQuotaOptions<Q> {
    provider: 'codex' | 'claude' | 'antigravity';
    /**
     * Set every converted window's reading time to context.fetchedAt, not poll
     * time. Return undefined for entries the plugin cannot use. Antigravity can
     * receive its own sidebar reading back from insula: accept it only from the
     * vault or when fetchedAt is newer than the plugin's last reading.
     */
    normalize: (entry: InsulaUsageEntry, context: InsulaQuotaContext) => Q | undefined;
}
/** Optional transport for custom scoped clients; getUsage must not retry refusals. */
export interface InsulaUsageTransport {
    connectionFile: string;
    getUsage(): Promise<unknown>;
}
/** Constructing this transport opens no connection; getUsage opens one per call. */
export declare function insulaUsageTransport(options: ClaustrumClientOptions & {
    connectionFile: string;
}): InsulaUsageTransport;
export declare class InsulaQuotaSource {
    #private;
    private readonly transport;
    private readonly key;
    constructor(transport: InsulaUsageTransport, key: string);
    refresh(now: number): Promise<void>;
    current(provider: string, accountId: string, now: number): {
        entry: InsulaUsageEntry;
        context: InsulaQuotaContext;
    } | undefined;
}
export declare function acquireInsulaQuotaSource(transport: InsulaUsageTransport, tokenPath: string): {
    source: InsulaQuotaSource;
    release(): void;
};

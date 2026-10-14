import { resolve } from 'node:path';
import { storeIdentity } from '@cortexkit/claustrum-client';
// A static import: claustrum-client already loads subc-client whenever
// /claustrum is imported, so loading it lazily saves nothing, and a dynamic
// import makes bundlers emit a separate chunk that a running host loses when
// its dist folder is rebuilt underneath it.
import { SubcClient } from '@cortexkit/subc-client';
/** Constructing this transport opens no connection; getUsage opens one per call. */
export function insulaUsageTransport(options) {
    const identity = options.identity ??
        storeIdentity(options.projectRoot ?? process.cwd(), options.storagePath ?? process.cwd());
    return {
        connectionFile: options.connectionFile,
        async getUsage() {
            let client;
            let expired = false;
            let timer;
            const timeout = new Promise((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error('insula usage timeout')), 3_000);
                timer.unref?.();
            });
            const request = (async () => {
                client = options.connector
                    ? await options.connector({
                        connectionFile: options.connectionFile,
                        handshakeTimeoutMs: Math.min(options.handshakeTimeoutMs ?? 3_000, 3_000),
                    })
                    : await SubcClient.connect({
                        connectionFile: options.connectionFile,
                        handshakeTimeoutMs: Math.min(options.handshakeTimeoutMs ?? 3_000, 3_000),
                    });
                // A slow connector may resolve after the whole-call deadline. It still
                // owns a socket, which must not survive or open a route after fallback.
                if (expired) {
                    client.close();
                    throw new Error('insula usage timeout');
                }
                // Managed call() retries warming routes. A single routeOpen/request
                // instead lets the plugin fall back as soon as the daemon refuses.
                const route = await client.routeOpen({ kind: 'management_surface', module_id: 'insula' }, identity);
                return await client.request(route, { method: 'usage.get', params: {} });
            })();
            try {
                return await Promise.race([request, timeout]);
            }
            finally {
                expired = true;
                clearTimeout(timer);
                client?.close();
            }
        },
    };
}
const MINUTE = 60_000;
const MAX_AGE = 4 * MINUTE;
const sources = new Map();
// Keep only the minute budget after the last owner closes, so project churn
// cannot reset the bound. Expired budgets are pruned on the next tick.
const attempts = new Map();
function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export class InsulaQuotaSource {
    transport;
    key;
    #entries = [];
    #pending;
    constructor(transport, key) {
        this.transport = transport;
        this.key = key;
    }
    refresh(now) {
        if (this.#pending)
            return this.#pending;
        for (const [key, time] of attempts) {
            if (now - time >= MINUTE)
                attempts.delete(key);
        }
        const lastAttempt = attempts.get(this.key);
        if (lastAttempt !== undefined && now - lastAttempt < MINUTE)
            return Promise.resolve();
        // Reserve the minute before I/O, so concurrent projects cannot each poll.
        attempts.set(this.key, now);
        this.#pending = (async () => {
            try {
                const reply = await this.transport.getUsage();
                if (!record(reply) ||
                    !Array.isArray(reply.result) ||
                    reply.error !== undefined)
                    throw new Error('unavailable insula usage');
                // Each response is a snapshot, not a delta. Missing accounts fall back;
                // neither pending nor the entry count asserts provider completeness.
                this.#entries = reply.result.filter((entry) => record(entry) && typeof entry.provider === 'string');
            }
            catch {
                // Refusal is absence, even if the previous reading was still young.
                this.#entries = [];
            }
        })().finally(() => {
            this.#pending = undefined;
        });
        return this.#pending;
    }
    current(provider, accountId, now) {
        for (const entry of this.#entries) {
            if (entry.provider !== provider ||
                typeof entry.account !== 'string' ||
                entry.account.trim() !== accountId)
                continue;
            if (entry.stale !== undefined ||
                entry.errorClass !== undefined ||
                !record(entry.usage))
                continue;
            const fetchedAt = typeof entry.fetchedAt === 'string'
                ? Date.parse(entry.fetchedAt)
                : Number.NaN;
            if (!Number.isFinite(fetchedAt) || now - fetchedAt >= MAX_AGE)
                continue;
            return {
                entry,
                context: {
                    fetchedAt,
                    ...(typeof entry.source === 'string' && { source: entry.source }),
                },
            };
        }
        return undefined;
    }
}
export function acquireInsulaQuotaSource(transport, tokenPath) {
    const key = JSON.stringify([
        resolve(transport.connectionFile),
        resolve(tokenPath),
    ]);
    let shared = sources.get(key);
    if (!shared) {
        shared = { source: new InsulaQuotaSource(transport, key), refs: 0 };
        sources.set(key, shared);
    }
    shared.refs++;
    let released = false;
    return {
        source: shared.source,
        release() {
            if (released)
                return;
            released = true;
            if (--shared.refs === 0)
                sources.delete(key);
        },
    };
}

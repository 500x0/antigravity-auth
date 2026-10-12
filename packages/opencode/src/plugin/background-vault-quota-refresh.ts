import { acquireFencedFileLock } from '@cortexkit/antigravity-auth-core/file-lock'
import { ensureSidebarStateDir, readSidebarState } from '../sidebar-state'
import {
  fetchVaultAccountQuota,
  type VaultQuotaCheckOptions,
  type VaultQuotaSource,
} from './quota'
import type { VaultAccountPool } from './shared/vault-request-credentials'
import { checkAndPublishVaultQuota } from './vault-quota-refresh'

export interface BackgroundVaultQuotaRefreshOptions {
  intervalMs: number
  sidebarStateFile: string
  readAuthority: () => Promise<'vault' | 'local' | 'unreadable'>
  currentVaultPool: () => Promise<{
    source: VaultQuotaSource
    pool: VaultAccountPool
  }>
  publishSidebar: () => Promise<void>
  transport: NonNullable<VaultQuotaCheckOptions['transport']>
  logger: VaultQuotaCheckOptions['logger']
  now?: () => number
  random?: () => number
  acquireLock?: typeof acquireFencedFileLock
}

/** Vault-only quota producer. No local account, token refresh or repository is opened. */
export class BackgroundVaultQuotaRefresh {
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight: Promise<void> | null = null
  private controller: AbortController | null = null
  private disposed = false
  private started = false
  private readonly now: () => number
  private readonly random: () => number
  private readonly acquireLock: typeof acquireFencedFileLock

  constructor(private readonly options: BackgroundVaultQuotaRefreshOptions) {
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
    this.acquireLock = options.acquireLock ?? acquireFencedFileLock
  }

  start(): void {
    if (this.disposed || this.started) return
    this.started = true
    this.schedule(Math.floor(this.random() * 30_000))
  }

  /** Custody notifications cancel admitted work as soon as authority changes. */
  abortTick(): void {
    this.controller?.abort()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.abortTick()
    await this.inFlight
  }

  private schedule(delay: number): void {
    if (this.disposed || !this.started) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick()
    }, delay)
    this.timer.unref?.()
  }

  /** One serialized tick; also used by deterministic composition tests. */
  tick(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.inFlight) return this.inFlight
    const controller = new AbortController()
    this.controller = controller
    let extraJitter = 0
    this.inFlight = this.runTick(controller)
      .catch(() => {
        // Filesystem, authority and transport errors fail closed until the next tick.
        extraJitter = 15_000
      })
      .finally(() => {
        this.inFlight = null
        this.controller = null
        this.schedule(
          this.options.intervalMs +
            Math.floor(this.random() * this.options.intervalMs * 0.1) +
            extraJitter,
        )
      })
    return this.inFlight
  }

  private async assertActive(controller: AbortController): Promise<void> {
    if (this.disposed || (await this.options.readAuthority()) !== 'vault')
      controller.abort()
    controller.signal.throwIfAborted()
  }

  private async runTick(controller: AbortController): Promise<void> {
    await this.assertActive(controller)
    ensureSidebarStateDir(this.options.sidebarStateFile)
    const lock = await this.acquireLock({
      path: this.options.sidebarStateFile,
      name: 'bg-vault-quota-poll',
      ttlMs: 60_000,
      renew: true,
    })
    if (!lock) return
    // Renewal lasts through quota commits and publication. Losing the fence cancels I/O.
    let released = false
    void lock.whenLost().then(() => {
      if (!released) controller.abort()
    })
    try {
      await this.assertActive(controller)
      await lock.assertOwned()
      // Re-read inside the fence: another process may have published while we waited.
      const age =
        this.now() - readSidebarState(this.options.sidebarStateFile).checkedAt
      const threshold = Math.max(
        this.options.intervalMs - 60_000,
        Math.floor(this.options.intervalMs / 2),
      )
      if (age < threshold) return
      const { source, pool } = await this.options.currentVaultPool()
      await this.assertActive(controller)
      await pool.sync()
      await this.assertActive(controller)
      await checkAndPublishVaultQuota(
        {
          pool,
          signal: controller.signal,
          now: this.now,
          fetchReading: async (ref, signal) => {
            await this.assertActive(controller)
            const reading = await fetchVaultAccountQuota({
              source,
              ref,
              signal,
              logger: this.options.logger,
              transport: async (url, init, extra) => {
                // Re-check just before every physical request, including retries/fallbacks.
                await this.assertActive(controller)
                await lock.assertOwned()
                controller.signal.throwIfAborted()
                return this.options.transport(
                  url,
                  { ...init, signal: extra.signal ?? controller.signal },
                  extra,
                )
              },
            })
            await this.assertActive(controller)
            await lock.assertOwned()
            return reading
          },
        },
        async () => {
          await this.assertActive(controller)
          await lock.assertOwned()
          await this.options.publishSidebar()
        },
      )
    } finally {
      released = true
      await lock.release().catch(() => {})
    }
  }
}

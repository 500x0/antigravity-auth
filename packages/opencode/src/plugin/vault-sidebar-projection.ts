import type { VaultProviderStateFile } from '@cortexkit/antigravity-auth-core'
import { buildSidebarMachineStateFromAccounts } from '../sidebar-state'
import {
  cachedQuotaOf,
  type VaultAccountPool,
} from './shared/vault-request-credentials'

/** OpenCode 1 sidebar projection reads durable quota, including another process's readings. */
export function buildVaultSidebarProjection(
  pool: Pick<VaultAccountPool, 'selector'>,
  state: VaultProviderStateFile,
  checkedAt = Date.now(),
) {
  const projection = buildSidebarMachineStateFromAccounts(
    pool.selector.rows.map((row) => {
      const stored = state.accounts[row.route.accountIdentity]
      const quota =
        stored?.observed.routeId === row.route.routeId &&
        stored.observed.credentialId === row.route.credentialId
          ? stored.quota
          : undefined
      return {
        index: row.index,
        email: row.route.email,
        enabled: row.enabled,
        current: false,
        coolingDownUntil: row.coolingDownUntil,
        healthScore: pool.selector.healthTracker.getScore(row.index),
        cachedQuota: quota ? cachedQuotaOf(quota) : undefined,
        cachedQuotaUpdatedAt: quota?.cachedQuotaUpdatedAt ?? undefined,
      }
    }),
    { checkedAt },
  )
  return {
    ...projection,
    accounts: projection.accounts.map((account) => ({
      ...account,
      id: `vault-${account.id}`,
    })),
  }
}

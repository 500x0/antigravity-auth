import type {
  VaultProviderStateFile,
  VaultRouteRef,
} from '@cortexkit/antigravity-auth-core'
import { buildSidebarMachineStateFromAccounts } from '../sidebar-state'
import {
  cachedQuotaOf,
  type VaultAccountPool,
} from './shared/vault-request-credentials'

/** Stored quota belongs to a row only while its account, route and credential still match. */
export function quotaReadingForVaultRoute(
  route: VaultRouteRef,
  state: VaultProviderStateFile,
) {
  const stored = state.accounts[route.accountIdentity]
  return stored?.observed.routeId === route.routeId &&
    stored.observed.credentialId === route.credentialId
    ? stored.quota
    : undefined
}

/** OpenCode 1 sidebar projection reads durable quota, including another process's readings. */
export function buildVaultSidebarProjection(
  pool: Pick<VaultAccountPool, 'selector'>,
  state: VaultProviderStateFile,
  checkedAt = Date.now(),
) {
  const projection = buildSidebarMachineStateFromAccounts(
    pool.selector.rows.map((row) => {
      const quota = quotaReadingForVaultRoute(row.route, state)
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

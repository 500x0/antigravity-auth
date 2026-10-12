import { checkVaultQuota } from './shared/vault-request-credentials'

/**
 * Manual and automatic checks publish only readings recorded against the vault
 * account, route, credential and served record version that produced the answer.
 */
export async function checkAndPublishVaultQuota(
  input: Parameters<typeof checkVaultQuota>[0],
  publishSidebar: () => Promise<void>,
): ReturnType<typeof checkVaultQuota> {
  const report = await checkVaultQuota(input)
  if (report.checked > 0 && !input.signal.aborted) await publishSidebar()
  return report
}

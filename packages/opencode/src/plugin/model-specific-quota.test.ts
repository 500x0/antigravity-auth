import { beforeEach, describe, expect, it } from 'bun:test'
import { AccountManager } from './accounts'
import type { OAuthAuthDetails } from './types'

describe('Model-specific Gemini quota', () => {
  let manager: AccountManager
  const auth: OAuthAuthDetails = {
    type: 'oauth',
    refresh: 'test-refresh',
    access: 'test-access',
    expires: Date.now() + 3600000,
  }

  beforeEach(() => {
    manager = new AccountManager(auth)
  })

  it('blocks only the specific Gemini model when markRateLimited is called with a model', () => {
    const account = manager.getCurrentAccountForFamily('gemini')!
    const modelPro = 'gemini-3.1-pro'
    const modelFlash = 'gemini-3-flash-agent'

    // Mark gemini-3.1-pro as rate limited on antigravity
    manager.markRateLimited(account, 60000, 'gemini', modelPro)

    // gemini-3.1-pro should be rate limited for antigravity
    expect(manager.isRateLimited(account, 'gemini', modelPro)).toBe(true)

    // gemini-3-flash-agent should NOT be rate limited for antigravity
    expect(manager.isRateLimited(account, 'gemini', modelFlash)).toBe(false)

    // General gemini (no model) should NOT be rate limited
    expect(manager.isRateLimited(account, 'gemini')).toBe(false)
  })

  it('returns null when quota is exhausted for the specific model on a single account', () => {
    const manager2 = new AccountManager(auth)

    const account = manager2.getCurrentAccountForFamily('gemini')!
    const modelPro = 'gemini-3.1-pro'
    const modelFlash = 'gemini-3-flash-agent'

    manager2.markRateLimited(account, 60000, 'gemini', modelPro)

    // No other account available, so returns null for the rate-limited model
    expect(manager2.getCurrentOrNextForFamily('gemini', modelPro)).toBeNull()

    // Flash should still return the same account since it's not rate-limited
    const flashAccount = manager2.getCurrentOrNextForFamily(
      'gemini',
      modelFlash,
    )
    expect(flashAccount).toBe(account)
  })

  it('base family rate limit blocks all models in that family', () => {
    const account = manager.getCurrentAccountForFamily('gemini')!
    const modelPro = 'gemini-3.1-pro'

    // Mark base gemini-antigravity as rate limited
    manager.markRateLimited(account, 60000, 'gemini')

    // All Gemini models should now be blocked for antigravity on this account
    expect(manager.isRateLimited(account, 'gemini', modelPro)).toBe(true)
    expect(
      manager.isRateLimited(account, 'gemini', 'gemini-3-flash-agent'),
    ).toBe(true)
  })
})

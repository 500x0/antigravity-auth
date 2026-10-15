import { afterEach, beforeAll, describe, expect, it } from 'bun:test'
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  admitPublicConsumer,
  PUBLIC_CONSUMER_ENV,
  requirePublicConsumerRoot,
} from './__fixtures__/common-auth-public-consumer.test.ts'
import { ACCOUNT_STATE_POLICY } from './account-repository.ts'
import {
  createProviderStateCodec,
  encodeProviderState,
} from './account-repository-codecs.ts'

let store: typeof import('./common-auth-embedded/store/index.js')
let quota: typeof import('./common-auth-embedded/quota/index.js')
let claustrum: typeof import('./common-auth-embedded/claustrum/index.js')
const roots: string[] = []

beforeAll(async () => {
  const root = requirePublicConsumerRoot(process.env[PUBLIC_CONSUMER_ENV])
  await admitPublicConsumer(root)
  // Import the archive's real ./claustrum export in the isolated consumer. Its
  // optional client imports need the same installed packages as the core adapter;
  // linking those dependencies does not substitute any common-auth payload.
  for (const name of [
    '@cortexkit/claustrum-client',
    '@cortexkit/subc-client',
  ]) {
    await symlink(
      dirname(dirname(Bun.resolveSync(name, import.meta.dir))),
      join(root, 'node_modules', name),
      'dir',
    )
  }
  await symlink(
    dirname(
      dirname(
        Bun.resolveSync(
          '@cortexkit/store',
          dirname(
            Bun.resolveSync('@cortexkit/claustrum-client', import.meta.dir),
          ),
        ),
      ),
    ),
    join(root, 'node_modules/@cortexkit/store'),
    'dir',
  )
  store = await import(
    pathToFileURL(Bun.resolveSync('@cortexkit/common-auth/store', root)).href
  )
  quota = await import(
    pathToFileURL(Bun.resolveSync('@cortexkit/common-auth/quota', root)).href
  )
  claustrum = await import(
    pathToFileURL(Bun.resolveSync('@cortexkit/common-auth/claustrum', root))
      .href
  )
})

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true })
})

async function directory() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'agy-quota-counters-')),
  )
  roots.push(root)
  return root
}

const limits = [
  {
    kind: 'reading' as const,
    scope: 'claude',
    label: 'weekly',
    checkedAt: 100,
    usedPercent: 25,
  },
]
const budget = {
  kind: 'reading',
  checkedAt: 100,
  reached: false,
  remaining: 7,
} as const
const antigravityQuota = {
  cachedQuotaUpdatedAt: 100,
  cachedQuota: { claude: { remainingFraction: 0.75, modelCount: 2 } },
  accountStamp: { synthetic: 'kept' },
}
const providerState = encodeProviderState({
  schemaVersion: 1,
  metadata: {
    addedAt: 1,
    lastUsed: 2,
    email: 'synthetic@example.test',
    projectId: 'synthetic-project',
    managedProjectId: 'synthetic-managed-project',
  },
})

async function poolWith(rawQuota: unknown) {
  const root = await directory()
  const configPath = join(root, 'config.json')
  const statePath = join(root, 'state.json')
  const pool = store.openPoolStore({
    provider: 'antigravity',
    configPath,
    statePath,
    quota: quota.quotaCodec,
    providerState: createProviderStateCodec(ACCOUNT_STATE_POLICY),
  })
  await pool.initialize()
  const added = await pool.add({
    id: 'synthetic-row',
    identity: 'synthetic@example.test',
    credential: {
      type: 'oauth',
      refresh: 'synthetic-refresh|synthetic-project|',
    },
    providerState,
  })
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  config.commonAuthPool.rows[added.id].quota = rawQuota
  await writeFile(configPath, JSON.stringify(config))
  return {
    pool,
    configPath,
    statePath,
    id: added.id,
    fence: {
      credentialEpoch: added.credentialEpoch,
      identity: 'synthetic@example.test',
    },
  }
}

describe('genuine public quota counters', () => {
  it('decodes counters independently and merges by each counter timestamp, not by sum or observation time', () => {
    expect(
      quota.decodeQuotaMap({
        limits,
        counters: {
          valid: { value: 0, checkedAt: 1 },
          nan: { value: Number.NaN, checkedAt: 2 },
          infinite: { value: 1, checkedAt: Number.POSITIVE_INFINITY },
          string: { value: '1', checkedAt: 3 },
        },
      }),
    ).toEqual({ limits, counters: { valid: { value: 0, checkedAt: 1 } } })
    expect(
      quota.decodeQuotaMap({
        limits,
        counters: { bad: { value: -1, checkedAt: 1 } },
      }),
    ).toEqual({ limits })
    expect(quota.decodeQuotaMap({ limits, counters: [] })).toEqual({ limits })
    expect(
      quota.decodeQuotaMap({
        limits: [{ broken: true }],
        counters: { valid: { value: 1, checkedAt: 1 } },
      }),
    ).toBeUndefined()
    const stored = {
      limits,
      budget,
      ...antigravityQuota,
      counters: {
        stale: { value: 8, checkedAt: 100 },
        tied: { value: 2, checkedAt: 100 },
        omitted: { value: 6, checkedAt: 100 },
      },
    }
    const before = structuredClone(stored)
    const merged = quota.mergeQuotaObservation(stored, {
      checkedAt: 999,
      counters: {
        stale: { value: 999, checkedAt: 99 },
        tied: { value: 3, checkedAt: 100 },
        newer: { value: 1, checkedAt: 101 },
      },
    })
    expect(merged).toEqual({
      limits,
      budget,
      ...antigravityQuota,
      counters: {
        stale: { value: 8, checkedAt: 100 },
        tied: { value: 3, checkedAt: 100 },
        omitted: { value: 6, checkedAt: 100 },
        newer: { value: 1, checkedAt: 101 },
      },
    })
    expect(stored).toEqual(before)
    expect(() =>
      quota.mergeQuotaObservation(stored, {
        checkedAt: 1000,
        counters: { bad: { value: -1, checkedAt: 1000 } },
      }),
    ).toThrow('quota observation is malformed')
  })

  it('absent counters preserve limits, budget and Antigravity metadata through a real store write', async () => {
    const initial = { limits, budget, ...antigravityQuota }
    const { pool, configPath, statePath, id, fence } = await poolWith(initial)
    const stateBefore = await readFile(statePath)
    const loaded = await pool.read()
    expect(loaded.status).toBe('ready')
    if (loaded.status !== 'ready') throw new Error('public pool did not load')
    expect(loaded.rows[0]?.quota).toEqual(initial)
    expect(loaded.rows[0]?.providerState).toEqual(providerState)
    await pool.recordQuota(id, fence, { checkedAt: 200 })
    const stored = JSON.parse(await readFile(configPath, 'utf8')).commonAuthPool
      .rows[id].quota
    expect(stored).toEqual(initial)
    expect(stored).not.toHaveProperty('counters')
    expect(await readFile(statePath)).toEqual(stateBefore)
  })

  it('recordQuota heals malformed stored counters instead of blocking the next real store write', async () => {
    const initial = {
      limits,
      budget,
      ...antigravityQuota,
      counters: {
        kept: { value: 3, checkedAt: 100 },
        negative: { value: -1, checkedAt: 100 },
        string: { value: '4', checkedAt: 100 },
        fractional: { value: 1.5, checkedAt: 100 },
      },
    }
    const { pool, configPath, statePath, id, fence } = await poolWith(initial)
    const configBefore = await readFile(configPath)
    const stateBefore = await readFile(statePath)
    const loaded = await pool.read()
    if (loaded.status !== 'ready') throw new Error('public pool did not load')
    expect(loaded.rows[0]?.quota).toEqual({
      limits,
      budget,
      ...antigravityQuota,
      counters: { kept: { value: 3, checkedAt: 100 } },
    })
    expect(await readFile(configPath)).toEqual(configBefore)
    await pool.recordQuota(id, fence, {
      checkedAt: 200,
      counters: { fresh: { value: 4, checkedAt: 200 } },
    })
    expect(
      JSON.parse(await readFile(configPath, 'utf8')).commonAuthPool.rows[id]
        .quota,
    ).toEqual({
      limits,
      budget,
      ...antigravityQuota,
      counters: {
        kept: { value: 3, checkedAt: 100 },
        fresh: { value: 4, checkedAt: 200 },
      },
    })
    expect(await readFile(statePath)).toEqual(stateBefore)
  })

  it.each([
    false,
    true,
  ])('public roster preserves quota and metadata with malformed counters=%s through a fenced write', async (malformed) => {
    const path = join(await directory(), 'roster.json')
    const counters = malformed
      ? {
          valid: { value: 2, checkedAt: 100 },
          invalid: { value: -1, checkedAt: 100 },
        }
      : undefined
    const row = {
      routeId: 'vault:synthetic',
      credentialId: 'synthetic-credential',
      credentialType: 'oauth' as const,
      accountIdentity: 'synthetic@example.test',
      state: 'active',
      label: 'Synthetic Antigravity',
      email: 'synthetic@example.test',
      enabled: true,
      addedAt: 1,
      quota: {
        limits,
        budget,
        ...antigravityQuota,
        ...(counters ? { counters } : {}),
      },
    }
    await writeFile(
      path,
      JSON.stringify({ version: 1, complete: true, rows: [row], declined: [] }),
    )
    const before = await readFile(path)
    const decoded = await claustrum.readVaultRoster(path)
    const expected = {
      limits,
      budget,
      ...antigravityQuota,
      ...(malformed
        ? { counters: { valid: { value: 2, checkedAt: 100 } } }
        : {}),
    }
    expect(decoded?.rows[0]).toEqual({ ...row, quota: expected })
    expect(await readFile(path)).toEqual(before)
    expect(
      await claustrum.recordVaultAccountQuota(path, {
        routeId: row.routeId,
        accountIdentity: row.accountIdentity,
        observation: { checkedAt: 200 },
      }),
    ).toBe(true)
    expect((await claustrum.readVaultRoster(path))?.rows[0]).toEqual({
      ...row,
      quota: expected,
    })
    const committed = await readFile(path)
    expect(
      await claustrum.recordVaultAccountQuota(path, {
        routeId: row.routeId,
        accountIdentity: 'different@example.test',
        observation: {
          checkedAt: 300,
          counters: { wrong: { value: 5, checkedAt: 300 } },
        },
      }),
    ).toBe(false)
    expect(await readFile(path)).toEqual(committed)
  })
})

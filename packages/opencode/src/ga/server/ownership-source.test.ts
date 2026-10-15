import { expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAccountRepositoryFactory,
  initializeFreshAccountStore,
  loadCommonAuthStoreModules,
  readAccountStoreAdmission,
} from '@cortexkit/antigravity-auth-core'
import { placeholderSecret } from '../../common-auth-embedded/opencode2/index.js'
import {
  createGaLocalRequestPipeline,
  createGaLocationServicesFactory,
  createGaRuntimeCollaborators,
} from '../../plugin/ga-location-services.ts'
import { createLocationRuntime } from '../../plugin/shared/runtime.ts'
import {
  createGaRawSender,
  type GaHttpRequestEvent,
  GaRequestOwnership,
  type GaSendInput,
  gaCatalogModels,
  rewriteGaHttpRequest,
  startGaLoopbackBridge,
} from './index.ts'

it('selects pool then approved vault under the same prepared placeholder through existing source seams', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ga-ownership-source-'))
  const previous = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = join(root, 'config')
  let mode: 'local' | 'custody' = 'local'
  let localCalls = 0
  let vaultAdmissions = 0
  const sends: GaSendInput[] = []
  const accounts: Parameters<
    typeof createGaLocalRequestPipeline
  >[0]['accounts'] = { current: null, quotaLogger: null }
  const directory = join(root, 'location')
  const legacyPath = join(directory, 'antigravity-accounts.json')
  const route = {
    routeId: 'vault-route',
    credentialId: 'vault-credential',
    accountIdentity: 'vault-identity',
    label: 'Vault account',
  }
  const factory = createGaLocationServicesFactory({
    loadStoreModules: loadCommonAuthStoreModules,
    resolveAccountFile: () => legacyPath,
    now: Date.now,
    runtime: (input) =>
      createGaRuntimeCollaborators({
        ...input,
        accounts,
        now: Date.now,
      }),
    createPipeline: async (input) => {
      const pipeline = await createGaLocalRequestPipeline({
        ...input,
        accounts,
      })
      return {
        ...pipeline,
        execute: async (job, context) => {
          localCalls++
          return pipeline.execute(job, context)
        },
      }
    },
    custody: () => ({
      readMode: async () => ({ ok: true, record: { version: 1, mode } }),
      custodySource: async () => ({
        refresh: async () => undefined,
        routes: () => [route],
        admit: async () => {
          vaultAdmissions++
          return {
            ...route,
            recordVersion: 1,
            accessToken: 'approved-vault-access',
            projectId: 'approved-vault-project',
            expiresAtMs: null,
          }
        },
        reportServedStatus: async () => false,
        attribution: () => ({ ...route, recordVersion: 1 }),
        commitState: async () => ({ status: 'unchanged' as const }),
        send: async () => {
          throw new Error('composed sender required')
        },
      }),
      readState: async () => ({ schemaVersion: 1, accounts: {} }),
      menuSection: () => ({
        id: 'vault',
        title: 'Vault',
        build: () => ({ lines: [], actions: [] }),
      }),
      dispose: async () => {},
    }),
  })
  let services: Awaited<ReturnType<typeof factory>> | undefined
  let runtime: Awaited<ReturnType<typeof createLocationRuntime>> | undefined
  let bridge: Awaited<ReturnType<typeof startGaLoopbackBridge>> | undefined
  try {
    mkdirSync(join(directory, '.opencode'), { recursive: true })
    writeFileSync(
      join(directory, '.opencode', 'antigravity.json'),
      JSON.stringify({
        background_quota_refresh: false,
        proactive_token_refresh: false,
        request_jitter_max_ms: 0,
      }),
    )
    const modules = await loadCommonAuthStoreModules()
    await initializeFreshAccountStore(modules, { legacyPath, now: Date.now })
    const admission = await readAccountStoreAdmission(
      legacyPath,
      modules,
      Date.now,
    )
    if (admission.status !== 'active') throw new Error(admission.status)
    const seed = createAccountRepositoryFactory(modules)({
      paths: admission.paths,
      now: Date.now,
      exchange: async () => {
        throw new Error('seed cannot refresh')
      },
    })
    try {
      await seed.login({
        id: crypto.randomUUID(),
        refreshToken: 'pool-refresh',
        metadata: { addedAt: 1, lastUsed: 1, managedProjectId: 'pool-project' },
      })
    } finally {
      await seed.dispose()
    }
    services = await factory({
      directory,
      overrides: {
        refreshAccessToken: async (refresh) => ({
          access: 'pool-access',
          refresh,
          expires: Date.now() + 3_600_000,
        }),
        send: async (input) => {
          sends.push(input)
          return new Response(
            'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"vault reply"}]},"finishReason":"STOP"}]}}\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          )
        },
      },
    })
    runtime = await createLocationRuntime({ ...services.runtime, directory })
    const serving = await services.start({
      runtime,
      generation: 'ownership-source',
      send: createGaRawSender(),
      notify: () => null,
      isConnected: () => false,
    })
    bridge = await startGaLoopbackBridge({
      execute: serving.execute,
      send: createGaRawSender(),
    })
    const ownership = new GaRequestOwnership()
    const catalog = gaCatalogModels()
    const dispatch = async (
      kind: GaHttpRequestEvent['kind'],
      modelID: string,
    ) => {
      const event: GaHttpRequestEvent = {
        sessionID: 'ses_source',
        kind,
        model: { id: modelID, providerID: 'google' },
        request: new Request(
          `https://generativelanguage.googleapis.com/v1beta/models/${modelID}:streamGenerateContent?alt=sse`,
          {
            method: 'POST',
            headers: { 'x-goog-api-key': placeholderSecret('google') },
            body: JSON.stringify({
              contents: [
                { role: 'user', parts: [{ text: 'source selection' }] },
              ],
            }),
          },
        ),
      }
      if (!bridge) throw new Error('bridge unavailable')
      await rewriteGaHttpRequest(event, {
        bridge,
        ownership,
        isRegisteredModel: (id) => catalog.has(id),
        env: {},
      })
      expect(event.request.url.startsWith(bridge.origin)).toBe(true)
      expect(event.request.headers.has('x-goog-api-key')).toBe(false)
      return fetch(event.request)
    }
    const pool = await dispatch('primary', 'antigravity-gemini-3.5-flash')
    expect(pool.status).toBe(200)
    await pool.text()
    expect(localCalls).toBe(1)
    expect(vaultAdmissions).toBe(0)
    expect(sends[0]?.auth.access).toBe('pool-access')
    expect(sends[0]?.envelope.project).toBe('pool-project')
    await accounts.current?.flushSaveToDisk()
    mode = 'custody'
    const vault = await dispatch('primary', 'antigravity-gemini-3.5-flash')
    expect(vault.status).toBe(200)
    expect(await vault.text()).toContain('vault reply')
    expect(localCalls).toBe(1)
    expect(vaultAdmissions).toBe(1)
    expect(sends[1]?.auth.access).toBe('approved-vault-access')
    expect(sends[1]?.envelope.project).toBe('approved-vault-project')
    expect(JSON.stringify(sends)).not.toContain(placeholderSecret('google'))

    const beforeRetired = sends.length
    const retired = await dispatch('generate', 'antigravity-gemini-3.1-pro')
    expect(retired.status).toBe(412)
    expect(await retired.json()).toEqual({
      error: {
        code: 412,
        status: 'FAILED_PRECONDITION',
        message:
          'This Antigravity model is no longer offered. Choose another model.',
      },
    })
    expect(sends).toHaveLength(beforeRetired)
    expect(vaultAdmissions).toBe(1)
    const title = await dispatch('title', 'antigravity-gemini-3.1-pro')
    expect(title.status).toBe(200)
    await title.text()
    expect(sends.at(-1)?.envelope.model).toBe('gemini-3.5-flash-extra-low')
    expect(sends.at(-1)?.kind).toBe('title')
  } finally {
    try {
      await bridge?.dispose()
      await runtime?.dispose()
      await services?.dispose()
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previous
      rmSync(root, { recursive: true, force: true })
    }
  }
})

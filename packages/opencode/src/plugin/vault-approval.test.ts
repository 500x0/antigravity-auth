import { describe, expect, it, mock, spyOn } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import * as core from '@cortexkit/antigravity-auth-core'
import {
  type AccountRepositoryRead,
  createAccountRepositoryFactory,
  initializeFreshAccountStore,
  loadCommonAuthStoreModules,
  readAccountStoreAdmission,
} from '@cortexkit/antigravity-auth-core'
import type { GaLocationServices, GaRawSender } from '../ga/server/index.ts'
import { createRpcClient } from '../rpc/rpc-client.ts'
import { startMenuVaultFixture } from './__fixtures__/vault-menu-daemon.test.ts'
import { createGaLocationServicesForHost } from './ga-location-services.ts'
import { createAntigravityPlugin } from './index.ts'
import { createOperatorSettingsRegistry } from './operator-settings.ts'
import { createLocationRuntime } from './shared/runtime.ts'
import { getStoragePath } from './storage.ts'
import type { PluginInput, Provider } from './types.ts'
import { createOpenCodeVaultCustody } from './vault-custody.ts'

const MODEL = 'gemini-3-flash'
const URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`
const BODY = JSON.stringify({
  contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
})

async function fixture() {
  const root = realpathSync(mkdtempSync('/tmp/opencode-live-approval-'))
  const daemon = await startMenuVaultFixture(root)
  const environment = {
    OPENCODE_CONFIG_DIR: join(root, 'config'),
    XDG_CONFIG_HOME: join(root, 'xdg'),
    ANTIGRAVITY_AUTH_RPC_DIR: join(root, 'rpc'),
    ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE: join(root, 'sidebar.json'),
    SUBC_CONNECTION_FILE: daemon.connectionFile,
    OPENCODE_DB: join(root, 'opencode.db'),
  }
  const prior = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  )
  Object.assign(process.env, environment)
  mkdirSync(join(root, '.opencode'), { mode: 0o700 })
  writeFileSync(
    join(root, '.opencode', 'antigravity.json'),
    JSON.stringify({
      background_quota_refresh: false,
      proactive_token_refresh: false,
      auto_update: false,
    }),
  )
  const nonLoopback: string[] = []
  const realFetch = globalThis.fetch
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      (async (input, init) => {
        const url = new globalThis.URL(
          input instanceof Request ? input.url : String(input),
        )
        if (url.hostname === '127.0.0.1') return realFetch(input, init)
        nonLoopback.push(url.href)
        return new Response('not-found', { status: 404 })
      }) as typeof fetch,
      { preconnect: realFetch.preconnect },
    ),
  )
  const accountFile = getStoragePath()
  const modules = await loadCommonAuthStoreModules()
  await initializeFreshAccountStore(modules, {
    legacyPath: accountFile,
    now: Date.now,
  })
  const admission = await readAccountStoreAdmission(
    accountFile,
    modules,
    Date.now,
  )
  if (admission.status !== 'active') throw new Error(admission.status)
  const repository = createAccountRepositoryFactory(modules)({
    paths: admission.paths,
    now: Date.now,
    exchange: async ({ refreshToken }) => ({
      refreshToken,
      accessToken: 'synthetic-local-access',
      expiresAt: Date.now() + 3_600_000,
    }),
  })
  const login = await repository.login({
    id: crypto.randomUUID(),
    refreshToken: 'synthetic-local-refresh',
    metadata: {
      addedAt: 1,
      lastUsed: 1,
      managedProjectId: 'synthetic-local-project',
    },
  })
  await repository.refresh(login.ref)
  const custodies: ReturnType<typeof createOpenCodeVaultCustody>[] = []
  const collector = () => {
    const custody = createOpenCodeVaultCustody({
      accountFile,
      readHostSlot: async () => undefined,
      reporterSource: 'direct',
      connectionFile: () => daemon.connectionFile,
    })
    custodies.push(custody)
    return custody
  }
  const sends: { authorization: string | null; body: string }[] = []
  const send = async (_url: string, init?: RequestInit) => {
    sends.push({
      authorization: new Headers(init?.headers).get('authorization'),
      body: String(init?.body),
    })
    return new Response(
      'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"done"}]},"finishReason":"STOP"}]}}\n\n',
      {
        headers: { 'content-type': 'text/event-stream' },
      },
    )
  }
  return {
    root,
    daemon,
    environment,
    repository,
    sends,
    send,
    collector,
    nonLoopback,
    async close() {
      await Promise.all(custodies.map((custody) => custody.dispose()))
      await repository.dispose()
      await daemon.close()
      fetchSpy.mockRestore()
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(root, { recursive: true, force: true })
    },
  }
}

async function waitUntil(check: () => Promise<boolean>) {
  const deadline = Date.now() + 4_000
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('No background approval notice')
    await Bun.sleep(20)
  }
}

function localCredentialUsage(read: AccountRepositoryRead) {
  if (read.status !== 'ready') throw new Error(read.status)
  return read.rows.map((row) => ({
    ref: row.ref,
    credential: row.credential,
    quota: row.quota,
    requests:
      row.metadata.status === 'present'
        ? row.metadata.metadata.dailyRequestCounts
        : undefined,
  }))
}

function assertVaultSend(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.sends).toHaveLength(2)
  expect(f.sends[0]?.authorization).toBe('Bearer synthetic-local-access')
  expect(f.sends[1]?.authorization).toBe('Bearer synthetic-vault-access')
  expect(f.sends[1]?.body).toContain('synthetic-vault-project')
  expect(f.sends[1]?.body).not.toContain('synthetic-local-project')
  expect(f.daemon.calls).toContain('credential.get_scoped')
  expect(f.daemon.errors).toEqual([])
}

describe('live enrollment switches the real OpenCode request paths', () => {
  for (const approval of ['background', 'external token'] as const) {
    it(`V1 ${approval} approval switches the next loaded request without local credentials`, async () => {
      const f = await fixture()
      let plugin:
        | Awaited<ReturnType<ReturnType<typeof createAntigravityPlugin>>>
        | undefined
      try {
        const auth = mock(async () => ({
          type: 'oauth' as const,
          refresh: 'synthetic-local-refresh',
          access: '',
          expires: 0,
        }))
        const client = {
          app: { log: mock(async () => {}) },
          auth: { set: mock(async () => {}) },
          session: {
            abort: mock(async () => {}),
            messages: mock(async () => ({ data: [] })),
            prompt: mock(async () => {}),
          },
          tui: { showToast: mock(async () => {}) },
        }
        plugin = await createAntigravityPlugin('google', {
          dependencies: { agyTransport: f.send },
        })({
          client,
          directory: f.root,
          worktree: f.root,
          project: {},
          serverUrl: new globalThis.URL('http://localhost:4096'),
          $: () => {},
        } as unknown as PluginInput)
        const provider = {
          id: 'google',
          name: 'Google',
          source: 'custom',
          env: [],
          options: {},
          models: {},
        } as Provider
        const loaded = await plugin.auth.loader(auth, provider)
        if (typeof loaded.fetch !== 'function')
          throw new Error('No loaded fetch')
        const request = () =>
          loaded.fetch?.(URL, {
            method: 'POST',
            body: BODY,
            headers: {
              'content-type': 'application/json',
              'x-session-id': 'approval-session',
            },
          }) as Promise<Response>
        expect(await (await request()).text()).toContain('done')
        // Local usage writes admitted by the first request must drain before
        // taking the snapshot used to detect writes from the later vault request.
        await Bun.sleep(1_100)
        const before = localCredentialUsage(await f.repository.read())
        expect(before[0]?.requests?.gemini).toBe(1)
        const networkBefore = f.nonLoopback.length
        const rpc = createRpcClient(
          f.environment.ANTIGRAVITY_AUTH_RPC_DIR,
          process.pid,
        )
        let noticeId = 0
        if (approval === 'background') {
          await expect(
            plugin['command.execute.before']?.(
              {
                command: 'antigravity',
                arguments: '',
                sessionID: 'approval-session',
              },
              { parts: [] },
            ),
          ).rejects.toThrow()
          const initial = await rpc.pendingNotifications(0, 'approval-session')
          expect(JSON.stringify(initial)).toContain('1 account')
          noticeId = Math.max(0, ...initial.map((entry) => entry.id))
          const pending = await rpc.apply({
            command: 'antigravity',
            sectionId: 'vault',
            actionId: 'request-access',
            sessionId: 'approval-session',
          })
          expect(pending).toMatchObject({ ok: true })
          expect(JSON.stringify(pending)).toContain(
            'waiting for operator approval',
          )
          f.daemon.approve()
          await waitUntil(async () =>
            (await rpc.pendingNotifications(noticeId, 'approval-session')).some(
              (entry) =>
                JSON.stringify(entry.payload).includes(
                  'Vault access: approved as antigravity-auth-opencode',
                ),
            ),
          )
          const notices = await rpc.pendingNotifications(
            noticeId,
            'approval-session',
          )
          expect(
            notices.filter((entry) =>
              JSON.stringify(entry.payload).includes(
                'Vault access: approved as antigravity-auth-opencode',
              ),
            ),
          ).toHaveLength(1)
          expect(
            await rpc.pendingNotifications(noticeId, 'other-session'),
          ).toEqual([])
        } else {
          // A separate consumer collects the ceremony and writes the real token
          // file while the already-loaded plugin continues to run locally.
          const collector = f.collector()
          expect((await collector.requestAccess()).state).toBe('pending')
          f.daemon.approve()
          expect((await collector.requestAccess()).state).toBe('approved')
        }
        const nativeReads = auth.mock.calls.length
        expect(await (await request()).text()).toContain('done')
        assertVaultSend(f)
        expect(auth.mock.calls.length).toBe(nativeReads)
        expect(f.nonLoopback.slice(networkBefore)).toEqual([])
        expect(localCredentialUsage(await f.repository.read())).toEqual(before)
        expect(client.auth.set).not.toHaveBeenCalled()
        if (approval === 'background') {
          await Bun.sleep(2_100)
          const notices = await rpc.pendingNotifications(
            noticeId,
            'approval-session',
          )
          expect(
            notices.filter((entry) =>
              JSON.stringify(entry.payload).includes(
                'Vault access: approved as antigravity-auth-opencode',
              ),
            ),
          ).toHaveLength(1)
        }
      } finally {
        await plugin?.dispose?.()
        await f.close()
      }
    }, 15_000)

    it(`GA ${approval} approval switches the next location request without local credentials`, async () => {
      const f = await fixture()
      let services: GaLocationServices | undefined
      let runtime: Awaited<ReturnType<typeof createLocationRuntime>> | undefined
      const transport = spyOn(
        core,
        'fetchWithAgyCliTransport',
      ).mockImplementation(f.send)
      try {
        const refreshes: string[] = []
        const nativeReads: string[] = []
        services = await createGaLocationServicesForHost({
          readHostSlot: async () => {
            nativeReads.push('native')
            return undefined
          },
          connectionFile: () => f.daemon.connectionFile,
        })({
          directory: f.root,
          overrides: {
            refreshAccessToken: async (refreshToken) => {
              refreshes.push(refreshToken)
              return {
                refresh: refreshToken,
                access: 'synthetic-local-access',
                expires: Date.now() + 3_600_000,
              }
            },
          },
        })
        runtime = await createLocationRuntime({
          ...services.runtime,
          directory: f.root,
          operatorSettingsRegistry: createOperatorSettingsRegistry(),
        })
        const send: GaRawSender = (input) =>
          f.send(input.endpoint, {
            headers: { authorization: `Bearer ${input.auth.access}` },
            body: JSON.stringify(input.envelope),
          })
        const notices: { scope: unknown; message: string }[] = []
        const serving = await services.start({
          runtime,
          generation: 'live-approval',
          send,
          notify: (scope, entry) => {
            if ('notify' in entry && entry.notify)
              notices.push({ scope, message: entry.notify.message })
            return null
          },
          isConnected: () => true,
        })
        const signal = new AbortController().signal
        const scope = {
          kind: 'session',
          sessionID: 'approval-session',
        } as const
        const request = () =>
          serving.execute(
            {
              sessionID: 'approval-session',
              parentSessionID: null,
              kind: 'generate',
              modelID: MODEL,
              variant: null,
              url: URL,
              body: BODY,
            },
            { signal, send },
          )
        expect(await (await request()).text()).toContain('done')
        await Bun.sleep(1_100)
        await runtime.accounts()?.saveToDisk()
        const before = localCredentialUsage(await f.repository.read())
        expect(before[0]?.requests?.gemini).toBe(1)
        if (approval === 'background') {
          await serving.commands.open({ scope, signal })
          const pending = await serving.commands.apply({
            request: {
              command: 'antigravity',
              sectionId: 'vault',
              actionId: 'request-access',
            },
            scope,
            signal,
          })
          expect(pending).toMatchObject({ ok: true })
          expect(pending.text).toContain('waiting for operator approval')
          f.daemon.approve()
          await waitUntil(async () =>
            notices.some((entry) =>
              entry.message.includes('approved as antigravity-auth-opencode'),
            ),
          )
          expect(
            notices.filter((entry) =>
              entry.message.includes('approved as antigravity-auth-opencode'),
            ),
          ).toEqual([
            {
              scope,
              message: 'Vault access: approved as antigravity-auth-opencode',
            },
          ])
        } else {
          const collector = f.collector()
          expect((await collector.requestAccess()).state).toBe('pending')
          f.daemon.approve()
          expect((await collector.requestAccess()).state).toBe('approved')
        }
        const priorRefreshes = refreshes.length
        const priorNativeReads = nativeReads.length
        const networkBefore = f.nonLoopback.length
        expect(await (await request()).text()).toContain('done')
        assertVaultSend(f)
        expect(refreshes.length).toBe(priorRefreshes)
        expect(nativeReads.length).toBe(priorNativeReads)
        expect(f.nonLoopback.slice(networkBefore)).toEqual([])
        expect(localCredentialUsage(await f.repository.read())).toEqual(before)
      } finally {
        await runtime?.accounts()?.saveToDisk()
        await services?.dispose()
        await runtime?.dispose()
        transport.mockRestore()
        await f.close()
      }
    }, 15_000)
  }
})

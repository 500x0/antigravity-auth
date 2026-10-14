import { lstat, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  ANTIGRAVITY_PROVIDER_ID,
  getPiAntigravityVaultDir,
  getPiConfigDir,
  loadCommonAuthClaustrum,
  loadCommonAuthFs,
  loadCommonAuthPiSlot,
  resolveClaustrumConnectionPath,
} from '@cortexkit/antigravity-auth-core'
import type { CliDependencies } from './cli.ts'
import {
  assertHostsStopped,
  createProcessFence,
  runSetup,
  type SetupHost,
  type SetupIO,
  type SetupPlugin,
} from './common-auth-embedded/setup/index.js'
import type { AntigravityTokenExchangeSuccess } from './plugin/oauth-login.ts'
import { getStoragePath } from './plugin/storage.ts'
import { nativeOpenCodeAuthPath } from './plugin/vault-activation.ts'
import {
  OPENCODE_VAULT_ENROLLMENT_NAME,
  OPENCODE_VAULT_PROVIDER,
  openCodeVaultPaths,
} from './plugin/vault-custody.ts'

const PI_PLACEHOLDER_KEY = 'antigravity-vault-custody'

function nativeAuthPath(host: SetupHost): string {
  return host === 'opencode'
    ? nativeOpenCodeAuthPath()
    : join(getPiConfigDir(), 'auth.json')
}

function provider(host: SetupHost): string {
  return host === 'opencode' ? OPENCODE_VAULT_PROVIDER : ANTIGRAVITY_PROVIDER_ID
}

async function nativeAuth(host: SetupHost): Promise<Record<string, unknown>> {
  const path = nativeAuthPath(host)
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.nlink !== 1)
      throw new Error('Native auth must be a regular, unaliased file.')
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Native auth is invalid; refusing to replace it.')
    return value as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

export async function assertSetupHostsStopped(): Promise<void> {
  await assertHostsStopped(createProcessFence(), process.env)
}

async function writeNativeSlot(
  host: SetupHost,
  slot: unknown,
  expectedAuthority: 'local' | 'vault' = 'local',
): Promise<void> {
  const before = await nativeAuth(host)
  const key = provider(host)
  if (JSON.stringify(before[key]) === JSON.stringify(slot)) return
  const fs = await loadCommonAuthFs()
  await fs.writeJsonAtomic(
    nativeAuthPath(host),
    { ...before, [key]: slot },
    {
      beforeRename: async () => {
        await assertSetupHostsStopped()
        const claustrum = await loadCommonAuthClaustrum()
        const stateDir =
          host === 'opencode'
            ? openCodeVaultPaths(resolve(getStoragePath())).dir
            : getPiAntigravityVaultDir()
        if (
          (await claustrum.enrollmentAuthority(
            claustrum.hostEnrollmentPaths({ stateDir, host }),
            `antigravity-auth-${host}`,
          )) !== expectedAuthority
        )
          throw new Error(
            'Vault enrollment changed during setup; native auth was not replaced.',
          )
        if (JSON.stringify(await nativeAuth(host)) !== JSON.stringify(before))
          throw new Error(
            'Native auth changed during setup; rerun with hosts stopped.',
          )
      },
    },
  )
}

/** Pi stores its local login in auth.json, not OpenCode's account pool. */
export async function persistPiSetupLogin(
  result: AntigravityTokenExchangeSuccess,
): Promise<void> {
  await writeNativeSlot('pi', {
    type: 'oauth',
    refresh: result.refresh,
    access: result.access,
    expires: result.expires,
  })
}

export async function createSetupPlugin(
  deps: CliDependencies,
  migrateOpenCode: () => Promise<number>,
  forceLogin = false,
): Promise<SetupPlugin> {
  const claustrum = await loadCommonAuthClaustrum()
  const opencode = openCodeVaultPaths(resolve(getStoragePath()))
  const piDir = getPiAntigravityVaultDir()
  const hosts = {
    opencode: {
      name: OPENCODE_VAULT_ENROLLMENT_NAME,
      paths: { stateDir: opencode.dir, host: 'opencode' },
    },
    pi: {
      name: 'antigravity-auth-pi',
      paths: { stateDir: piDir, host: 'pi' },
    },
  }
  const authority = (host: SetupHost) =>
    claustrum.enrollmentAuthority(
      claustrum.hostEnrollmentPaths(hosts[host].paths),
      hosts[host].name,
    )
  const assertLocal = async (host: SetupHost) => {
    if ((await authority(host)) !== 'local')
      throw new Error(
        'Vault enrollment excludes local sign-in. Resolve vault access before choosing local setup.',
      )
    claustrum.assertHostSlotMatchesMode({
      mode: 'local',
      auth: (await nativeAuth(host))[provider(host)],
      provider: provider(host),
    })
    if (host === 'pi') {
      const { openPiSlot } = await loadCommonAuthPiSlot()
      if (
        (
          await openPiSlot({
            authPath: nativeAuthPath(host),
            stashPath: join(piDir, 'google-login-stash.json'),
            provider: ANTIGRAVITY_PROVIDER_ID,
            placeholderKey: PI_PLACEHOLDER_KEY,
          }).inspect()
        ).slot === 'placeholder'
      )
        throw new Error(
          'Pi holds the vault marker, not a local login. Restore its saved login before local setup.',
        )
    }
  }
  let openCodeLogin: AntigravityTokenExchangeSuccess | undefined
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string }
  return {
    packages: {
      opencode: '@cortexkit/opencode-antigravity-auth',
      pi: '@cortexkit/pi-antigravity-auth',
    },
    version: manifest.version,
    displayName: 'Antigravity',
    slashCommand: '/antigravity',
    vault: { connectionFile: await resolveClaustrumConnectionPath(), hosts },
    signInLocal: async (host) => {
      await assertLocal(host)
      const slot = (await nativeAuth(host))[provider(host)]
      const source =
        host === 'opencode'
          ? await deps.accountStore.read(deps.accountStore.legacyPath())
          : undefined
      if (source?.kind === 'unavailable') throw new Error(source.reason)
      const accounts =
        source?.kind === 'store'
          ? source.accounts
          : source?.kind === 'legacy'
            ? ((await deps.loadAccounts())?.accounts ?? [])
            : []
      if (
        !forceLogin &&
        (host === 'pi'
          ? claustrum.classifyHostSlot(slot, provider(host)) === 'login'
          : accounts.length > 0)
      ) {
        deps.stdout.write(
          `Using existing local Antigravity login for ${host}.\n`,
        )
        if (
          host === 'opencode' &&
          claustrum.classifyHostSlot(slot, provider(host)) !== 'login'
        ) {
          const account = accounts[0]!
          await writeNativeSlot(host, {
            type: 'oauth',
            access: '',
            expires: 0,
            refresh: [
              account.refreshToken,
              account.projectId ?? '',
              account.managedProjectId ?? '',
            ].join('|'),
          })
        }
        return
      }
      const result = await deps.performLogin(
        {
          noBrowser: false,
          isHeadless: deps.isHeadless?.() ?? false,
          accounts: [],
          startFresh: false,
        },
        deps.openBrowser,
        host,
      )
      if (host === 'opencode') openCodeLogin = result
    },
    beforeRegister: async (host, mode) => {
      if (mode === 'local') {
        await assertLocal(host)
        if (host === 'opencode' && openCodeLogin)
          await writeNativeSlot(host, {
            type: 'oauth',
            refresh: openCodeLogin.refresh,
            access: openCodeLogin.access,
            expires: openCodeLogin.expires,
          })
        return
      }
      if ((await authority(host)) !== 'vault')
        throw new Error('Vault access must be approved before activation.')
      if (host === 'opencode') {
        const slot = (await nativeAuth(host))[provider(host)]
        claustrum.assertHostSlotMatchesMode({
          mode: 'custody',
          auth: slot,
          provider: provider(host),
        })
        await writeNativeSlot(
          host,
          claustrum.custodyPlaceholder(provider(host)),
          'vault',
        )
      } else {
        // Pi's existing slot editor moves the original login to its private stash.
        // Serving sees only the non-secret marker, never simultaneous local/vault credentials.
        const { openPiSlot } = await loadCommonAuthPiSlot()
        await assertSetupHostsStopped()
        await openPiSlot({
          authPath: nativeAuthPath(host),
          stashPath: join(piDir, 'google-login-stash.json'),
          provider: ANTIGRAVITY_PROVIDER_ID,
          placeholderKey: PI_PLACEHOLDER_KEY,
        }).enterVault()
      }
    },
    migrate: async (host) => {
      if (host === 'opencode') {
        // Vault activation must not import dormant local credentials into a store.
        const current = await authority(host)
        if (current === 'vault') return
        if (current === 'unreadable')
          throw new Error(
            'Vault enrollment is unreadable; account migration was not started.',
          )
        const source = await deps.accountStore.read(
          deps.accountStore.legacyPath(),
        )
        if (source.kind === 'unavailable') throw new Error(source.reason)
        if (source.kind !== 'legacy') {
          deps.stdout.write(
            source.kind === 'store'
              ? 'Accounts already migrated.\n'
              : 'No accounts to migrate.\n',
          )
          return
        }
        if ((await migrateOpenCode()) !== 0)
          throw new Error('Offline Antigravity account migration failed.')
      } else {
        deps.stdout.write(
          'Pi uses its native auth.json; no Antigravity account-pool migration is needed.\n',
        )
      }
    },
  }
}

/** CLI-only entry: importing setup must never add the vault client to a renderer graph. */
export async function runPluginSetup(
  argv: string[],
  deps: CliDependencies,
  migrateOpenCode: () => Promise<number>,
  io: SetupIO = {},
): Promise<void> {
  const plugin = await createSetupPlugin(
    deps,
    migrateOpenCode,
    argv.includes('--login'),
  )
  await runSetup(plugin, argv, {
    ...io,
    // The adapters' existing Pi resolver owns enrollment and the native auth path.
    env: { ...(io.env ?? process.env), PI_CODING_AGENT_DIR: getPiConfigDir() },
  })
}

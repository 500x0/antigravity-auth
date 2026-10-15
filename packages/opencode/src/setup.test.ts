import { afterEach, describe, expect, it, mock } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import {
  loadCommonAuthClaustrum,
  loadCommonAuthPiSlot,
} from '@cortexkit/antigravity-auth-core'

import { createDefaultCliDependencies, runCli } from './cli.ts'
import {
  runSetup,
  type SetupCallbackContext,
} from './common-auth-embedded/setup/index.js'
import { createSetupPlugin, persistPiSetupLogin } from './setup.ts'

const packageRoot = resolve(import.meta.dir, '..')
const roots: string[] = []
const version = JSON.parse(
  readFileSync(join(packageRoot, 'package.json'), 'utf8'),
).version
const node = Bun.which('node')!

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function profile(temporary = tmpdir()) {
  const root = realpathSync(
    mkdtempSync(join(temporary, 'antigravity-cli-setup-')),
  )
  roots.push(root)
  const home = join(root, 'home')
  const config = join(root, 'config', 'opencode')
  mkdirSync(home, { mode: 0o700 })
  mkdirSync(config, { recursive: true, mode: 0o700 })
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CACHE_HOME: join(root, 'cache'),
    OPENCODE_CONFIG_DIR: config,
    OPENCODE_DB: join(root, 'opencode-isolated.db'),
    PI_AGENT_DIR: join(root, 'pi'),
    PI_CODING_AGENT_DIR: join(root, 'pi'),
    PI_ANTIGRAVITY_AUTH_FILE: join(root, 'pi', 'antigravity-accounts.json'),
    SUBC_CONNECTION_FILE: join(root, 'absent-connection.json'),
    CLAUSTRUM_SUBC_CONNECTION: join(root, 'absent-connection.json'),
    // Avoid host detection on PATH, but retain ps to verify that hosts are stopped.
    PATH: '/usr/bin:/bin',
  }
  return { root, home, config, env }
}

function snapshot(root: string, prefix = ''): unknown[] {
  return readdirSync(join(root, prefix))
    .sort()
    .flatMap((name): unknown[] => {
      const path = join(prefix, name)
      const info = statSync(join(root, path))
      const row = [
        path,
        info.mode & 0o777,
        info.isDirectory()
          ? 'directory'
          : readFileSync(join(root, path)).toString('base64'),
      ]
      return info.isDirectory() ? [row, ...snapshot(root, path)] : [row]
    })
}

function fakeHostCommands(p: ReturnType<typeof profile>) {
  const bin = join(p.root, 'bin')
  mkdirSync(bin, { mode: 0o700 })
  for (const name of ['pi', 'ck']) {
    const path = join(
      bin,
      `${name}${process.platform === 'win32' ? '.cmd' : ''}`,
    )
    writeFileSync(
      path,
      process.platform === 'win32'
        ? '@echo off\r\necho 1.0.0\r\n'
        : '#!/bin/sh\necho 1.0.0\n',
      { mode: 0o700 },
    )
  }
  p.env.PATH = `${bin}${delimiter}${process.platform === 'win32' ? process.env.PATH : '/usr/bin:/bin'}`
}

function cli(p: ReturnType<typeof profile>, ...argv: string[]) {
  const result = spawnSync(
    node,
    [join(packageRoot, 'dist/cli.js'), 'setup', ...argv],
    {
      cwd: p.home,
      env: p.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 30_000,
    },
  )
  expect(result.error).toBeUndefined()
  return result
}

function seedLocal(p: ReturnType<typeof profile>) {
  const accountFile = join(p.config, 'antigravity-accounts.json')
  writeFileSync(
    accountFile,
    JSON.stringify({
      version: 4,
      activeIndex: 0,
      accounts: [
        {
          email: 'setup-fixture@example.test',
          refreshToken: 'synthetic-refresh',
          projectId: 'synthetic-project',
          addedAt: 1,
          lastUsed: 1,
        },
      ],
    }),
    { mode: 0o600 },
  )
  const authPath = join(p.env.XDG_DATA_HOME, 'opencode', 'auth.json')
  mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 })
  const native = JSON.stringify({
    google: {
      type: 'oauth',
      access: '',
      refresh: 'synthetic-refresh|synthetic-project|',
      expires: 0,
    },
    unrelated: { type: 'api', key: 'synthetic-unrelated-key' },
  })
  writeFileSync(authPath, native, { mode: 0o600 })
  return { accountFile, authPath, native }
}

describe('real setup CLI entry', () => {
  it('dry-run alone without a terminal reports plans without any filesystem changes', () => {
    const p = profile()
    seedLocal(p)
    writeFileSync(
      join(p.config, 'opencode.jsonc'),
      '{\n  // keep this setting\n  "theme": "owned",\n  "plugin": ["other-plugin@1"]\n}\n',
      { mode: 0o640 },
    )
    const before = snapshot(p.root)
    const result = cli(p, '--dry-run')
    expect({ status: result.status, stderr: result.stderr }).toEqual({
      status: 0,
      stderr: '',
    })
    expect(result.stdout).toContain(
      'Dry run: no registrations, enrollment, sign-in or migration',
    )
    expect(result.stdout).toContain('Would write')
    expect(result.stdout).toContain(
      `@cortexkit/opencode-antigravity-auth@${version}`,
    )
    expect(result.stdout).toContain('"plugin"')
    expect(result.stdout).toContain(
      'Next: start OpenCode and run /antigravity.',
    )
    expect(snapshot(p.root)).toEqual(before)
  })

  it.each([
    '1',
    '2',
    'both',
  ])('dry-run --opencode=%s reports plans without any filesystem changes', (generation) => {
    const p = profile()
    writeFileSync(
      join(p.config, 'opencode.jsonc'),
      '{\n  // keep this setting\n  "theme": "owned",\n  "plugin": ["other-plugin@1"]\n}\n',
      { mode: 0o640 },
    )
    const before = snapshot(p.root)
    const result = cli(
      p,
      '--yes',
      '--dry-run',
      '--no-claustrum',
      `--opencode=${generation}`,
    )
    expect({ status: result.status, stderr: result.stderr }).toEqual({
      status: 0,
      stderr: '',
    })
    expect(result.stdout).toContain(
      'Dry run: no registrations, enrollment, sign-in or migration',
    )
    expect(result.stdout).toContain('Would write')
    expect(result.stdout).toContain(
      `@cortexkit/opencode-antigravity-auth@${version}`,
    )
    expect(result.stdout).toContain(
      generation === '2' ? '"plugins"' : '"plugin"',
    )
    expect(result.stdout).toContain(
      'Next: start OpenCode and run /antigravity.',
    )
    expect(snapshot(p.root)).toEqual(before)
  })

  it.each([
    '1',
    '2',
    'both',
  ])('--yes --opencode=%s registers without changing unrelated config or permissions', (generation) => {
    const p = profile()
    const local = seedLocal(p)
    const configFile = join(p.config, 'opencode.jsonc')
    writeFileSync(
      configFile,
      '{\n  // unrelated comment\n  "theme": "owned",\n  "permission": { "bash": "ask" },\n  "plugin": ["other-plugin@1"]\n}\n',
    )
    chmodSync(configFile, 0o640)
    const result = cli(p, '--yes', '--no-claustrum', `--opencode=${generation}`)
    expect({ status: result.status, stderr: result.stderr }).toEqual({
      status: 0,
      stderr: '',
    })
    expect(result.stdout).toContain(
      'Configured Antigravity for opencode (local).',
    )
    if (generation !== '1') {
      expect(result.stdout).toContain(
        'In OpenCode 2, run opencode auth login, select Google, then choose Google (antigravity-auth pool, browser).',
      )
      expect(result.stdout).toContain(
        'Setup has not completed the OpenCode 2 native Google connection.',
      )
    }
    const config = readFileSync(configFile, 'utf8')
    expect(config).toContain('// unrelated comment')
    expect(config).toContain('"theme": "owned"')
    expect(config).toContain('"permission": { "bash": "ask" }')
    expect(config).toContain('other-plugin@1')
    expect(config).toContain(`@cortexkit/opencode-antigravity-auth@${version}`)
    expect(statSync(configFile).mode & 0o777).toBe(0o640)
    expect(readFileSync(local.authPath, 'utf8')).toBe(local.native)
    expect(result.stdout).toContain('Migration completed')
    const again = cli(p, '--yes', '--no-claustrum', `--opencode=${generation}`)
    expect(again.status).toBe(0)
    expect(again.stdout).toContain('Accounts already migrated.')
    expect(readFileSync(configFile, 'utf8')).toBe(config)
  }, 60_000)

  it('--no-claustrum skips enrollment and retains all native credentials', () => {
    const p = profile()
    const local = seedLocal(p)
    const result = cli(p, '--yes', '--no-claustrum', '--opencode=1')
    expect({ status: result.status, stderr: result.stderr }).toEqual({
      status: 0,
      stderr: '',
    })
    expect(result.stdout).toContain('(local)')
    expect(result.stdout).not.toContain('ck auth enroll approve')
    expect(readFileSync(local.authPath, 'utf8')).toBe(local.native)
    expect(readdirSync(p.config)).not.toContain('antigravity-auth-vault')
  })

  it('generation 2 --login defers OAuth to the host without reading or writing V1 auth', () => {
    const p = profile()
    const authPath = join(p.env.XDG_DATA_HOME, 'opencode', 'auth.json')
    mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 })
    writeFileSync(authPath, '{not a native auth map', { mode: 0o600 })
    const result = cli(p, '--yes', '--no-claustrum', '--login', '--opencode=2')
    expect({ status: result.status, stderr: result.stderr }).toEqual({
      status: 0,
      stderr: '',
    })
    expect(result.stdout).toContain(
      'In OpenCode 2, run opencode auth login, select Google, then choose Google (antigravity-auth pool, browser).',
    )
    expect(result.stdout).toContain('No accounts to migrate.')
    expect(readFileSync(authPath, 'utf8')).toBe('{not a native auth map')
    expect(readdirSync(p.config)).not.toContain('antigravity-accounts.json')
  })

  it('refuses contradictory vault flags before writing any profile files', () => {
    const p = profile()
    const before = snapshot(p.root)
    const result = cli(
      p,
      '--yes',
      '--no-claustrum',
      '--claustrum',
      '--opencode=1',
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      '--claustrum and --no-claustrum cannot be used together',
    )
    expect(snapshot(p.root)).toEqual(before)
  })

  it('server and CLI keep both vault clients external without lazy chunks or inlining', () => {
    for (const name of ['server', 'cli', 'index']) {
      const meta = JSON.parse(
        readFileSync(join(packageRoot, `dist/${name}.meta.json`), 'utf8'),
      ) as {
        inputs: Record<string, unknown>
        outputs: Record<
          string,
          { imports: Array<{ path: string; kind: string; external?: boolean }> }
        >
      }
      expect(
        Object.keys(meta.inputs).some((path) =>
          /node_modules\/.*(?:claustrum-client|subc-client)/.test(path),
        ),
      ).toBe(false)
      expect(
        Object.keys(meta.outputs).filter((path) => /\.[cm]?js$/.test(path)),
      ).toHaveLength(1)
      const edges = Object.values(meta.outputs).flatMap(
        (output) => output.imports,
      )
      for (const client of [
        '@cortexkit/claustrum-client',
        '@cortexkit/subc-client',
      ]) {
        expect(
          edges.some((edge) => edge.path === client && edge.external),
        ).toBe(true)
        expect(
          edges
            .filter((edge) => edge.path === client)
            .every((edge) => edge.external),
        ).toBe(true)
        expect(
          edges.some(
            (edge) => edge.path === client && edge.kind === 'import-statement',
          ),
        ).toBe(true)
      }
    }
  })
})

describe('setup plugin callbacks', () => {
  const context = {
    hosts: ['opencode', 'pi'],
    opencodeGeneration: '1',
    mode: 'local',
  } as const
  const originalEnv = { ...process.env }
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
  })

  it.each([
    'uninitialized',
    'store',
    'legacy',
  ] as const)('local migration uses existing storage status: %s', async (kind) => {
    const p = profile()
    Object.assign(process.env, p.env)
    const deps = createDefaultCliDependencies()
    let output = ''
    deps.stdout = {
      write: (value) => {
        output += value
      },
    }
    deps.accountStore.read = async () =>
      kind === 'store' ? { kind, accounts: [] } : { kind }
    deps.accountStore.migrate = mock(async () => {
      throw new Error('existing offline migration invoked')
    })
    const plugin = await createSetupPlugin(deps, () =>
      runCli(['migrate', '--offline', '--yes'], deps),
    )
    if (kind === 'legacy') {
      await expect(plugin.migrate('opencode', context)).rejects.toThrow(
        'Offline Antigravity account migration failed',
      )
      expect(deps.accountStore.migrate).toHaveBeenCalledWith(
        join(p.config, 'antigravity-accounts.json'),
      )
    } else {
      await plugin.migrate('opencode', context)
      expect(deps.accountStore.migrate).not.toHaveBeenCalled()
      expect(output).toContain(
        kind === 'store'
          ? 'Accounts already migrated'
          : 'No accounts to migrate',
      )
    }
    await plugin.migrate('pi', context)
    expect(output).toContain('Pi uses its native auth.json')
  })

  it.each([
    '1',
    'both',
  ] as const)('generation %s fresh local sign-in reuses OAuth and activates only the selected native host slot', async (opencodeGeneration) => {
    const context = {
      hosts: ['opencode', 'pi'],
      opencodeGeneration,
      mode: 'local',
    } as const
    const p = profile()
    Object.assign(process.env, p.env)
    const deps = createDefaultCliDependencies()
    const login = {
      type: 'success' as const,
      refresh: 'synthetic-refresh|synthetic-project|',
      access: 'synthetic-access',
      expires: 123,
      projectId: 'synthetic-project',
      email: 'setup-fixture@example.test',
    }
    deps.performLogin = mock(async (_request, _openBrowser, host) => {
      if (host === 'pi') await persistPiSetupLogin(login)
      return login
    })
    deps.accountStore.read = async () => ({ kind: 'uninitialized' })
    const migrate = mock(async () => 0)
    const plugin = await createSetupPlugin(deps, migrate)
    expect(plugin.packages).toEqual({
      opencode: '@cortexkit/opencode-antigravity-auth',
      pi: '@cortexkit/pi-antigravity-auth',
    })
    expect(plugin.vault.hosts.opencode.name).toBe('antigravity-auth-opencode')
    expect(plugin.vault.hosts.pi.name).toBe('antigravity-auth-pi')
    expect(plugin.vault.hosts.pi.paths.stateDir).toBe(
      join(p.env.PI_AGENT_DIR, 'antigravity-auth-vault'),
    )
    await plugin.signInLocal('opencode', context)
    expect(deps.performLogin).toHaveBeenLastCalledWith(
      expect.objectContaining({ startFresh: false, accounts: [] }),
      deps.openBrowser,
      'opencode',
    )
    await plugin.beforeRegister?.('opencode', 'local', context)
    const opencodeAuth = JSON.parse(
      readFileSync(join(p.env.XDG_DATA_HOME, 'opencode', 'auth.json'), 'utf8'),
    )
    expect(opencodeAuth.google.refresh).toBe(login.refresh)
    await plugin.signInLocal('pi', context)
    expect(deps.performLogin).toHaveBeenLastCalledWith(
      expect.objectContaining({ startFresh: false, accounts: [] }),
      deps.openBrowser,
      'pi',
    )
    await plugin.beforeRegister?.('pi', 'local', context)
    const piAuth = JSON.parse(
      readFileSync(join(p.env.PI_AGENT_DIR, 'auth.json'), 'utf8'),
    )
    expect(piAuth.google.refresh).toBe(login.refresh)
    expect(piAuth['google-antigravity']).toBeUndefined()
    expect(
      readFileSync(join(p.env.XDG_DATA_HOME, 'opencode', 'auth.json'), 'utf8'),
    ).toBe(`${JSON.stringify(opencodeAuth, null, 2)}\n`)
  })

  it.each([
    '1',
    '2',
    'both',
  ] as const)('runSetup forwards generation %s to every local callback', async (opencodeGeneration) => {
    const p = profile()
    Object.assign(process.env, p.env)
    const deps = createDefaultCliDependencies()
    const plugin = await createSetupPlugin(deps, async () => 0)
    const calls: Array<[string, string, SetupCallbackContext]> = []
    plugin.beforeSignIn = async (host, context) => {
      calls.push(['beforeSignIn', host, context])
    }
    plugin.signInLocal = async (host, context) => {
      calls.push(['signInLocal', host, context])
    }
    plugin.beforeRegister = async (host, mode, context) => {
      expect(mode).toBe('local')
      calls.push(['beforeRegister', host, context])
    }
    plugin.migrate = async (host, context) => {
      calls.push(['migrate', host, context])
    }
    const result = await runSetup(
      plugin,
      ['--yes', '--no-claustrum', `--opencode=${opencodeGeneration}`],
      { env: p.env },
    )
    expect(result.hosts).toEqual(['opencode'])
    expect(calls).toEqual(
      ['beforeSignIn', 'signInLocal', 'beforeRegister', 'migrate'].map(
        (name) => [
          name,
          'opencode',
          { hosts: ['opencode'], opencodeGeneration, mode: 'local' },
        ],
      ),
    )
  })

  it.each([
    '1',
    '2',
    'both',
  ] as const)('beforeSignIn rejection for generation %s prevents every later callback and profile write', async (opencodeGeneration) => {
    const p = profile()
    Object.assign(process.env, p.env)
    const deps = createDefaultCliDependencies()
    const plugin = await createSetupPlugin(deps, async () => 0)
    const before = snapshot(p.root)
    plugin.beforeSignIn = mock(async (host, context) => {
      expect(host).toBe('opencode')
      expect(context).toEqual({
        hosts: ['opencode'],
        opencodeGeneration,
        mode: 'local',
      })
      throw new Error('precondition refused')
    })
    plugin.signInLocal = mock(async () => {})
    plugin.beforeRegister = mock(async () => {})
    plugin.migrate = mock(async () => {})
    const connect = mock(async () => {
      throw new Error('must not enroll')
    })
    await expect(
      runSetup(
        plugin,
        ['--yes', '--no-claustrum', `--opencode=${opencodeGeneration}`],
        { env: p.env, connect },
      ),
    ).rejects.toThrow('precondition refused')
    expect(plugin.signInLocal).not.toHaveBeenCalled()
    expect(plugin.beforeRegister).not.toHaveBeenCalled()
    expect(plugin.migrate).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
    expect(snapshot(p.root)).toEqual(before)
  })

  it('all selected hosts are visible to the first beforeSignIn, before any other callback', async () => {
    const p = profile()
    fakeHostCommands(p)
    Object.assign(process.env, p.env)
    const plugin = await createSetupPlugin(
      createDefaultCliDependencies(),
      async () => 0,
    )
    const before = snapshot(p.root)
    plugin.beforeSignIn = mock(async (host, context) => {
      expect(host).toBe('opencode')
      expect(context).toEqual({
        hosts: ['opencode', 'pi'],
        opencodeGeneration: '2',
        mode: 'local',
      })
      throw new Error('batch refused')
    })
    plugin.signInLocal = mock(async () => {})
    plugin.beforeRegister = mock(async () => {})
    plugin.migrate = mock(async () => {})
    await expect(
      runSetup(plugin, ['--yes', '--no-claustrum', '--opencode=2'], {
        env: p.env,
      }),
    ).rejects.toThrow('batch refused')
    expect(plugin.signInLocal).not.toHaveBeenCalled()
    expect(plugin.beforeRegister).not.toHaveBeenCalled()
    expect(plugin.migrate).not.toHaveBeenCalled()
    expect(snapshot(p.root)).toEqual(before)
  })

  it('Pi local refusal prevents OpenCode login, migration and registration before either selected host changes credentials', async () => {
    const p = profile()
    fakeHostCommands(p)
    Object.assign(process.env, p.env)
    const local = seedLocal(p)
    await persistPiSetupLogin({
      type: 'success',
      refresh: 'synthetic-pi-original',
      access: 'synthetic-pi-access',
      expires: 1,
      projectId: 'synthetic-project',
    })
    const { openPiSlot } = await loadCommonAuthPiSlot()
    const authPath = join(p.env.PI_AGENT_DIR, 'auth.json')
    const stashPath = join(
      p.env.PI_AGENT_DIR,
      'antigravity-auth-vault',
      'google-login-stash.json',
    )
    await openPiSlot({
      authPath,
      stashPath,
      provider: 'google',
      placeholderKey: 'antigravity-vault-custody',
    }).enterVault()
    const bytes = [local.authPath, local.accountFile, authPath, stashPath].map(
      (path) => readFileSync(path),
    )
    const deps = createDefaultCliDependencies()
    deps.performLogin = mock(async () => {
      throw new Error('OpenCode must not sign in first')
    })
    const migrate = mock(async () => 0)
    const plugin = await createSetupPlugin(deps, migrate, true)
    await expect(
      runSetup(plugin, ['--yes', '--no-claustrum', '--login', '--opencode=1'], {
        env: p.env,
      }),
    ).rejects.toThrow('vault marker')
    expect(deps.performLogin).not.toHaveBeenCalled()
    expect(migrate).not.toHaveBeenCalled()
    for (const [index, path] of [
      local.authPath,
      local.accountFile,
      authPath,
      stashPath,
    ].entries()) {
      const expected = bytes[index]
      if (!expected) throw new Error('Missing preflight byte snapshot')
      expect(readFileSync(path)).toEqual(expected)
    }
    expect(existsSync(join(p.config, 'opencode.json'))).toBe(false)
    expect(existsSync(join(p.config, 'opencode.jsonc'))).toBe(false)
  })

  it('foreign Pi login conflicts refuse before any selected host enrollment ceremony, with unchanged auth and stash bytes', async () => {
    const p = profile(process.platform === 'win32' ? tmpdir() : '/tmp')
    fakeHostCommands(p)
    Object.assign(process.env, p.env)
    const local = seedLocal(p)
    writeFileSync(local.authPath, '{not V1 auth')
    await persistPiSetupLogin({
      type: 'success',
      refresh: 'synthetic-pi-original',
      access: 'synthetic-pi-access',
      expires: 1,
      projectId: 'synthetic-project',
    })
    const { openPiSlot } = await loadCommonAuthPiSlot()
    const authPath = join(p.env.PI_AGENT_DIR, 'auth.json')
    const stashPath = join(
      p.env.PI_AGENT_DIR,
      'antigravity-auth-vault',
      'google-login-stash.json',
    )
    await openPiSlot({
      authPath,
      stashPath,
      provider: 'google',
      placeholderKey: 'antigravity-vault-custody',
    }).enterVault()
    writeFileSync(
      authPath,
      JSON.stringify({
        google: {
          type: 'oauth',
          refresh: 'synthetic-foreign',
          access: '',
          expires: 1,
        },
      }),
    )
    const bytes = [local.authPath, local.accountFile, authPath, stashPath].map(
      (path) => readFileSync(path),
    )
    const plugin = await createSetupPlugin(
      createDefaultCliDependencies(),
      async () => 0,
    )
    writeFileSync(plugin.vault.connectionFile, '{}')
    const enrollPropose = mock(async () => {
      throw new Error('ceremony must not start')
    })
    const connect = mock(async () => ({
      close() {},
      enrollPropose,
      enrollPoll: async () => ({ status: 'pending' as const }),
    }))
    await expect(
      runSetup(plugin, ['--yes', '--claustrum', '--opencode=2'], {
        env: p.env,
        connect,
      }),
    ).rejects.toThrow('different login from its saved stash')
    expect(enrollPropose).not.toHaveBeenCalled()
    for (const [index, path] of [
      local.authPath,
      local.accountFile,
      authPath,
      stashPath,
    ].entries()) {
      const expected = bytes[index]
      if (!expected) throw new Error('Missing preflight byte snapshot')
      expect(readFileSync(path)).toEqual(expected)
    }
    expect(existsSync(join(p.config, 'opencode.json'))).toBe(false)
    expect(existsSync(join(p.config, 'opencode.jsonc'))).toBe(false)
  })

  it('real CLI dry-run selects both hosts without callbacks, Pi inspection, lock acquisition or slot repairs', () => {
    const p = profile()
    fakeHostCommands(p)
    mkdirSync(p.env.PI_AGENT_DIR, { mode: 0o700 })
    const authPath = join(p.env.PI_AGENT_DIR, 'auth.json')
    writeFileSync(authPath, '{invalid native auth')
    writeFileSync(`${authPath}.lock`, 'owned inspection obstacle', {
      mode: 0o600,
    })
    const before = snapshot(p.root)
    const result = cli(
      p,
      '--yes',
      '--dry-run',
      '--opencode=2',
      '--no-claustrum',
    )
    expect({ status: result.status, stderr: result.stderr }).toEqual({
      status: 0,
      stderr: '',
    })
    expect(result.stdout).toContain('Pi: found')
    expect(result.stdout).toContain('for opencode, pi (local)')
    expect(snapshot(p.root)).toEqual(before)
  })

  it('V1 vault preconditions refuse a local native login before any enrollment write, while generation 2 never reads that slot', async () => {
    const p = profile()
    Object.assign(process.env, p.env)
    const local = seedLocal(p)
    const plugin = await createSetupPlugin(
      createDefaultCliDependencies(),
      async () => 0,
    )
    const before = snapshot(p.root)
    for (const opencodeGeneration of ['1', 'both'] as const) {
      await expect(
        plugin.beforeSignIn?.('opencode', {
          hosts: ['opencode'],
          opencodeGeneration,
          mode: 'claustrum',
        }),
      ).rejects.toThrow()
    }
    expect(snapshot(p.root)).toEqual(before)
    writeFileSync(local.authPath, '{not native auth')
    const invalid = snapshot(p.root)
    await plugin.beforeSignIn?.('opencode', {
      hosts: ['opencode'],
      opencodeGeneration: '2',
      mode: 'claustrum',
    })
    expect(snapshot(p.root)).toEqual(invalid)
  })

  it('generation 2 callbacks defer duplicate OAuth and V1 auth access but still migrate legacy accounts offline', async () => {
    const p = profile()
    Object.assign(process.env, p.env)
    const local = seedLocal(p)
    writeFileSync(local.authPath, '{not a native auth map')
    const before = snapshot(p.root)
    const deps = createDefaultCliDependencies()
    let output = ''
    deps.stdout = {
      write: (value) => {
        output += value
      },
    }
    deps.performLogin = mock(async () => {
      throw new Error('duplicate OAuth')
    })
    deps.accountStore.read = mock(async () => ({ kind: 'legacy' as const }))
    const migrate = mock(async () => 0)
    const plugin = await createSetupPlugin(deps, migrate, true)
    const context = {
      hosts: ['opencode'],
      opencodeGeneration: '2',
      mode: 'local',
    } as const
    await plugin.signInLocal('opencode', context)
    await plugin.beforeRegister?.('opencode', 'local', context)
    expect(deps.performLogin).not.toHaveBeenCalled()
    expect(deps.accountStore.read).not.toHaveBeenCalled()
    expect(snapshot(p.root)).toEqual(before)
    await plugin.migrate('opencode', context)
    expect(migrate).toHaveBeenCalledTimes(1)
    expect(deps.accountStore.read).toHaveBeenCalledTimes(1)
    expect(output).toBe(
      'In OpenCode 2, run opencode auth login, select Google, then choose Google (antigravity-auth pool, browser).\n' +
        'Setup has not completed the OpenCode 2 native Google connection.\n',
    )
    expect(snapshot(p.root)).toEqual(before)
  })

  it('Pi still signs in and writes its own native slot with generation 2 context', async () => {
    const p = profile()
    Object.assign(process.env, p.env)
    const deps = createDefaultCliDependencies()
    const login = {
      type: 'success' as const,
      refresh: 'synthetic-pi-refresh|synthetic-project|',
      access: 'synthetic-pi-access',
      expires: 123,
      projectId: 'synthetic-project',
    }
    deps.performLogin = mock(async (_request, _browser, host) => {
      expect(host).toBe('pi')
      await persistPiSetupLogin(login)
      return login
    })
    const migrate = mock(async () => 0)
    const plugin = await createSetupPlugin(deps, migrate)
    const context = {
      hosts: ['pi'],
      opencodeGeneration: '2',
      mode: 'local',
    } as const
    await plugin.signInLocal('pi', context)
    await plugin.beforeRegister?.('pi', 'local', context)
    await plugin.migrate('pi', context)
    expect(deps.performLogin).toHaveBeenCalledTimes(1)
    expect(migrate).not.toHaveBeenCalled()
    expect(
      JSON.parse(readFileSync(join(p.env.PI_AGENT_DIR, 'auth.json'), 'utf8'))
        .google.refresh,
    ).toBe(login.refresh)
    expect(existsSync(join(p.env.XDG_DATA_HOME, 'opencode', 'auth.json'))).toBe(
      false,
    )
  })

  it('generation 2 rechecks local authority at each callback and activates vault only through the native host step', async () => {
    const p = profile(process.platform === 'win32' ? tmpdir() : '/tmp')
    Object.assign(process.env, p.env)
    const local = seedLocal(p)
    writeFileSync(local.authPath, '{not a native auth map')
    const deps = createDefaultCliDependencies()
    let output = ''
    deps.stdout = {
      write: (value) => {
        output += value
      },
    }
    deps.performLogin = mock(async () => {
      throw new Error('must not sign in')
    })
    const migrate = mock(async () => 0)
    const plugin = await createSetupPlugin(deps, migrate)
    const context = {
      hosts: ['opencode'],
      opencodeGeneration: '2',
      mode: 'local',
    } as const
    await plugin.signInLocal('opencode', context)
    const claustrum = await loadCommonAuthClaustrum()
    const host = plugin.vault.hosts.opencode
    const manager = new claustrum.ClaustrumEnrollmentManager({
      paths: claustrum.hostEnrollmentPaths(host.paths),
      proposedName: host.name,
      client: {
        enrollPropose: async () => ({ requestId: 'synthetic-setup-request' }),
        enrollPoll: async () => ({
          status: 'approved',
          name: host.name,
          token: 'ab'.repeat(32),
          tokenGeneration: 1,
        }),
      },
    })
    expect((await manager.reconcile()).state).toBe('approved')
    const before = snapshot(p.root)
    await expect(plugin.signInLocal('opencode', context)).rejects.toThrow(
      'Vault enrollment excludes local sign-in',
    )
    await expect(
      plugin.beforeRegister?.('opencode', 'local', context),
    ).rejects.toThrow('Vault enrollment excludes local sign-in')
    await expect(plugin.migrate('opencode', context)).rejects.toThrow(
      'Vault enrollment excludes local sign-in',
    )
    await plugin.beforeRegister?.('opencode', 'claustrum', {
      ...context,
      mode: 'claustrum',
    })
    expect(output).toBe(
      'In OpenCode 2, run opencode auth login, select Google, then choose Use approved Antigravity vault.\n' +
        'Setup has not completed the OpenCode 2 native Google connection.\n',
    )
    expect(deps.performLogin).not.toHaveBeenCalled()
    expect(migrate).not.toHaveBeenCalled()
    expect(snapshot(p.root)).toEqual(before)
    const vaultContext = { ...context, mode: 'claustrum' } as const
    await plugin.migrate('opencode', vaultContext)
    expect(migrate).not.toHaveBeenCalled()
    writeFileSync(claustrum.hostEnrollmentPaths(host.paths).statePath, '{')
    const unreadable = snapshot(p.root)
    await expect(
      plugin.beforeRegister?.('opencode', 'claustrum', vaultContext),
    ).rejects.toThrow('Vault access must be approved before activation')
    await expect(plugin.migrate('opencode', vaultContext)).rejects.toThrow(
      'Vault access must remain approved during setup',
    )
    expect(snapshot(p.root)).toEqual(unreadable)
  })

  it('refuses a vault placeholder during local setup without registering or signing in', async () => {
    const p = profile()
    Object.assign(process.env, p.env)
    const local = seedLocal(p)
    writeFileSync(
      local.authPath,
      JSON.stringify({
        google: {
          type: 'oauth',
          refresh: 'claustrum-tombstone:v1:google',
          access: '',
          expires: 0,
        },
      }),
    )
    const before = snapshot(p.root)
    const deps = createDefaultCliDependencies()
    deps.performLogin = mock(async () => {
      throw new Error('must not sign in')
    })
    const plugin = await createSetupPlugin(deps, async () => 0)
    await expect(plugin.signInLocal('opencode', context)).rejects.toThrow()
    expect(deps.performLogin).not.toHaveBeenCalled()
    expect(snapshot(p.root)).toEqual(before)
  })
})

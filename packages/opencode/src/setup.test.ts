import { afterEach, describe, expect, it, mock } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { createDefaultCliDependencies, runCli } from './cli.ts'
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

function profile() {
  const root = mkdtempSync(join(tmpdir(), 'antigravity-cli-setup-'))
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
      await expect(plugin.migrate('opencode')).rejects.toThrow(
        'Offline Antigravity account migration failed',
      )
      expect(deps.accountStore.migrate).toHaveBeenCalledWith(
        join(p.config, 'antigravity-accounts.json'),
      )
    } else {
      await plugin.migrate('opencode')
      expect(deps.accountStore.migrate).not.toHaveBeenCalled()
      expect(output).toContain(
        kind === 'store'
          ? 'Accounts already migrated'
          : 'No accounts to migrate',
      )
    }
    await plugin.migrate('pi')
    expect(output).toContain('Pi uses its native auth.json')
  })

  it('fresh local sign-in reuses OAuth and activates only the selected native host slot', async () => {
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
    await plugin.signInLocal('opencode')
    expect(deps.performLogin).toHaveBeenLastCalledWith(
      expect.objectContaining({ startFresh: false, accounts: [] }),
      deps.openBrowser,
      'opencode',
    )
    await plugin.beforeRegister?.('opencode', 'local')
    const opencodeAuth = JSON.parse(
      readFileSync(join(p.env.XDG_DATA_HOME, 'opencode', 'auth.json'), 'utf8'),
    )
    expect(opencodeAuth.google.refresh).toBe(login.refresh)
    await plugin.signInLocal('pi')
    expect(deps.performLogin).toHaveBeenLastCalledWith(
      expect.objectContaining({ startFresh: false, accounts: [] }),
      deps.openBrowser,
      'pi',
    )
    await plugin.beforeRegister?.('pi', 'local')
    const piAuth = JSON.parse(
      readFileSync(join(p.env.PI_AGENT_DIR, 'auth.json'), 'utf8'),
    )
    expect(piAuth.google.refresh).toBe(login.refresh)
    expect(piAuth['google-antigravity']).toBeUndefined()
    expect(
      readFileSync(join(p.env.XDG_DATA_HOME, 'opencode', 'auth.json'), 'utf8'),
    ).toBe(`${JSON.stringify(opencodeAuth, null, 2)}\n`)
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
    await expect(plugin.signInLocal('opencode')).rejects.toThrow()
    expect(deps.performLogin).not.toHaveBeenCalled()
    expect(snapshot(p.root)).toEqual(before)
  })
})

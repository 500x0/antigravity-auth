import { afterEach, expect, it } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProcessFence } from '../../packages/opencode/src/common-auth-embedded/setup/index.js'
import wrappers from './process-wrapper-fixture.json'

it('public process fence ignores exact observed shell wrappers and detects executable and runtime host controls', async () => {
  const hosts = await createProcessFence(
    {
      run: async () => ({
        exitCode: 0,
        stderr: '',
        stdout: [
          'PID COMMAND',
          ...wrappers.map(({ pid, command }) => `${pid} ${command}`),
          '500001 /opt/bin/opencode',
          '500002 node /opt/bin/opencode',
          '500003 bun /opt/bin/pi',
        ].join('\n'),
      }),
    },
    { platform: 'linux' },
  ).listRunningHosts()
  expect(hosts.map(({ pid }) => pid)).toEqual([500001, 500002, 500003])
})

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true })
})

it('public ps inspection detects an owned synthetic opencode script process, without starting OpenCode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'synthetic-host-control-'))
  roots.push(root)
  const script = join(root, 'opencode')
  await writeFile(
    script,
    "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)\n",
  )
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, OPENCODE_DB: join(root, 'isolated.db') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  )
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('synthetic control did not start')),
        3000,
      )
      child.once('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      child.stdout.once('data', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
    const hosts = await createProcessFence().listRunningHosts()
    expect(hosts.some(({ pid }) => pid === child.pid)).toBe(true)
  } finally {
    child.kill('SIGTERM')
    await exited
  }
})

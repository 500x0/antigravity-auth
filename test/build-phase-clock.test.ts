import { afterEach, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildPhase as copiedBuildPhase,
  buildPhaseNote as copiedBuildPhaseNote,
  buildSyncPhase as copiedBuildSyncPhase,
} from '../packages/opencode/scripts/build-tui.ts'
import {
  buildPhase,
  buildPhaseNote,
  buildSyncPhase,
  createBuildPhaseReporter,
  withBuildPhaseClock,
} from '../scripts/build-phase-clock.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'build-phase-clock-'))
  roots.push(root)
  const lines: string[] = []
  let at = 1000
  const options = {
    root,
    now: () => at,
    report: (line: string) => lines.push(line),
  }
  return {
    root,
    lines,
    options,
    advance: (ms: number) => {
      at += ms
    },
  }
}

test('phase clock reports the exact overdue await once and stays silent before its deadline', async () => {
  const { root, lines, options, advance } = await fixture()
  const reporter = createBuildPhaseReporter(root, options)
  let release: () => void = () => {}
  const pending = withBuildPhaseClock(
    'build.product_two_roots',
    120000,
    async () => {
      await buildPhase(
        'product.fixture full',
        () =>
          new Promise<void>((resolve) => {
            release = resolve
          }),
      )
    },
    options,
  )
  reporter()
  advance(119999)
  reporter()
  expect(lines).toEqual([])
  advance(1)
  reporter()
  reporter()
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('test deadline reached')
  expect(lines[0]).toContain('product.fixture full')
  expect(lines[0]).toContain('"elapsedMs":120000')
  release()
  await pending
})

test('phase clock never reports successful tests, even when their command later fails', async () => {
  const { root, lines, options, advance } = await fixture()
  await withBuildPhaseClock(
    'successful build',
    120000,
    async () => {
      await buildPhase('read source', async () => 'source')
      buildSyncPhase('child spawn compiler', () => 'result')
      buildPhaseNote('child exit', 'status=0')
    },
    options,
  )
  advance(120001)
  createBuildPhaseReporter(root, options)('another test failed')
  expect(lines).toEqual([])
  const [file] = await readdir(join(root, 'build-test-phase-clocks'))
  const journal = JSON.parse(
    await readFile(join(root, 'build-test-phase-clocks', file!), 'utf8'),
  )
  expect(journal.status).toBe('passed')
  expect(journal.recent.map((event: { name: string }) => event.name)).toContain(
    'child exit',
  )
})

test('phase clock preserves the innermost failed await and the original rejection', async () => {
  const { root, lines, options } = await fixture()
  const failure = new Error('compiler refused')
  const pending = withBuildPhaseClock(
    'failed build',
    120000,
    async () => {
      await buildPhase('outer build', () =>
        buildPhase('read missing map', async () => {
          throw failure
        }),
      )
    },
    options,
  )
  await expect(pending).rejects.toBe(failure)
  createBuildPhaseReporter(root, options)()
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('"failedPhase":"read missing map"')
  expect(lines[0]).toContain('compiler refused')
})

test('phase clock reports a killed command before the test deadline without inventing an exit', async () => {
  const { root, lines, options } = await fixture()
  const reporter = createBuildPhaseReporter(root, options)
  await withBuildPhaseClock(
    'build.product_two_roots',
    120000,
    async () => {
      buildSyncPhase('child spawn compiler', () => {
        reporter('test command execution deadline exceeded')
      })
    },
    options,
  )
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('test command execution deadline exceeded')
  expect(lines[0]).toContain('child spawn compiler')
  expect(lines[0]).not.toContain('child exit')
})

test('phase clock diagnostics do not mask a build error when the journal cannot be written', async () => {
  const { root, lines, options } = await fixture()
  const failure = new Error('original build failure')
  await writeFile(join(root, 'not-a-directory'), 'owned fixture')
  const pending = withBuildPhaseClock(
    'failed build',
    120000,
    async () => {
      throw failure
    },
    {
      ...options,
      root: join(root, 'not-a-directory'),
    },
  )
  await expect(pending).rejects.toBe(failure)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('original build failure')
})

test('phase clock reports a synchronous child wait from an independent wrapper', async () => {
  const { root, lines } = await fixture()
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    import { spawnSync } from 'node:child_process';
    import { withBuildPhaseClock, buildSyncPhase } from ${JSON.stringify(import.meta.resolve('../scripts/build-phase-clock.ts'))};
    await withBuildPhaseClock('blocked build', 50, async () => {
      buildSyncPhase('child spawn compiler', () => {
        console.log('blocking-ready');
        spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 750)'], { timeout: 2000 });
      });
    }, { root: ${JSON.stringify(root)} });
  `,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const closed = once(child, 'close')
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.stdout!.once('data', () => resolve())
      child.once('exit', () =>
        reject(new Error('child exited before entering its synchronous wait')),
      )
    })
    const reporter = createBuildPhaseReporter(root, {
      report: (line) => lines.push(line),
    })
    reporter('wrapper is terminating the blocked test process')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('child spawn compiler')
    expect(lines[0]).not.toContain('child exit')
  } finally {
    child.kill('SIGTERM')
    await closed
  }
})

test('copied build scripts join the installed phase clock without importing its helper', async () => {
  const { root, lines, options } = await fixture()
  await withBuildPhaseClock(
    'copied builder',
    120000,
    async () => {
      await copiedBuildPhase('copied builder await', async () => 'source')
      copiedBuildSyncPhase('copied builder child spawn', () => 'result')
      copiedBuildPhaseNote('copied builder child exit', 'status=0')
    },
    options,
  )
  const [file] = await readdir(join(root, 'build-test-phase-clocks'))
  const journal = JSON.parse(
    await readFile(join(root, 'build-test-phase-clocks', file!), 'utf8'),
  )
  expect(journal.recent.map((event: { name: string }) => event.name)).toEqual([
    'enter copied builder await',
    'exit copied builder await',
    'enter copied builder child spawn',
    'exit copied builder child spawn',
    'copied builder child exit',
    'passed',
  ])
  createBuildPhaseReporter(root, options)('another test failed')
  expect(lines).toEqual([])
})

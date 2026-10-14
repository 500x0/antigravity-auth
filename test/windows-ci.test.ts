import { afterEach, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { BUNDLE_EXTERNALS } from '../packages/opencode/scripts/build-tui.ts'
import {
  inputPath,
  outputPath,
} from '../packages/opencode/scripts/embed-common-auth.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary: string[] = []
async function owned() {
  const path = await mkdtemp(join(root, 'test/.owned-windows-ci-'))
  temporary.push(path)
  return path
}
// Child processes run asynchronously: a synchronous spawn inside a Bun test
// worker can leave the worker spinning after the child exits, which hangs the
// isolated suite.
const run = promisify(execFile)
async function command(cwd: string, program: string, args: string[]) {
  const { stdout } = await run(program, args, {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  })
  return stdout
}
afterEach(async () => {
  for (const path of temporary.splice(0))
    await rm(path, { recursive: true, force: true })
})

type Workflow = {
  jobs: Record<string, { steps: { run?: string }[] }>
}
const workflow = Bun.YAML.parse(
  await readFile(join(root, '.github/workflows/windows-migration.yml'), 'utf8'),
) as Workflow

for (const job of ['vault', 'migration']) {
  test(`Windows ${job} bundle uses product externals and loads in Node`, async () => {
    const run = workflow.jobs[job]!.steps.find((step) =>
      step.run?.includes(' esbuild '),
    )!.run!
    const expression = run.match(/^\s*\$externals = bun -e "([^"]+)"$/m)![1]!
    const externals = (await command(root, 'bun', ['-e', expression]))
      .trim()
      .split(/\r?\n/)
    expect(externals).toEqual(
      BUNDLE_EXTERNALS.map((name) => `--external:${name}`),
    )
    const line = run.match(
      /^\s*(bun run --cwd packages\/opencode esbuild .+)$/m,
    )![1]!
    expect(line).toContain(' @externals ')
    if (job === 'vault') expect(line).toContain(' --sourcemap ')
    const args = line
      .split(/\s+/)
      .flatMap((arg) => (arg === '@externals' ? externals : [arg]))
    expect(args.filter((arg) => arg.startsWith('--external:'))).toEqual(
      externals,
    )
    const originalOutput = args.find((arg) => arg.startsWith('--outfile='))!
    const temporary = await owned()
    // Keep the bundle under the package so Node resolves its installed runtime dependencies.
    const bundle = join(
      root,
      'packages/opencode/dist',
      `windows-${job}-test.mjs`,
    )
    const metafile = join(temporary, 'meta.json')
    try {
      await command(root, args[0]!, [
        ...args
          .slice(1)
          .map((arg) => (arg === originalOutput ? `--outfile=${bundle}` : arg)),
        `--metafile=${metafile}`,
      ])
      const meta = JSON.parse(await readFile(metafile, 'utf8'))
      if (job === 'vault') {
        const map = JSON.parse(await readFile(`${bundle}.map`, 'utf8'))
        expect(map.sources).toContain(
          '../../core/dist/common-auth-embedded/claustrum/enrollment.js',
        )
      }
      expect(
        Object.keys(meta.inputs).some((path) =>
          path.includes('/jsonc-parser/'),
        ),
      ).toBe(false)
      const imports = Object.values(meta.outputs).flatMap(
        (output) =>
          (
            output as {
              imports: { path: string; kind: string; external?: boolean }[]
            }
          ).imports,
      )
      expect(imports).toContainEqual({
        path: 'jsonc-parser',
        kind: 'import-statement',
        external: true,
      })
      const loaded =
        job === 'migration'
          ? await command(root, 'node', [bundle, '--help'])
          : await command(root, 'node', [
              '--input-type=module',
              '-e',
              `const m = await import(${JSON.stringify(pathToFileURL(bundle).href)}); if (typeof m.createAntigravityPlugin !== 'function') throw new Error('Missing plugin export'); console.log('vault bundle loaded')`,
            ])
      expect(loaded).toContain(
        job === 'migration' ? 'setup' : 'vault bundle loaded',
      )
    } finally {
      await rm(bundle, { force: true })
      await rm(`${bundle}.map`, { force: true })
    }
  })
}

test('Windows checkout preserves the embedded generator self-hash and manifest bytes', async () => {
  const target = await owned()
  const generator = 'packages/opencode/scripts/embed-common-auth.ts'
  for (const path of ['.gitattributes', generator, inputPath]) {
    await mkdir(dirname(join(target, path)), { recursive: true })
    await cp(join(root, path), join(target, path))
  }
  await writeFile(
    join(target, 'unprotected.txt'),
    'checkout conversion control\n',
  )
  const git = (...args: string[]) => command(target, 'git', args)
  await git('init', '-q')
  await git(
    '-c',
    'core.autocrlf=false',
    'add',
    '.gitattributes',
    generator,
    'unprotected.txt',
  )
  await rm(join(target, generator))
  await rm(join(target, 'unprotected.txt'))
  await git(
    '-c',
    'core.autocrlf=true',
    'checkout-index',
    '-f',
    '--',
    generator,
    'unprotected.txt',
  )
  expect(await readFile(join(target, 'unprotected.txt'), 'utf8')).toBe(
    'checkout conversion control\r\n',
  )
  const emitter = await import(pathToFileURL(join(target, generator)).href)
  await emitter.embedCommonAuth(target)
  const expectedBytes = await readFile(
    join(root, outputPath, 'source-output.json'),
  )
  const actualBytes = await readFile(
    join(target, outputPath, 'source-output.json'),
  )
  const expected = JSON.parse(expectedBytes.toString())
  const actual = JSON.parse(actualBytes.toString())
  expect({ ...actual, generator: expected.generator }).toEqual(expected)
  const offset = actualBytes.findIndex(
    (byte, index) => byte !== expectedBytes[index],
  )
  expect(
    actual.generator.sha256,
    `source-output.json first differing byte: ${offset}`,
  ).toBe(expected.generator.sha256)
  expect(actualBytes.equals(expectedBytes)).toBe(true)
  await emitter.embedCommonAuth(target, true)
}, 120000)

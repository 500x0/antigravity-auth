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
  jobs: Record<
    string,
    {
      strategy: { matrix: { os: string[] } }
      steps: {
        run?: string
        uses?: string
        if?: string
        with?: Record<string, string>
      }[]
    }
  >
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

test('Windows Pi preflight loads the native verifier runtime in Node with product externals', async () => {
  const entry = '../../test/windows-pi-preflight/product-entry.mjs'
  const steps = workflow.jobs.vault!.steps
  const build = steps.find((step) => step.run?.includes(`esbuild ${entry} `))!
  const script = build.run!
  expect(script.indexOf(`esbuild ${entry} `)).toBeGreaterThan(
    script.indexOf('bun run --cwd packages/opencode build'),
  )
  expect(
    script.indexOf('bun run --cwd packages/opencode build'),
  ).toBeGreaterThan(script.indexOf('bun run --cwd packages/core build'))
  expect(script).toContain('bun run --cwd packages/core build')
  expect(steps.indexOf(build)).toBeLessThan(
    steps.findIndex((step) =>
      step.run?.includes('node test/windows-pi-preflight/verify.mjs $evidence'),
    ),
  )
  const expression = script.match(/^\s*\$externals = bun -e "([^"]+)"$/m)![1]!
  const externals = (await command(root, 'bun', ['-e', expression]))
    .trim()
    .split(/\r?\n/)
  expect(externals).toEqual(
    BUNDLE_EXTERNALS.map((name) => `--external:${name}`),
  )
  const line = script
    .split(/\r?\n/)
    .find((line) => line.includes(`esbuild ${entry} `))!
    .trim()
  for (const flag of [
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--sourcemap',
    '@externals',
  ])
    expect(line.split(/\s+/)).toContain(flag)
  const args = line
    .split(/\s+/)
    .flatMap((arg) => (arg === '@externals' ? externals : [arg]))
  expect(args.filter((arg) => arg.startsWith('--external:'))).toEqual(externals)
  const bundle = resolve(
    root,
    'packages/opencode',
    args
      .find((arg) => arg.startsWith('--outfile='))!
      .slice('--outfile='.length),
  )
  const metafile = join(await owned(), 'pi-meta.json')
  try {
    await command(root, args[0]!, [...args.slice(1), `--metafile=${metafile}`])
    const meta = JSON.parse(await readFile(metafile, 'utf8'))
    const map = JSON.parse(await readFile(`${bundle}.map`, 'utf8'))
    for (const source of ['src/setup.ts', 'src/cli.ts']) {
      expect(Object.keys(meta.inputs)).toContain(source)
      expect(map.sources).toContain(`../${source}`)
    }
    expect(Object.keys(meta.inputs)).toContain(entry)
    for (const dependency of BUNDLE_EXTERNALS) {
      expect(
        Object.keys(meta.inputs).some((path) =>
          path.includes(`/node_modules/${dependency}/`),
        ),
      ).toBe(false)
    }
    const imports =
      meta.outputs[
        Object.keys(meta.outputs).find((path) => path.endsWith('.mjs'))!
      ].imports
    for (const [dependency, kind] of [
      ['jsonc-parser', 'import-statement'],
      ['@cortexkit/private-files', 'dynamic-import'],
      ['@cortexkit/claustrum-client', 'import-statement'],
      ['@cortexkit/subc-client', 'import-statement'],
    ]) {
      expect(imports).toContainEqual({
        path: dependency,
        kind,
        external: true,
      })
    }
    const verifier = join(root, 'test/windows-pi-preflight/verify.mjs')
    const source = await readFile(verifier, 'utf8')
    // Load the verifier's own adapter imports so reverting to unbundled emits fails in Node.
    const runtimeEntries = [
      ...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
    ]
      .map((match) => match[1]!)
      .filter(
        (path) =>
          path.includes('packages/opencode/') &&
          !path.includes('/common-auth-embedded/'),
      )
      .map((path) => new URL(path, pathToFileURL(verifier)).href)
    expect(runtimeEntries.length).toBeGreaterThan(0)
    const loaded = await command(root, 'node', [
      '--input-type=module',
      '-e',
      `const exports = Object.assign({}, ...await Promise.all(${JSON.stringify(runtimeEntries)}.map(path => import(path)))); console.log(JSON.stringify(Object.fromEntries(Object.entries(exports).map(([name, value]) => [name, typeof value]))))`,
    ])
    expect(JSON.parse(loaded)).toEqual({
      assertSetupHostsStopped: 'function',
      createSetupPlugin: 'function',
      createDefaultCliDependencies: 'function',
    })
    expect(runtimeEntries).toEqual([pathToFileURL(bundle).href])
    expect(source).toContain("'test/windows-pi-preflight/product-entry.mjs'")
    expect(source).toContain(
      "'packages/opencode/dist/windows-pi-preflight-product.mjs'",
    )
  } finally {
    await rm(bundle, { force: true })
    await rm(`${bundle}.map`, { force: true })
  }
})

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

test('Windows Pi preflight runs on both vault runners and retains its result', () => {
  const job = workflow.jobs.vault!
  expect(job.strategy.matrix.os).toEqual(['windows-latest', 'windows-2022'])
  const proof = job.steps.find((step) =>
    step.run?.includes('node test/windows-pi-preflight/verify.mjs $evidence'),
  )
  expect(proof).toBeDefined()
  expect(proof?.run).toContain('exit $LASTEXITCODE')
  expect(proof?.run).toContain('AGY_PI_PREFLIGHT_EVIDENCE=$evidence')
  expect(job.steps).toContainEqual({
    uses: 'actions/upload-artifact@v4',
    if: 'always()',
    with: {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expands this expression, not JavaScript.
      name: 'windows-pi-preflight-${{ matrix.os }}',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expands this expression, not JavaScript.
      path: '${{ env.AGY_PI_PREFLIGHT_EVIDENCE }}',
      'if-no-files-found': 'error',
    },
  })
})

test('Windows Pi preflight builds verify embeddings before installing compiler dependencies', () => {
  const preparation = workflow.jobs.vault!.steps.find((step) =>
    step.run?.includes('bun install --cwd tools/common-auth-build'),
  )?.run
  expect(preparation).toBeDefined()
  const check = preparation!.indexOf(
    'bun packages/opencode/scripts/embed-common-auth.ts --check',
  )
  const install = preparation!.indexOf(
    'bun install --cwd tools/common-auth-build',
  )
  expect(check).toBeGreaterThanOrEqual(0)
  expect(install).toBeGreaterThan(check)
})

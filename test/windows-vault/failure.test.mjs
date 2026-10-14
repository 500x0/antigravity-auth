import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { failureDetails, redactFailureText } from './failure.mjs'

test('retains diagnostic name, code and message without credentials or user paths', async () => {
  const error = new Error('Enrollment token parent folder is not private')
  error.name = 'PrivateFilesUnavailableError'
  error.code = 'ERR_PRIVATE_FILES_SECURITY'
  error.stack =
    'PrivatePathError: hidden\n    at write (file:///C:/Users/private-user/client.js:5:6)\n    at async Manager.reconcile (file:///C:/Users/private-user/windows-vault-product.mjs:8678:13)'
  const result = await failureDetails(error, {
    bundleUrl: new URL('file:///missing/windows-vault-product.mjs'),
  })
  assert.deepEqual(result, {
    failureLocation: 'windows-vault-product.mjs:8678:13',
    failureProductLocation: 'windows-vault-product.mjs:8678:13',
    failureSourceLocation: null,
    failureError: {
      name: 'PrivateFilesUnavailableError',
      code: 'ERR_PRIVATE_FILES_SECURITY',
      message: 'Enrollment token parent folder is not private',
    },
  })
})

test('redacts secrets, quoted values, payloads and Windows and POSIX paths', () => {
  for (const sensitive of [
    'short-secret',
    'ab'.repeat(32),
    'Bearer synthetic-access',
    'request_secret=short-request',
    'connectionKey: short-key',
    'sk-private-value',
    'eyJprivate.value.signature',
    'ckh_private-value',
    '"private quoted value"',
    "'private quoted value'",
    '{"token":"private-value"}',
    '["private-value"]',
    'C:\\Users\\Private Person\\token.json',
    'C:/Users/Private Person/token.json',
    '\\\\server\\Private Person\\token.json',
    '/home/Private Person/token.json',
    'file:///C:/Users/Private%20Person/token.json',
    encodeURIComponent('short secret'),
  ]) {
    const redacted = redactFailureText(`Refused: ${sensitive}`, [
      'short-secret',
      'short secret',
    ])
    assert.ok(redacted.includes('<redacted>'), sensitive)
    assert.doesNotMatch(
      redacted,
      /private|short|synthetic|Person|Users|home|server|%20/i,
    )
    assert.equal(redacted.startsWith('Refused: '), true)
  }
  assert.equal(
    redactFailureText(
      'Private file refused at safe-parent: C:\\Users\\Private Person\\token.json (unsupported-filesystem). Use a safe parent directory.',
    ),
    'Private file refused at safe-parent: <redacted>(unsupported-filesystem). Use a safe parent directory.',
  )
  assert.equal(
    redactFailureText(
      'enrollment token folder C:\\Users\\Private Person\\vault is not private: Windows private-path verification refused: extra-ace',
    ),
    'enrollment token folder <redacted> is not private: Windows private-path verification refused: extra-ace',
  )
})

test('does not publish assertion operands, non-Error values or arbitrary error properties', async () => {
  const assertion = new assert.AssertionError({
    actual: 'private-value',
    expected: 'another-private-value',
    operator: 'strictEqual',
  })
  assertion.cause = new Error('private cause')
  assertion.token = 'private-token'
  const options = {
    bundleUrl: new URL('file:///missing/windows-vault-product.mjs'),
  }
  const result = await failureDetails(assertion, options)
  assert.equal(result.failureError.message, '[redacted assertion details]')
  assert.doesNotMatch(
    JSON.stringify(result),
    /private-value|private cause|private-token|actual|expected|stack/,
  )
  assert.deepEqual(
    (await failureDetails('private thrown value', options)).failureError,
    {
      name: 'NonErrorThrow',
      code: null,
      message: '[redacted non-Error value]',
    },
  )
  const custom = new Error('safe diagnostic')
  custom.name = 'private user path'
  custom.code = 'ab'.repeat(32)
  assert.deepEqual((await failureDetails(custom, options)).failureError, {
    name: '<redacted>',
    code: '<redacted>',
    message: 'safe diagnostic',
  })
  custom.code = 5
  assert.equal((await failureDetails(custom, options)).failureError.code, 5)
})

test('maps the first product frame and ignores paths outside the repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-vault-failure-'))
  const bundleUrl = pathToFileURL(join(root, 'windows-vault-product.mjs'))
  const error = new Error('not private')
  error.stack =
    'Error: not private\n    at verify (file:///private/verify.mjs:2:3)\n    at product (file:///private/windows-vault-product.mjs:1:1)\n    at later (file:///private/windows-vault-product.mjs:2:1)'
  const map = {
    version: 3,
    sources: [
      new URL(
        '../../packages/core/src/common-auth-embedded/claustrum/enrollment.js',
        import.meta.url,
      ).href,
    ],
    names: [],
    mappings: 'AAAA;AACA',
  }
  try {
    await mkdir(root, { recursive: true })
    await writeFile(new URL(`${bundleUrl}.map`), JSON.stringify(map))
    const result = await failureDetails(error, { bundleUrl })
    assert.equal(result.failureLocation, 'verify.mjs:2:3')
    assert.equal(result.failureProductLocation, 'windows-vault-product.mjs:1:1')
    assert.equal(
      result.failureSourceLocation,
      'packages/core/src/common-auth-embedded/claustrum/enrollment.js:1:1',
    )
    map.sources = ['file:///Users/private-user/module.js']
    await writeFile(new URL(`${bundleUrl}.map`), JSON.stringify(map))
    assert.equal(
      (await failureDetails(error, { bundleUrl })).failureSourceLocation,
      null,
    )
    await writeFile(new URL(`${bundleUrl}.map`), 'invalid map')
    assert.equal(
      (await failureDetails(error, { bundleUrl })).failureError.message,
      'not private',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { SourceMap } from 'node:module'
import { isAbsolute, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const mask = '<redacted>'
const repository = fileURLToPath(new URL('../../', import.meta.url))

const failureSymbol = (value, pattern, secrets) =>
  typeof value === 'string' &&
  value.length <= 80 &&
  pattern.test(value) &&
  !secrets.some((secret) => secret && value.includes(secret))
    ? value
    : mask

export function redactFailureText(value, secrets = []) {
  let text = String(value)
    // Quoted values and structured payloads can contain assertion operands or wire secrets.
    .replace(/(["'`])[^\r\n]*?\1/g, mask)
    .replace(/(?:\[|\{)[\s\S]*/g, mask)
    .replace(
      /(enrollment token folder )[^\r\n]+?( is not private:)/g,
      `$1${mask}$2`,
    )
    // Handle either host's path syntax, including file URLs, UNC paths and spaces.
    .replace(/(?:file:\/{2,3}|[A-Za-z]:[\\/]|\\\\)[^\r\n"'`<>|(),;]*/g, mask)
    .replace(
      /(^|[\s(:=])\/(?!\/)[^\r\n"'`<>|(),;]*/g,
      (_, prefix) => `${prefix}${mask}`,
    )
  for (const secret of secrets.filter(
    (secret) => typeof secret === 'string' && secret,
  )) {
    for (const form of [
      secret,
      JSON.stringify(secret).slice(1, -1),
      encodeURIComponent(secret),
    ])
      text = text.replaceAll(form, mask)
  }
  return text
    .replace(/\bBearer\s+\S+/gi, `Bearer ${mask}`)
    .replace(
      /\b(?:[\w-]*(?:token|secret|password|authorization|connection[_-]?key)[\w-]*)\s*[:=]\s*\S+/gi,
      (field) => `${field.split(/[:=]/, 1)[0]}=${mask}`,
    )
    .replace(/\b(?:sk-[\w-]+|eyJ[\w.-]+|ckh_[A-Za-z0-9_-]+)\b/g, mask)
    .replace(/[A-Za-z0-9_+/.=-]{24,}/g, mask)
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 1000)
}

export async function failureDetails(error, { bundleUrl, secrets = [] }) {
  const stack = error instanceof Error ? (error.stack ?? '') : ''
  const frames = stack.split('\n').filter((line) => /^\s*at\s/.test(line))
  const location =
    frames
      .join('\n')
      .match(/(?:verify|windows-vault-product)\.mjs:\d+:\d+/)?.[0] ?? null
  const product = frames
    .join('\n')
    .match(/windows-vault-product\.mjs:(\d+):(\d+)/)
  let sourceLocation = null
  if (product) {
    try {
      const map = new SourceMap(
        JSON.parse(await readFile(new URL(`${bundleUrl}.map`), 'utf8')),
      )
      const entry = map.findEntry(
        Number(product[1]) - 1,
        Number(product[2]) - 1,
      )
      if (entry.originalSource !== undefined) {
        const source = relative(
          repository,
          fileURLToPath(new URL(entry.originalSource, bundleUrl)),
        )
        // Only repository-relative source names belong in an uploaded receipt.
        if (!isAbsolute(source) && !source.startsWith('..'))
          sourceLocation = `${source.replaceAll('\\', '/')}:${entry.originalLine + 1}:${entry.originalColumn + 1}`
      }
    } catch {
      // A missing or invalid map must not replace the original failure.
    }
  }
  return {
    failureLocation: location,
    failureProductLocation: product?.[0] ?? null,
    failureSourceLocation: sourceLocation,
    failureError: {
      name:
        error instanceof Error
          ? failureSymbol(
              error.name,
              /^(?:Error|[A-Za-z][A-Za-z0-9]*Error)$/,
              secrets,
            )
          : 'NonErrorThrow',
      code:
        error instanceof Error && error.code !== undefined
          ? typeof error.code === 'number' && Number.isFinite(error.code)
            ? error.code
            : failureSymbol(
                error.code,
                /^(?:E[A-Z0-9_]+|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)$/,
                secrets,
              )
          : null,
      // Assertion messages may embed entire credential objects rather than just strings.
      message:
        error instanceof assert.AssertionError
          ? '[redacted assertion details]'
          : error instanceof Error
            ? redactFailureText(error.message, secrets)
            : '[redacted non-Error value]',
    },
  }
}

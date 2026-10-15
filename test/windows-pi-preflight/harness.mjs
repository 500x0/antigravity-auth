import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { failureDetails } from '../windows-vault/failure.mjs'

export function cliEnvironment(env, bin) {
  const child = { ...env }
  // Node selects the first sorted spelling when a Windows environment has aliases.
  const keys = Object.keys(env)
    .filter((key) => key.toLowerCase() === 'path')
    .sort()
  const key = keys[0] ?? 'PATH'
  for (const alias of keys) delete child[alias]
  child[key] = `${bin};${env[key] ?? ''}`
  return child
}

// Direct setup needs the same executable search path as the CLI child, without
// changing the parent process environment used by the other privacy checks.
export function runSetupWithEnvironment(
  runSetup,
  plugin,
  argv,
  environment,
  io = {},
) {
  return runSetup(plugin, argv, { ...io, env: environment })
}

export async function verifyWithReceipt({
  evidence,
  result,
  run,
  cleanup,
  bundleUrl,
  secrets = [],
  nativeWindows = false,
}) {
  result.status = 'running'
  result.stage = 'initialization'
  result.nativeWindowsQualified = false
  result.cleanupFailures = []
  const details = (error) => failureDetails(error, { bundleUrl, secrets })
  const fail = (stage, failure) => {
    result.status = 'failed'
    result.failedStage = stage
    Object.assign(result, failure)
    process.exitCode = 1
  }
  try {
    await run((stage) => {
      result.stage = stage
    })
  } catch (error) {
    fail(result.stage, await details(error))
  } finally {
    for (const [stage, action] of cleanup) {
      try {
        await action()
      } catch (error) {
        const failure = await details(error)
        result.cleanupFailures.push({ stage, ...failure })
        // Cleanup must not replace the failure that stopped verification.
        if (result.status !== 'failed') fail(stage, failure)
      }
    }
    const passed = result.status !== 'failed'
    result.nativeWindowsQualified =
      passed && nativeWindows && process.platform === 'win32'
    if (passed) {
      result.status = 'passed'
      result.stage = 'complete'
    }
    try {
      await mkdir(dirname(evidence), { recursive: true })
      await writeFile(evidence, `${JSON.stringify(result, null, 2)}\n`)
    } catch (error) {
      result.nativeWindowsQualified = false
      const failure = await details(error)
      result.receiptFailure = { stage: 'receipt-write', ...failure }
      if (result.status !== 'failed') fail('receipt-write', failure)
    }
  }
  if (result.status === 'failed') {
    // Preserve safe diagnostics even when the receipt itself could not be written.
    console.error(
      JSON.stringify({
        failedStage: result.failedStage,
        failureError: result.failureError,
        cleanupFailures: result.cleanupFailures,
        receiptFailure: result.receiptFailure,
      }),
    )
  }
  return result
}

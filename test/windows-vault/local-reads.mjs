import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function installLocalReadFence(accountFile, native) {
  const prefix = resolve(accountFile).toLowerCase()
  const events = []
  const restores = []
  const patch = (object, name) => {
    const original = object[name]
    object[name] = function (path, ...args) {
      const value = path instanceof URL ? fileURLToPath(path) : path
      if (
        (typeof value === 'string' || Buffer.isBuffer(value)) &&
        resolve(String(value)).toLowerCase().startsWith(prefix)
      ) {
        events.push(name)
        throw Object.assign(new Error('Local account read is forbidden'), {
          code: 'LOCAL_ACCOUNT_READ',
        })
      }
      return original.call(this, path, ...args)
    }
    restores.push(() => {
      object[name] = original
    })
  }
  for (const name of [
    'readFileSync',
    'readFile',
    'openSync',
    'open',
    'createReadStream',
  ])
    patch(fs, name)
  for (const name of ['readFile', 'open']) patch(fsp, name)
  // Windows private-files reads inside the N-API addon, bypassing node:fs.
  if (native) patch(native, 'read')
  syncBuiltinESMExports()
  return {
    events,
    reset: () => {
      events.length = 0
    },
    restore: () => {
      for (const restore of restores.reverse()) restore()
      syncBuiltinESMExports()
    },
  }
}

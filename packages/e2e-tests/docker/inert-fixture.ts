import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'

export interface InertIdentity {
  pid: number
  start: string
  namespace: string
  cgroup: string
  pgid: number
  sid: number
  port?: number
}
export type InertReadyIdentity = InertIdentity & { port: number }

export function captureInertBirth(pid: number): InertIdentity {
  if (!Number.isInteger(pid) || pid <= 1)
    throw new Error('invalid actor birth PID')
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  const start = fields[19]
  if (!start || !/^\d+$/.test(start))
    throw new Error(`invalid actor birth stat: /proc/${pid}/stat`)
  return {
    pid,
    start,
    pgid: Number(fields[2]),
    sid: Number(fields[3]),
    namespace: fs.readlinkSync(`/proc/${pid}/ns/pid`),
    cgroup: fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8'),
  }
}

// The generated actor imports this module too; the half-write hook pauses the
// actual publisher, not a second implementation of its visibility protocol.
export async function publishInertFixture(
  path: string,
  value: unknown,
  afterHalfWrite?: () => void | Promise<void>,
): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  let file: number | undefined
  try {
    const bytes = Buffer.from(JSON.stringify(value))
    const middle = Math.floor(bytes.length / 2)
    file = fs.openSync(temporary, 'wx')
    fs.writeFileSync(file, bytes.subarray(0, middle))
    await afterHalfWrite?.()
    fs.writeFileSync(file, bytes.subarray(middle))
    fs.fsyncSync(file)
    fs.closeSync(file)
    file = undefined
    fs.renameSync(temporary, path)
  } catch (error) {
    const errors = [error]
    if (file !== undefined) {
      try {
        fs.closeSync(file)
      } catch (closeError) {
        errors.push(closeError)
      }
    }
    try {
      fs.rmSync(temporary, { force: true })
    } catch (removeError) {
      errors.push(removeError)
    }
    throw new Error(`cannot publish actor fixture ${path} via ${temporary}`, {
      cause: errors.length === 1 ? error : new AggregateError(errors),
    })
  }
}

export function readInertIdentity(
  path: string,
  ready: true,
  read?: typeof fs.readFileSync,
): InertReadyIdentity | undefined
export function readInertIdentity(
  path: string,
  ready?: false,
  read?: typeof fs.readFileSync,
): InertIdentity | undefined
export function readInertIdentity(
  path: string,
  ready = false,
  read: typeof fs.readFileSync = fs.readFileSync,
): InertIdentity | undefined {
  let text: string
  try {
    text = read(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`cannot read actor fixture ${path}`, { cause: error })
  }
  try {
    const row = JSON.parse(text) as InertIdentity
    if (
      !row ||
      !Number.isInteger(row.pid) ||
      row.pid <= 1 ||
      typeof row.start !== 'string' ||
      !/^\d+$/.test(row.start) ||
      typeof row.namespace !== 'string' ||
      !/^pid:\[\d+\]$/.test(row.namespace) ||
      typeof row.cgroup !== 'string' ||
      !row.cgroup.trim() ||
      !Number.isInteger(row.pgid) ||
      row.pgid < 1 ||
      !Number.isInteger(row.sid) ||
      row.sid < 1 ||
      ((ready || row.port !== undefined) &&
        (typeof row.port !== 'number' ||
          !Number.isInteger(row.port) ||
          row.port < 1 ||
          row.port > 65535))
    )
      throw new Error('invalid birth identity or listener port')
    return row
  } catch (error) {
    throw new Error(`invalid actor fixture ${path}`, { cause: error })
  }
}

export async function waitForInertReady(
  path: string,
  deadline: number,
  options: {
    now?: () => number
    absent?: () => void | Promise<void>
  } = {},
): Promise<InertReadyIdentity> {
  const now = options.now ?? (() => performance.now())
  while (now() < deadline) {
    const identity = readInertIdentity(path, true)
    if (now() >= deadline) break
    if (identity) return identity
    await options.absent?.()
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error(`actor fixture setup deadline expired: ${path}`)
}

export async function readyBeforeInertCleanup(
  ready: Promise<InertReadyIdentity>,
  trigger: () => void | Promise<void>,
  arm: (identity: InertReadyIdentity) => void = () => {},
): Promise<InertReadyIdentity> {
  const identity = await ready
  arm(identity)
  await trigger()
  return identity
}

// Teardown failures must not replace the assertion that led to teardown, or
// prevent pending-command settlement and removal of the fixture directory.
export async function finishInertTest(
  errors: unknown[],
  steps: (() => unknown)[],
): Promise<void> {
  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length)
    throw new AggregateError(errors, 'actor test and teardown failed')
}

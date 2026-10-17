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

export interface InertChild {
  identity?: InertIdentity
  closed: () => boolean
  retainedAt?: number
}

export interface InertDeadlineDiagnostic {
  testName: string
  identities: () => InertIdentity[]
  children?: () => InertChild[]
  emit: (line: string) => void
  reported?: Set<string>
}

function inertStat(path: string) {
  try {
    const text = fs.readFileSync(path, 'utf8')
    const fields = text
      .slice(text.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/)
    const start = fields[19]
    const state = fields[0]
    if (
      !start ||
      !/^\d+$/.test(start) ||
      !state ||
      !/^\d+$/.test(fields[1] ?? '')
    )
      throw new Error(`invalid owned actor stat: ${path}`)
    return { start, state, ppid: Number(fields[1]) }
  } catch (error) {
    if (
      ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')
    )
      return undefined
    throw error
  }
}

export function reportInertDeadline(
  kind: 'departure' | 'readiness' | 'completion',
  deadline: number,
  diagnostic?: InertDeadlineDiagnostic,
  missingReady?: string,
  now: () => number = () => performance.now(),
): void {
  if (!diagnostic) return
  try {
    const key = JSON.stringify([kind, deadline, missingReady])
    if (diagnostic.reported?.has(key)) return
    diagnostic.reported?.add(key)
    const elapsedMs = now() - (deadline - 500)
    const identities = [
      ...new Map(
        diagnostic
          .identities()
          .map(
            (identity) =>
              [`${identity.pid}:${identity.start}`, identity] as const,
          ),
      ).values(),
    ].map((identity) => {
      const expected = { pid: identity.pid, start: identity.start }
      try {
        const observed = inertStat(`/proc/${identity.pid}/stat`)
        return {
          ...expected,
          observedStart: observed?.start ?? null,
          state: observed?.state ?? null,
          ppid: observed?.ppid ?? null,
          matched: observed?.start === identity.start,
        }
      } catch (error) {
        return {
          ...expected,
          observedStart: null,
          state: null,
          ppid: null,
          matched: null,
          error: String(error),
        }
      }
    })
    diagnostic.emit(
      `INERT_DEADLINE_SNAPSHOT=${JSON.stringify({
        testName: diagnostic.testName,
        kind,
        budgetMs: 500,
        elapsedMs,
        identities,
        ...(missingReady === undefined ? {} : { missingReady }),
        children:
          diagnostic.children?.().map((child) => ({
            pid: child.identity?.pid ?? null,
            start: child.identity?.start ?? null,
            closed: child.closed(),
            retainedAtMs: child.retainedAt ?? null,
          })) ?? [],
      })}`,
    )
  } catch {
    // Diagnostics must not replace a deadline failure, even if their sink fails.
  }
}

export function inertAlive(identity: InertIdentity): boolean {
  const observed = inertStat(`/proc/${identity.pid}/stat`)
  return (
    observed?.start === identity.start && !['Z', 'X'].includes(observed.state)
  )
}

export function inertActorTasksRemain(identity: InertIdentity): boolean {
  const leader = inertStat(`/proc/${identity.pid}/stat`)
  if (leader?.start !== identity.start) return false
  if (!['Z', 'X'].includes(leader.state)) return true
  // A terminal leader can still have a live sibling. Only inspect its own task
  // directory, never shared job membership or another process's /proc entry.
  try {
    const tids = fs.readdirSync(`/proc/${identity.pid}/task`)
    for (const tid of tids) {
      if (!/^\d+$/.test(tid)) throw new Error('invalid owned task identity')
      const task = inertStat(`/proc/${identity.pid}/task/${tid}/stat`)
      if (task && !['Z', 'X'].includes(task.state)) {
        return inertStat(`/proc/${identity.pid}/stat`)?.start === identity.start
      }
    }
  } catch (error) {
    if (
      !['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')
    )
      throw error
  }
  return false
}

export async function waitForInertDeparture(
  identities: InertIdentity[],
  children: InertChild[],
  deadline: number,
  diagnostic?: InertDeadlineDiagnostic,
): Promise<void> {
  while (performance.now() < deadline) {
    const departed = !identities.some(inertActorTasksRemain)
    if (performance.now() >= deadline) break
    if (departed && children.every((child) => child.closed())) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  reportInertDeadline('departure', deadline, diagnostic)
  throw new Error('independent fixture task departure deadline exceeded')
}

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
    // Rename is atomically visible to other processes on this running system.
    // Fsync only adds power-loss durability, which a test fixture does not need.
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
    diagnostic?: InertDeadlineDiagnostic
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
  reportInertDeadline('readiness', deadline, options.diagnostic, path, now)
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

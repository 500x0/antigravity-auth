import { afterEach } from 'bun:test'
import { AsyncLocalStorage } from 'node:async_hooks'

type Trace = {
  id: string
  start: number
  complete: boolean
  dumped: boolean
  phases: [string, number][]
}
const scope = new AsyncLocalStorage<Trace>()
const pending = new Set<Trace>()
let sequence = 0

export function phase(stage: string): void {
  const trace = scope.getStore()
  if (trace)
    trace.phases.push([
      stage,
      Number((performance.now() - trace.start).toFixed(3)),
    ])
}

function dump(trace: Trace): void {
  if (trace.dumped) return
  trace.dumped = true
  console.error(
    `E2E_PHASE_FAILURE ${JSON.stringify({ id: trace.id, phases: trace.phases })}`,
  )
}

// Async-local traces keep a timed-out case separate from its later continuations.
// Only failed or unfinished cases emit stage names, monotonic times and a synthetic ID.
export async function runDiagnosticCase(
  action: () => Promise<void>,
): Promise<void> {
  const trace: Trace = {
    id: `plugin-flow-case-${++sequence}`,
    start: performance.now(),
    complete: false,
    dumped: false,
    phases: [],
  }
  pending.add(trace)
  return scope.run(trace, async () => {
    phase('withHarness.entry')
    try {
      await action()
      phase('withHarness.complete')
      trace.complete = true
    } catch (error) {
      phase('withHarness.rejected')
      dump(trace)
      throw error
    } finally {
      if (trace.complete) pending.delete(trace)
    }
  })
}

afterEach(() => {
  for (const trace of pending) dump(trace)
})
process.on('beforeExit', () => {
  for (const trace of pending) dump(trace)
})

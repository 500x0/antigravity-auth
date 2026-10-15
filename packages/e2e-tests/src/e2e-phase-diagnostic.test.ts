import { expect, it, spyOn } from 'bun:test'
import { phase, runDiagnosticCase } from './e2e-phase-diagnostic'

it('phase diagnostic stays silent for a completed passing case', async () => {
  const output = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await runDiagnosticCase(async () => {
      phase('owned.success')
    })
    expect(output).not.toHaveBeenCalled()
  } finally {
    output.mockRestore()
  }
})

it('phase diagnostic emits stage clocks without exception payload on rejection', async () => {
  const output = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await expect(
      runDiagnosticCase(async () => {
        phase('owned.failure')
        throw new Error('synthetic-exception-payload')
      }),
    ).rejects.toThrow('synthetic-exception-payload')
    expect(output).toHaveBeenCalledTimes(1)
    const line = String(output.mock.calls[0]?.[0])
    expect(line.startsWith('E2E_PHASE_FAILURE ')).toBe(true)
    const trace = JSON.parse(line.slice('E2E_PHASE_FAILURE '.length))
    expect(trace.id).toMatch(/^plugin-flow-case-\d+$/)
    expect(trace.phases.map(([stage]: [string, number]) => stage)).toEqual([
      'withHarness.entry',
      'owned.failure',
      'withHarness.rejected',
    ])
    expect(
      trace.phases.every(
        ([, time]: [string, number]) => Number.isFinite(time) && time >= 0,
      ),
    ).toBe(true)
    expect(line).not.toContain('synthetic-exception-payload')
  } finally {
    output.mockRestore()
  }
})

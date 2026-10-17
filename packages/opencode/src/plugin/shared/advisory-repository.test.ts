import { expect, it } from 'bun:test'
import type { AccountFlushReport } from '@cortexkit/antigravity-auth-core'
import { createAdvisoryRepositoryOwner } from './advisory-repository.ts'

it('counts multiple owned advisory refusals without logging their contents', async () => {
  const errors = [new Error('private row one'), new Error('private row two')]
  const report = { completed: 0, failures: [] }
  const logs: { message: string; fields?: Record<string, unknown> }[] = []
  let attempt = 0
  const source = {
    recordQuota: async () => {
      throw errors[attempt++]
    },
    flush: async (): Promise<AccountFlushReport> => {
      throw new AggregateError(errors, 'authority refused', { cause: report })
    },
    dispose: async () => report,
  }
  const owner = createAdvisoryRepositoryOwner(source, {
    debug: (message, fields) => logs.push({ message, fields }),
  })
  for (const error of errors)
    await expect(owner.repository.recordQuota()).rejects.toBe(error)
  expect(await owner.repository.flush()).toBe(report)
  expect(logs).toEqual([
    { message: 'post-response-local-write-refused', fields: { count: 2 } },
  ])
})

it('keeps unowned refusals even when their message matches an owned refusal', async () => {
  const own = new Error('same refusal text')
  const other = new Error(own.message)
  const report = { completed: 0, failures: [] }
  const source = {
    recordQuota: async () => {
      throw own
    },
    flush: async (): Promise<AccountFlushReport> => {
      throw new AggregateError([own, other], 'authority refused', {
        cause: report,
      })
    },
    dispose: async () => report,
  }
  const logs: unknown[] = []
  const owner = createAdvisoryRepositoryOwner(source, {
    debug: (...args) => logs.push(args),
  })
  await expect(owner.repository.recordQuota()).rejects.toBe(own)
  let caught: unknown
  try {
    await owner.repository.flush()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(AggregateError)
  if (!(caught instanceof AggregateError))
    throw new Error('unowned refusal was absorbed')
  expect(caught.errors).toHaveLength(1)
  expect(caught.errors[0]).toBe(other)
  expect(caught.cause).toBe(report)
  expect(logs).toEqual([['post-response-local-write-refused', { count: 1 }]])
})

it('does not replace a missing underlying report with an empty successful flush', async () => {
  const own = new Error('refused')
  const aggregate = new AggregateError([own], 'authority refused')
  const source = {
    recordQuota: async () => {
      throw own
    },
    flush: async (): Promise<AccountFlushReport> => {
      throw aggregate
    },
    dispose: async () => ({ completed: 0, failures: [] }),
  }
  const logs: unknown[] = []
  const owner = createAdvisoryRepositoryOwner(source, {
    debug: (...args) => logs.push(args),
  })
  await expect(owner.repository.recordQuota()).rejects.toBe(own)
  await expect(owner.repository.flush()).rejects.toBe(aggregate)
  expect(logs).toEqual([])
})

it('drains admitted advisory calls and preserves direct required flush failures', async () => {
  const reached = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const refusal = new Error('refused')
  const required = new Error('required durability failed')
  const source = {
    recordQuota: async () => {
      reached.resolve()
      await gate.promise
      throw refusal
    },
    flush: async (): Promise<AccountFlushReport> => {
      throw required
    },
    dispose: async () => ({ completed: 0, failures: [] }),
  }
  const owner = createAdvisoryRepositoryOwner(source, { debug: () => {} })
  const write = owner.repository.recordQuota()
  const rejected = write.catch((error: unknown) => error)
  await reached.promise
  let drained = false
  const drain = owner.drain().then(() => {
    drained = true
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(drained).toBe(false)
  gate.resolve()
  expect(await rejected).toBe(refusal)
  await drain
  expect(drained).toBe(true)
  await expect(owner.repository.flush()).rejects.toBe(required)
})

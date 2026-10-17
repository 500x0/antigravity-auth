import type { AccountFlushReport } from '@cortexkit/antigravity-auth-core'

interface DrainableRepository {
  flush(): Promise<AccountFlushReport>
  dispose(): Promise<AccountFlushReport>
}

/**
 * Tracks the account manager's best-effort observations: last-used metadata,
 * selection and quota readings. Use this wrapper for the request manager, not
 * general repository consumers. Credential refresh, project persistence and
 * account-management calls keep their normal error and durability requirements.
 */
export function createAdvisoryRepositoryOwner<R extends DrainableRepository>(
  repository: R,
  log: { debug(message: string, fields?: Record<string, unknown>): void },
) {
  const methods = new Map<PropertyKey, unknown>()
  const advisoryMethods = new Set<PropertyKey>([
    'updateMetadata',
    'selectAccount',
    'recordQuota',
  ])
  const pending = new Set<Promise<unknown>>()
  const failures = new Set<unknown>()
  const drain = async () => {
    while (pending.size > 0) await Promise.allSettled([...pending])
  }
  const owned = new Proxy(repository, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target)
      if (typeof value !== 'function') return value
      if (!methods.has(key)) {
        if (advisoryMethods.has(key)) {
          methods.set(key, (...args: unknown[]) => {
            const work = (async () => Reflect.apply(value, target, args))()
            pending.add(work)
            void work.then(
              () => pending.delete(work),
              (error: unknown) => {
                failures.add(error)
                pending.delete(work)
              },
            )
            return work
          })
        } else if (key === 'flush' || key === 'dispose') {
          methods.set(key, async (...args: unknown[]) => {
            await drain()
            try {
              return await Reflect.apply(value, target, args)
            } catch (error) {
              if (
                !(error instanceof AggregateError) ||
                !isFlushReport(error.cause)
              )
                throw error
              // Absorb only the exact errors recorded when wrapped observation
              // calls rejected, never other errors with matching messages.
              const absorbed = error.errors.filter((reason: unknown) =>
                failures.has(reason),
              )
              if (absorbed.length === 0) throw error
              const remaining = error.errors.filter(
                (reason: unknown) => !failures.has(reason),
              )
              for (const reason of absorbed) failures.delete(reason)
              log.debug('post-response-local-write-refused', {
                count: absorbed.length,
              })
              if (remaining.length > 0)
                throw new AggregateError(remaining, error.message, {
                  cause: error.cause,
                })
              // The OpenCode 2 local-authority wrapper puts its flush()/dispose()
              // result in error.cause when it throws refused writes. That call cleared the
              // completed-write/failure queue. Return its original result so the
              // manager still sees credential failures; a second flush could not.
              return error.cause
            }
          })
        } else {
          methods.set(key, value.bind(target))
        }
      }
      return methods.get(key)
    },
  })
  return {
    repository: owned,
    owns: (error: unknown) => failures.has(error),
    drain,
  }
}

function isFlushReport(value: unknown): value is AccountFlushReport {
  return (
    typeof value === 'object' &&
    value !== null &&
    'completed' in value &&
    typeof value.completed === 'number' &&
    'failures' in value &&
    Array.isArray(value.failures)
  )
}

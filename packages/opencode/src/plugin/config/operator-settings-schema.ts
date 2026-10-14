/**
 * Schema for runtime operator-controlled settings.
 *
 * These are the fields the /antigravity-* slash commands mutate at runtime.
 * They live under `config.operator.*` and persist via
 * `config/writer.ts` (fenced lock + atomic rename).
 */

import { z } from 'zod'

export const OperatorSettingsSchema = z.object({
  killswitch: z.object({
    enabled: z.boolean(),
    minimum_remaining_percent: z.number().min(0).max(100),
    accounts: z.record(z.string(), z.number().min(0).max(100)).optional(),
  }),
  log_level: z.enum(['error', 'warn', 'info', 'debug', 'trace']),
})

export type OperatorSettings = z.infer<typeof OperatorSettingsSchema>

export function emptyOperatorSettings(): OperatorSettings {
  return {
    killswitch: { enabled: false, minimum_remaining_percent: 5 },
    log_level: 'info',
  }
}

import {
  formatQuota,
  NO_QUOTA_READING,
  type ProjectedLimit,
  type ProjectedQuota,
  quotaTextParts,
  quotaWindowName,
} from './common-auth-embedded/quota/index.js'

export { NO_QUOTA_READING }

export interface QuotaReading {
  readonly remainingPercent: number
  readonly resetAt?: number
  readonly checkedAt?: number
  readonly window?: 'weekly' | '5h'
}

function projectReading(
  label: string,
  reading: QuotaReading | undefined,
): ProjectedQuota | undefined {
  const checkedAt = reading?.checkedAt
  if (
    !reading ||
    typeof checkedAt !== 'number' ||
    !Number.isFinite(checkedAt) ||
    checkedAt < 0 ||
    !Number.isFinite(reading.remainingPercent)
  )
    return undefined
  const limit: ProjectedLimit = {
    scope: reading.window ? 'all' : label,
    label,
    kind: 'reading',
    checkedAt,
    remainingPercent: Math.max(0, Math.min(100, reading.remainingPercent)),
    ...(reading.window
      ? { windowMinutes: reading.window === 'weekly' ? 7 * 24 * 60 : 5 * 60 }
      : {}),
    ...(typeof reading.resetAt === 'number' &&
    Number.isFinite(reading.resetAt) &&
    Math.abs(reading.resetAt) <= 8.64e15
      ? { resetsAt: new Date(reading.resetAt).toISOString() }
      : {}),
  }
  return { scope: 'all', limits: [limit], checkedAt }
}

/** A quota figure needs its own read timestamp; snapshot writes never supply one. */
export function formatQuotaReading(
  label: string,
  reading: QuotaReading | undefined,
  now: number,
): string {
  return formatQuota(projectReading(label, reading), { now })
}

/**
 * One window's pieces for a sidebar row that must fit on a single line: the
 * window name (`5h`, `7d`; empty for a pool stored without a window length),
 * the figure (`95% left`) and the bare reset span (`2h`). All three are cut
 * from the shared formatter's text, so the wording stays the formatter's.
 */
export interface QuotaWindowText {
  readonly name: string
  /** `95% left`, or `NO_QUOTA_READING` when the reading has no read time. */
  readonly figure: string
  /** Time until the next reset; empty when none is stored or it already passed. */
  readonly reset: string
  readonly remaining: number | null
  /**
   * The window reset after this reading was taken. The stored figure then
   * describes the window before that reset, not the quota now. A reset stored
   * at or before the read time already lay behind the reading and does not
   * count.
   */
  readonly resetSinceReading: boolean
}

export function quotaWindowText(
  reading: QuotaReading | undefined,
  now: number,
): QuotaWindowText {
  const projected = projectReading('', reading)
  const limit = projected?.limits[0]
  if (!projected || !limit || !reading)
    return {
      name: '',
      figure: NO_QUOTA_READING,
      reset: '',
      remaining: null,
      resetSinceReading: false,
    }
  // The reading age is shown once per account, so leave it out of each window.
  const options = { now, staleAfterMs: Number.POSITIVE_INFINITY }
  const compact = quotaTextParts(projected, { ...options, form: 'compact' })[0]
  const full = quotaTextParts(projected, options)[0]
  const name = reading.window ? quotaWindowName(limit) : ''
  const first = compact ?? ''
  const prefix = `${quotaWindowName(limit)} `
  return {
    name,
    figure: first.startsWith(prefix) ? first.slice(prefix.length) : first,
    reset: (full ?? '').slice(first.length).replace(/^, resets /, ''),
    remaining: limit.remainingPercent ?? null,
    resetSinceReading:
      typeof reading.resetAt === 'number' &&
      Number.isFinite(reading.resetAt) &&
      reading.resetAt <= now &&
      reading.resetAt > limit.checkedAt,
  }
}

/**
 * The shared formatter's `checked 2d ago` for the oldest of several readings,
 * or empty while the oldest is younger than the formatter's stale threshold.
 * Undated readings carry no age and are ignored.
 */
export function quotaReadingAge(
  readings: readonly (QuotaReading | undefined)[],
  now: number,
): string {
  const limits = readings.flatMap(
    (reading, index) =>
      projectReading(`reading ${index}`, reading)?.limits ?? [],
  )
  if (limits.length === 0) return ''
  const parts = quotaTextParts(
    {
      scope: 'all',
      limits,
      checkedAt: Math.min(...limits.map((limit) => limit.checkedAt)),
    },
    { now, form: 'compact' },
  )
  const last = parts.at(-1) ?? ''
  return last.startsWith('checked ') ? last : ''
}

/** Use common-auth's formatQuota text for a bar row without separately formatting figures, resets or ages. */
export function quotaReadingParts(
  label: string,
  reading: QuotaReading | undefined,
  now: number,
): {
  name: string
  figure: string
  detail: string
  remaining: number | null
} {
  const projected = projectReading(label, reading)
  const limit = projected?.limits[0]
  if (!limit)
    return {
      name: label,
      figure: NO_QUOTA_READING,
      detail: '',
      remaining: null,
    }
  const full = quotaTextParts(projected, { now })
  const compact = quotaTextParts(projected, { now, form: 'compact' })
  const name = quotaWindowName(limit)
  const first = compact[0] ?? ''
  const figure = first.startsWith(`${name} `)
    ? first.slice(name.length + 1)
    : first
  const reset = (full[0] ?? '').slice(first.length).replace(/^, /, '')
  return {
    name,
    figure,
    detail: [reset, ...full.slice(1)].filter(Boolean).join(' · '),
    remaining: limit.remainingPercent ?? null,
  }
}

import {
  formatQuota,
  NO_QUOTA_READING,
  type ProjectedLimit,
  type ProjectedQuota,
  quotaWindowParts,
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
 * the figure (`95% left`) and the bare reset span (`2h`). All three come
 * from `quotaWindowParts`, keeping common-auth's wording intact.
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
  // The reading age is shown once per account, so leave it out of each window.
  const part = quotaWindowParts(projectReading('', reading), {
    now,
    form: 'full',
    staleAfterMs: Number.POSITIVE_INFINITY,
  }).windows[0]
  if (!part)
    return {
      name: '',
      figure: NO_QUOTA_READING,
      reset: '',
      remaining: null,
      resetSinceReading: false,
    }
  return {
    name: part.name,
    figure: part.figure,
    reset: part.resetIn ?? '',
    remaining: part.remainingPercent ?? null,
    resetSinceReading: part.resetSinceReading,
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
  return (
    quotaWindowParts(
      {
        scope: 'all',
        limits,
        checkedAt: Math.min(...limits.map((limit) => limit.checkedAt)),
      },
      { now, form: 'compact' },
    ).age ?? ''
  )
}

/** Use `quotaWindowParts` for a bar row without separately formatting figures, resets or ages. */
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
  const parts = quotaWindowParts(projectReading(label, reading), {
    now,
    form: 'full',
  })
  const part = parts.windows[0]
  if (!part)
    return {
      name: label,
      figure: NO_QUOTA_READING,
      detail: '',
      remaining: null,
    }
  return {
    name: part.name,
    figure: part.figure,
    detail: [part.resetIn ? `resets ${part.resetIn}` : '', parts.age]
      .filter(Boolean)
      .join(' · '),
    remaining: part.remainingPercent ?? null,
  }
}

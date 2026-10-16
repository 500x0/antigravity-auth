import { describe, expect, it } from 'bun:test'
import {
  formatQuota,
  quotaTextParts,
} from './common-auth-embedded/quota/index.js'
import {
  formatQuotaReading,
  NO_QUOTA_READING,
  quotaReadingAge,
  quotaReadingParts,
  quotaWindowText,
} from './quota-presentation'

const now = 1_800_000_000_000

describe('client quota presentation', () => {
  it('uses the same full text and bar pieces as the public formatter', () => {
    const reading = {
      window: 'weekly' as const,
      remainingPercent: 58,
      checkedAt: now - 20 * 60_000,
      resetAt: now + 2 * 3_600_000,
    }
    const quota = {
      scope: 'all',
      checkedAt: reading.checkedAt,
      limits: [
        {
          scope: 'all',
          label: 'Gemini',
          kind: 'reading' as const,
          checkedAt: reading.checkedAt,
          windowMinutes: 7 * 24 * 60,
          remainingPercent: 58,
          resetsAt: new Date(reading.resetAt).toISOString(),
        },
      ],
    }
    expect(formatQuotaReading('Gemini', reading, now)).toBe(
      formatQuota(quota, { now }),
    )
    const pieces = quotaReadingParts('Gemini', reading, now)
    expect(pieces.name).toBe('7d')
    expect(pieces.figure).toBe('58% left')
    expect(pieces.remaining).toBe(58)
    expect(pieces.detail).toBe(
      quotaTextParts(quota, { now })[0]!.split(', ')[1] +
        ' · ' +
        quotaTextParts(quota, { now })[1],
    )
    expect(pieces.detail).toContain('checked 20m ago')
  })

  it('does not manufacture a reading age or a figure for undated quota', () => {
    for (const checkedAt of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
    ]) {
      const reading = { remainingPercent: 58, checkedAt, resetAt: now + 1000 }
      expect(formatQuotaReading('Gemini', reading, now)).toBe(NO_QUOTA_READING)
      expect(quotaReadingParts('Gemini', reading, now)).toEqual({
        name: 'Gemini',
        figure: NO_QUOTA_READING,
        detail: '',
        remaining: null,
      })
    }
  })

  it('uses a model label without inventing an unreported window or reset', () => {
    const reading = { remainingPercent: 25, checkedAt: now }
    expect(formatQuotaReading('Claude', reading, now)).toBe('Claude 25% left')
    expect(quotaReadingParts('Claude', reading, now)).toEqual({
      name: 'Claude',
      figure: '25% left',
      detail: '',
      remaining: 25,
    })
  })
})

describe('sidebar window text', () => {
  const hour = 3_600_000

  it('splits the formatter text into name, figure and bare reset span', () => {
    const reading = {
      window: '5h' as const,
      remainingPercent: 95,
      checkedAt: now - 2 * 60_000,
      resetAt: now + 2 * hour,
    }
    const quota = {
      scope: 'all',
      checkedAt: reading.checkedAt,
      limits: [
        {
          scope: 'all',
          label: '',
          kind: 'reading' as const,
          checkedAt: reading.checkedAt,
          windowMinutes: 5 * 60,
          remainingPercent: 95,
          resetsAt: new Date(reading.resetAt).toISOString(),
        },
      ],
    }
    expect(quotaTextParts(quota, { now })).toEqual(['5h 95% left, resets 2h'])
    expect(quotaWindowText(reading, now)).toEqual({
      name: '5h',
      figure: '95% left',
      reset: '2h',
      remaining: 95,
      resetSinceReading: false,
    })
  })

  it('marks a window that reset after its reading and drops the passed reset', () => {
    const checkedAt = now - 41 * hour
    const text = quotaWindowText(
      {
        window: 'weekly',
        remainingPercent: 0,
        checkedAt,
        resetAt: checkedAt + 20 * hour,
      },
      now,
    )
    expect(text.resetSinceReading).toBe(true)
    expect(text.reset).toBe('')
    expect(text.name).toBe('7d')
  })

  it('keeps the figure when the stored reset lay at or before the reading', () => {
    for (const resetAt of [now - hour, now - 2 * hour]) {
      const text = quotaWindowText(
        { window: '5h', remainingPercent: 40, checkedAt: now - hour, resetAt },
        now,
      )
      expect(text.resetSinceReading).toBe(false)
      expect(text.figure).toBe('40% left')
    }
  })

  it('leaves a pool stored without a window length unnamed', () => {
    expect(
      quotaWindowText({ remainingPercent: 75, checkedAt: now }, now),
    ).toEqual({
      name: '',
      figure: '75% left',
      reset: '',
      remaining: 75,
      resetSinceReading: false,
    })
  })

  it('reports the oldest dated reading age once, in the formatter wording', () => {
    expect(
      quotaReadingAge(
        [
          { remainingPercent: 50, checkedAt: now - 5 * 60_000 },
          { remainingPercent: 50, checkedAt: now - 41 * hour, window: '5h' },
          { remainingPercent: 50, checkedAt: undefined },
          undefined,
        ],
        now,
      ),
    ).toBe('checked 1d17h ago')
    expect(
      quotaReadingAge(
        [{ remainingPercent: 50, checkedAt: now - 5 * 60_000 }],
        now,
      ),
    ).toBe('')
    expect(quotaReadingAge([], now)).toBe('')
  })
})

/** @jsxImportSource @opentui/solid */

/**
 * Full-frame captures of the OpenCode 1 sidebar at the widths the host
 * sidebar actually has (32, 38 and 48 columns). Each scenario renders with a
 * fixed clock so the reset countdowns and reading ages are deterministic.
 *
 * Every quota window must stay on one line at every width, the window names
 * must be the plain group headers, a reading whose reset time has already
 * passed must not be shown as the current figure, and a session without a
 * route must not render a placeholder row.
 *
 * Set AGY_PRINT_FRAMES=1 to print every captured frame.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testRender } from '@opentui/solid'
import {
  DEFAULT_SIDEBAR_STATE,
  SIDEBAR_STATE_ENV,
  SIDEBAR_STATE_VERSION,
  type SidebarAccountState,
  type SidebarStateV1,
} from './sidebar-state'
import { createSidebarController, SidebarPanel } from './tui'
import type { TuiLogger } from './tui/file-logger'
import {
  type AntigravityAuthTuiPrefs,
  DEFAULT_PREFS,
  PLUGIN_KEY,
  TUI_PREFS_FILE_ENV,
} from './tui-preferences'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 0, 10, 12, 0, 0)
const WIDTHS = [32, 38, 48] as const

const NOOP_LOGGER: TuiLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  getLogPath: () => undefined,
}

interface Fixture {
  statePath: string
  cleanup: () => void
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'agy-tui-narrow-'))
  const statePath = join(root, 'sidebar-state.json')
  const prefsPath = join(root, 'tui-preferences.jsonc')
  const savedSidebar = process.env[SIDEBAR_STATE_ENV]
  const savedTuiLog = process.env.ANTIGRAVITY_AUTH_TUI_LOG_FILE
  const savedPrefs = process.env[TUI_PREFS_FILE_ENV]
  process.env[SIDEBAR_STATE_ENV] = statePath
  process.env.ANTIGRAVITY_AUTH_TUI_LOG_FILE = join(root, 'tui.log')
  process.env[TUI_PREFS_FILE_ENV] = prefsPath
  mkdirSync(root, { recursive: true })
  writeFileSync(
    prefsPath,
    JSON.stringify({
      [PLUGIN_KEY]: {
        ...DEFAULT_PREFS,
        header: { ...DEFAULT_PREFS.header, showVersion: false },
      },
    }),
    'utf-8',
  )
  return {
    statePath,
    cleanup: () => {
      if (savedSidebar !== undefined)
        process.env[SIDEBAR_STATE_ENV] = savedSidebar
      else delete process.env[SIDEBAR_STATE_ENV]
      if (savedTuiLog !== undefined)
        process.env.ANTIGRAVITY_AUTH_TUI_LOG_FILE = savedTuiLog
      else delete process.env.ANTIGRAVITY_AUTH_TUI_LOG_FILE
      if (savedPrefs !== undefined) process.env[TUI_PREFS_FILE_ENV] = savedPrefs
      else delete process.env[TUI_PREFS_FILE_ENV]
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function state(partial: Partial<SidebarStateV1>): SidebarStateV1 {
  return {
    ...DEFAULT_SIDEBAR_STATE,
    checkedAt: NOW,
    routingAuthoritative: true,
    ...partial,
    version: SIDEBAR_STATE_VERSION,
  }
}

// Read two minutes ago; every reset is still ahead.
function freshAccount(): SidebarAccountState {
  const checkedAt = NOW - 2 * MINUTE
  return {
    id: 'acct-0',
    label: 'Account 1',
    enabled: true,
    health: 100,
    current: true,
    quota: {
      gemini: {
        remainingPercent: 62,
        checkedAt,
        windows: [
          {
            window: '5h',
            remainingPercent: 95,
            resetAt: NOW + 2 * HOUR,
            checkedAt,
          },
          {
            window: 'weekly',
            remainingPercent: 62,
            resetAt: NOW + 3 * DAY,
            checkedAt,
          },
        ],
      },
      'non-gemini': {
        remainingPercent: 48,
        checkedAt,
        windows: [
          {
            window: '5h',
            remainingPercent: 100,
            resetAt: NOW + 5 * HOUR,
            checkedAt,
          },
          {
            window: 'weekly',
            remainingPercent: 48,
            resetAt: NOW + 6 * DAY,
            checkedAt,
          },
        ],
      },
    },
  }
}

// The reported state: read 41 hours ago; the Gemini 5h, Other 5h and Other
// 7d resets have all passed since, only the Gemini 7d reset is still ahead.
function staleAccount(): SidebarAccountState {
  const checkedAt = NOW - 41 * HOUR
  return {
    id: 'acct-0',
    label: 'Account 1',
    enabled: true,
    health: 70,
    current: false,
    quota: {
      gemini: {
        remainingPercent: 9,
        checkedAt,
        windows: [
          {
            window: '5h',
            remainingPercent: 95,
            resetAt: checkedAt + 3 * HOUR,
            checkedAt,
          },
          {
            window: 'weekly',
            remainingPercent: 9,
            resetAt: NOW + 5 * DAY,
            checkedAt,
          },
        ],
      },
      'non-gemini': {
        remainingPercent: 0,
        checkedAt,
        windows: [
          {
            window: '5h',
            remainingPercent: 100,
            resetAt: checkedAt + 4 * HOUR,
            checkedAt,
          },
          {
            window: 'weekly',
            remainingPercent: 0,
            resetAt: checkedAt + 20 * HOUR,
            checkedAt,
          },
        ],
      },
    },
  }
}

// A vault-served row: `vault-` id, never current, email kept for machine
// consumers only, and an older pool stored without per-window readings.
function vaultAccount(): SidebarAccountState {
  const checkedAt = NOW - 3 * HOUR
  return {
    id: 'vault-acct-0',
    label: 'Account 1',
    email: 'vault-user@example.test',
    enabled: true,
    health: 100,
    current: false,
    quota: {
      gemini: {
        remainingPercent: 40,
        checkedAt,
        windows: [
          {
            window: 'weekly',
            remainingPercent: 40,
            resetAt: NOW + 4 * DAY,
            checkedAt,
          },
        ],
      },
      'non-gemini': {
        remainingPercent: 75,
        resetAt: NOW + 45 * MINUTE,
        checkedAt,
      },
    },
  }
}

function emptyAccount(): SidebarAccountState {
  return {
    id: 'acct-0',
    label: 'Account 1',
    enabled: true,
    health: 100,
    current: true,
    quota: {},
  }
}

const ROUTE = {
  accountId: 'acct-0',
  modelFamily: 'claude' as const,
  headerStyle: 'antigravity' as const,
  strategy: 'round-robin' as const,
  updatedAt: NOW - MINUTE,
}

async function capture(
  fixture: Fixture,
  payload: SidebarStateV1,
  width: number,
  sessionId?: string,
  overrides: Partial<AntigravityAuthTuiPrefs> = {},
): Promise<string> {
  writeFileSync(fixture.statePath, JSON.stringify(payload), 'utf-8')
  const controller = createSidebarController({
    ...DEFAULT_PREFS,
    ...overrides,
    header: { ...DEFAULT_PREFS.header, showVersion: false },
    appearance: { ...DEFAULT_PREFS.appearance, ...overrides.appearance },
  })
  const setup = await testRender(
    () => (
      <SidebarPanel
        controller={controller}
        logger={NOOP_LOGGER}
        stateFile={fixture.statePath}
        now={() => NOW}
        sessionId={sessionId}
      />
    ),
    { width, height: 32 },
  )
  try {
    await setup.flush()
    await setup.flush()
    return trimFrame(setup.captureCharFrame())
  } finally {
    setup.renderer.destroy()
  }
}

function trimFrame(frame: string): string {
  const lines = frame.split('\n').map((line) => line.replace(/\s+$/, ''))
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

function show(label: string, width: number, frame: string): void {
  if (process.env.AGY_PRINT_FRAMES !== '1') return
  console.log(`\n=== ${label} @ ${width} cols ===\n${frame}\n`)
}

// The test renderer leaves the panel border out of the character frame, so
// each frame line is the panel's text with its padding.
function contentLines(frame: string): string[] {
  return frame
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

// A window row is one line holding its name, its bar and its figure. A row
// that wrapped leaves a fragment of the figure ("left", "%", "le") or of a
// reset or age ("ago") on a following line, indented to the column where the
// wrapped text started. Every real line starts at the panel's padding.
function expectNoWrappedFragments(frame: string): void {
  for (const line of frame.split('\n')) {
    if (line.trim().length === 0) continue
    expect(line).toMatch(/^ {1,2}\S/)
  }
  for (const line of contentLines(frame)) {
    expect(line).not.toMatch(/^(left|le|ft|%|\d+%?|ago|resets.*)$/)
  }
}

function lineWith(frame: string, pattern: RegExp): string | undefined {
  return contentLines(frame).find((line) => pattern.test(line))
}

function expectPlainGroupNames(frame: string): void {
  expect(frame).toContain('Gemini')
  expect(frame).toContain('Other models')
  expect(frame).not.toMatch(/\bGm\b/)
  expect(frame).not.toMatch(/\bNG\b/)
}

describe('OpenCode 1 sidebar in a narrow sidebar', () => {
  let fixture: Fixture

  beforeEach(() => {
    fixture = makeFixture()
  })

  afterEach(() => {
    fixture.cleanup()
  })

  for (const width of WIDTHS) {
    it(`fresh readings fit one line per window at ${width} columns`, async () => {
      const frame = await capture(
        fixture,
        state({ accounts: [freshAccount()] }),
        width,
      )
      show('fresh', width, frame)
      expectNoWrappedFragments(frame)
      expectPlainGroupNames(frame)
      expect(lineWith(frame, /^Account 1\b.*\bactive$/)).toBeDefined()
      expect(frame).not.toContain('checked')
      expect(frame).not.toContain('health')
      for (const [figure, reset] of [
        ['95% left', '2h'],
        ['62% left', '3d'],
        ['100% left', '5h'],
        ['48% left', '6d'],
      ] as const) {
        const row = lineWith(frame, new RegExp(`\\b${figure}\\b`))
        expect(row).toBeDefined()
        expect(row).toMatch(/^(5h|7d) /)
        expect(row).toMatch(new RegExp(`${reset}$`))
      }
    })

    it(`a reading whose reset passed is not shown as current at ${width} columns`, async () => {
      const frame = await capture(
        fixture,
        state({ accounts: [staleAccount()] }),
        width,
      )
      show('stale (41h old, three resets passed)', width, frame)
      expectNoWrappedFragments(frame)
      expectPlainGroupNames(frame)
      // Three of four windows reset after the reading; their stored figures
      // (95%, 100% and 0% left) are history, not the quota now.
      expect(frame).not.toContain('95% left')
      expect(frame).not.toContain('100% left')
      expect(lineWith(frame, /(^|\s)0% left/)).toBeUndefined()
      expect(
        contentLines(frame).filter((line) =>
          /^(5h|7d) reset since last check$/.test(line),
        ),
      ).toHaveLength(3)
      // The one window whose reset is still ahead keeps its figure and reset.
      expect(lineWith(frame, /^7d .*\b9% left\s+5d$/)).toBeDefined()
      // The reading age appears once for the account, never per row.
      expect(frame.split('checked 2d ago')).toHaveLength(2)
      expect(frame).not.toContain('health')
    })

    it(`a vault account renders its readings at ${width} columns`, async () => {
      const frame = await capture(
        fixture,
        state({ accounts: [vaultAccount()] }),
        width,
      )
      show('vault account', width, frame)
      expectNoWrappedFragments(frame)
      expectPlainGroupNames(frame)
      expect(frame).not.toContain('vault-user@example.test')
      expect(lineWith(frame, /^Account 1\b.*\bidle$/)).toBeDefined()
      expect(lineWith(frame, /^7d .*\b40% left\s+4d$/)).toBeDefined()
      expect(lineWith(frame, /\b75% left\s+45m$/)).toBeDefined()
      expect(frame.split('checked 3h ago')).toHaveLength(2)
    })

    it(`an account without quota readings shows one dim line at ${width} columns`, async () => {
      const frame = await capture(
        fixture,
        state({ accounts: [emptyAccount()] }),
        width,
      )
      show('empty quota', width, frame)
      expectNoWrappedFragments(frame)
      expect(frame.split('no quota reading yet')).toHaveLength(2)
      expect(frame).not.toMatch(/\bGm\b|\bNG\b/)
    })

    it(`a session with a route shows it on whole lines at ${width} columns`, async () => {
      const frame = await capture(
        fixture,
        state({
          accounts: [freshAccount()],
          activeRouting: { 'ses-a': ROUTE },
        }),
        width,
        'ses-a',
      )
      show('session with route', width, frame)
      expectNoWrappedFragments(frame)
      expect(frame).toContain('Routing')
      expect(frame).toContain('round-robin')
      expect(lineWith(frame, /\bclaude\b.*\bantigravity\b/)).toBeDefined()
      expect(frame).not.toContain('No request yet')
    })

    it(`a session without a route shows no placeholder at ${width} columns`, async () => {
      const frame = await capture(
        fixture,
        state({
          accounts: [freshAccount()],
          activeRouting: { 'ses-b': ROUTE },
        }),
        width,
        'ses-a',
      )
      show('session without route', width, frame)
      expectNoWrappedFragments(frame)
      expect(frame).not.toContain('Route ')
      expect(frame).not.toContain('—')
      expect(frame).toContain('No request yet')
    })
  }

  it('shrinks the bar to fit before dropping the reset column', async () => {
    const wide = { appearance: { ...DEFAULT_PREFS.appearance, barWidth: 40 } }
    const payload = state({ accounts: [freshAccount()] })
    // The panel pads its content by one cell on each side, so 32 columns
    // leave 30: `5h `, a 14-cell bar and a space, `95% left`, then the
    // right-aligned `2h`.
    const roomy = await capture(fixture, payload, 32, undefined, wide)
    show('fresh, bar width 40', 32, roomy)
    const roomyRow = lineWith(roomy, /^5h .*95% left/)
    expect(roomyRow).toMatch(/^5h █{13}░ 95% left\s+2h$/)
    // 20 columns leave 18: a bar of at least four cells no longer fits next
    // to the reset, so the reset goes and the bar takes the room.
    const narrow = await capture(fixture, payload, 20, undefined, wide)
    show('fresh, bar width 40', 20, narrow)
    expectNoWrappedFragments(narrow)
    expect(lineWith(narrow, /^5h .*95% left/)).toMatch(/^5h █{5} 95% left$/)
    expect(lineWith(narrow, /^7d .*62% left/)).toMatch(/^7d █{3}░{2} 62% left$/)
  })
})

// Every reset in this reading has passed, including the one window whose
// stored figure would be the lowest.
function allResetAccount(): SidebarAccountState {
  const account = staleAccount()
  const gemini = account.quota.gemini?.windows?.[1]
  if (gemini) gemini.resetAt = NOW - 10 * HOUR
  return account
}

describe('OpenCode 1 collapsed sidebar row in a narrow sidebar', () => {
  let fixture: Fixture

  beforeEach(() => {
    fixture = makeFixture()
  })

  afterEach(() => {
    fixture.cleanup()
  })

  const collapsedPrefs = { collapsed: true, rememberCollapsed: true }

  async function collapsedRow(
    account: SidebarAccountState,
    width: number,
    label: string,
  ): Promise<string> {
    const frame = await capture(
      fixture,
      state({ accounts: [account] }),
      width,
      undefined,
      collapsedPrefs,
    )
    show(`collapsed ${label}`, width, frame)
    expectNoWrappedFragments(frame)
    expect(frame).not.toMatch(/\bGm\b|\bNG\b/)
    const rows = contentLines(frame).filter((line) => /[●⊘]$/.test(line))
    expect(rows).toHaveLength(1)
    return rows[0] ?? ''
  }

  for (const width of WIDTHS) {
    it(`names the lowest window when it fits at ${width} columns`, async () => {
      const row = await collapsedRow(freshAccount(), width, 'fresh')
      expect(row).toMatch(/^Account 1\s+Other 7d 48% left ●$/)
    })

    it(`skips a window whose reset passed when choosing the lowest at ${width} columns`, async () => {
      // The stored 0% left of the Other 7d window would be lowest, but that
      // window reset after the reading; the Gemini 7d 9% is still current.
      const row = await collapsedRow(staleAccount(), width, 'stale')
      expect(row).not.toMatch(/(^|\s)0% left/)
      expect(row).toMatch(/^Account 1\s+Gemini 7d 9% left ●$/)
    })

    it(`says the quota reset when every window reset at ${width} columns`, async () => {
      const row = await collapsedRow(allResetAccount(), width, 'all reset')
      expect(row).not.toMatch(/% left/)
      expect(row).toMatch(/\breset since last check ●$/)
      // The label is cut, with an ellipsis, before anything wraps.
      if (width === 32) expect(row).toMatch(/^Acco… reset/)
      else expect(row).toMatch(/^Account 1\s/)
    })

    it(`keeps the empty-state dash without quota at ${width} columns`, async () => {
      const row = await collapsedRow(emptyAccount(), width, 'empty')
      expect(row).toMatch(/^Account 1\s+— ●$/)
    })
  }

  it('drops the group and window name before cutting the label', async () => {
    // 26 columns leave 24: `Account 1 Other 7d 48% left ●` needs 29.
    const fresh = await collapsedRow(freshAccount(), 26, 'fresh')
    expect(fresh).toMatch(/^Account 1\s+48% left ●$/)
    const stale = await collapsedRow(staleAccount(), 26, 'stale')
    expect(stale).toMatch(/^Account 1\s+9% left ●$/)
  })
})

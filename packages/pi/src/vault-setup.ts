/**
 * Setup for serving Pi's Antigravity provider from the Claustrum vault
 * ("custody") instead of Pi's own login ("local"). The two never serve
 * together. Enrollment as `antigravity-auth-pi` runs only from the Vault
 * menu section, never from a model request; the enrollment token stays in
 * the vault library's owner-only file and Pi's auth slot is only read.
 */

import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { CommonAuthClaustrumModule } from '@cortexkit/antigravity-auth-core'
import {
  ANTIGRAVITY_PROVIDER_ID,
  enrollmentAuthority,
} from '@cortexkit/antigravity-auth-core'
import { writeJsonAtomic } from '@cortexkit/antigravity-auth-core/atomic-write'
import type {
  ClaustrumEnrollmentConnection,
  ClaustrumEnrollmentPaths,
  ClaustrumEnrollmentStatus,
  HostSlotContent,
} from '@cortexkit/antigravity-auth-core/common-auth/claustrum'
import type {
  ActionDefinition,
  ActionOutcome,
  ItemDefinition,
  PluginExtraSection,
} from '@cortexkit/antigravity-auth-core/common-auth/commands'

/** Pi's provider id; also the key of its auth slot in Pi's auth.json. */
export const PI_ANTIGRAVITY_PROVIDER_ID = ANTIGRAVITY_PROVIDER_ID
/** The host name this extension enrolls under, one enrollment per host. */
export const PI_ANTIGRAVITY_VAULT_HOST = 'pi'
/** The enrollment name the operator sees and approves for Pi. */
export const PI_ANTIGRAVITY_ENROLLMENT_NAME = 'antigravity-auth-pi'

// ---------------------------------------------------------------------------
// Mode file
// ---------------------------------------------------------------------------

export type PiAntigravityMode = 'local' | 'custody'

/**
 * What Pi serves Antigravity from. `routeId` names the vault account the
 * user picked; it is a roster route id, never credential material.
 */
export interface PiVaultModeRecord {
  readonly version: 1
  readonly mode: PiAntigravityMode
  readonly routeId?: string
}

export type PiVaultModeRead =
  | { readonly ok: true; readonly record: PiVaultModeRecord }
  | { readonly ok: false; readonly reason: string }

const LOCAL_MODE: PiVaultModeRecord = Object.freeze({
  version: 1,
  mode: 'local',
})

function parseModeRecord(raw: unknown): PiVaultModeRecord | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    return undefined
  const record = raw as Record<string, unknown>
  for (const key of Object.keys(record))
    if (key !== 'version' && key !== 'mode' && key !== 'routeId')
      return undefined
  if (record.version !== 1) return undefined
  if (record.mode !== 'local' && record.mode !== 'custody') return undefined
  if (record.routeId === undefined)
    return Object.freeze({ version: 1, mode: record.mode })
  if (typeof record.routeId !== 'string' || record.routeId.trim() === '')
    return undefined
  return Object.freeze({
    version: 1,
    mode: record.mode,
    routeId: record.routeId,
  })
}

/**
 * Read the mode file. A missing file is local mode, so an extension that
 * was never set up keeps serving its single login. A file that exists but
 * cannot be understood is reported, not guessed: the caller refuses to serve
 * rather than pick a mode the user may not have chosen.
 */
export function readPiVaultMode(path: string): PiVaultModeRead {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT')
      return { ok: true, record: LOCAL_MODE }
    return { ok: false, reason: 'the vault mode file could not be read' }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'the vault mode file is not valid JSON' }
  }
  const record = parseModeRecord(raw)
  return record
    ? { ok: true, record }
    : { ok: false, reason: 'the vault mode file has an unknown shape' }
}

export async function writePiVaultMode(
  path: string,
  record: PiVaultModeRecord,
): Promise<void> {
  const value: PiVaultModeRecord =
    record.routeId === undefined
      ? { version: 1, mode: record.mode }
      : { version: 1, mode: record.mode, routeId: record.routeId }
  await writeJsonAtomic(path, value)
}

// ---------------------------------------------------------------------------
// Vault accounts as setup sees them
// ---------------------------------------------------------------------------

/** An account shown in the vault menu; declined accounts are excluded from request selection. */
export interface PiVaultAccountChoice {
  readonly routeId: string
  /** Display label from the vault roster; may hold the account's email. */
  readonly label: string
  readonly email?: string
  readonly declined: boolean
}

/**
 * Vault account discovery and selection used by the setup menu.
 * These operations become available after the operator approves access.
 */
export interface PiVaultAccountsPort {
  /** Reload and save the list of permitted vault accounts, then return it to the menu. */
  list(): Promise<readonly PiVaultAccountChoice[]>
  decline(routeId: string): Promise<void>
  accept(routeId: string): Promise<void>
}

// ---------------------------------------------------------------------------
// Setup controller
// ---------------------------------------------------------------------------

export interface PiVaultSetupStatus {
  readonly mode: PiAntigravityMode | 'unreadable'
  readonly modeProblem?: string
  readonly selectedRouteId?: string
  readonly enrollment: ClaustrumEnrollmentStatus
  readonly hostSlot: HostSlotContent | 'dormant'
}

export interface PiVaultSetupOptions {
  claustrum: CommonAuthClaustrumModule
  /** Pi's vault directory (see `getPiAntigravityVaultDir`). */
  stateDir: string
  /** Pi's vault mode file (see `getPiAntigravityVaultModeFile`). */
  modeFile: string
  /** Read Pi's own Google credential record, only when local accounts are selected. */
  readHostSlot: () => unknown
  /** Opens the setup-only enrollment connection to the vault. */
  connectEnrollment: () => Promise<ClaustrumEnrollmentConnection>
  /** Re-register the Google provider after its selected account source changes. */
  onModeChanged?: (record: PiVaultModeRecord) => void | Promise<void>
  now?: () => number
}

/** A setup action refused before anything changed, with a message for the user. */
export class PiVaultSetupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PiVaultSetupError'
  }
}

export class PiVaultSetup {
  readonly #options: PiVaultSetupOptions
  readonly paths: ClaustrumEnrollmentPaths

  constructor(options: PiVaultSetupOptions) {
    this.#options = options
    this.paths = options.claustrum.hostEnrollmentPaths({
      stateDir: options.stateDir,
      host: PI_ANTIGRAVITY_VAULT_HOST,
    })
  }

  #hostSlot(): HostSlotContent {
    return this.#options.claustrum.classifyHostSlot(
      this.#options.readHostSlot(),
      PI_ANTIGRAVITY_PROVIDER_ID,
    )
  }

  /** Read vault approval and local/vault settings without opening Pi's Google credentials. */
  async sourceStatus(): Promise<Omit<PiVaultSetupStatus, 'hostSlot'>> {
    const mode = readPiVaultMode(this.#options.modeFile)
    const enrollment = await this.#options.claustrum
      .readClaustrumEnrollmentStatus(this.paths, PI_ANTIGRAVITY_ENROLLMENT_NAME)
      .catch(
        (): ClaustrumEnrollmentStatus => ({
          state: 'blocked',
          proposedName: PI_ANTIGRAVITY_ENROLLMENT_NAME,
          code: 'unreadable-state',
        }),
      )
    const authority = await enrollmentAuthority(
      this.paths,
      PI_ANTIGRAVITY_ENROLLMENT_NAME,
      this.#options.claustrum,
    )
    return {
      ...(authority !== 'local'
        ? {
            mode:
              authority === 'vault'
                ? ('custody' as const)
                : ('unreadable' as const),
            ...(mode.ok &&
              mode.record.routeId !== undefined && {
                selectedRouteId: mode.record.routeId,
              }),
          }
        : mode.ok
          ? {
              mode: mode.record.mode,
              ...(mode.record.routeId !== undefined && {
                selectedRouteId: mode.record.routeId,
              }),
            }
          : { mode: 'unreadable' as const, modeProblem: mode.reason }),
      enrollment,
    }
  }

  /** Inspect the native login only when local accounts are selected. */
  async status(): Promise<PiVaultSetupStatus> {
    const source = await this.sourceStatus()
    return {
      ...source,
      hostSlot: source.mode === 'local' ? this.#hostSlot() : 'dormant',
    }
  }

  /**
   * Propose Pi to the vault or poll its recorded proposal. Clear a denied or
   * blocked request before starting again. Only setup actions call this method.
   */
  async connectStep(): Promise<ClaustrumEnrollmentStatus> {
    const client = await this.#options.connectEnrollment()
    try {
      const manager = new this.#options.claustrum.ClaustrumEnrollmentManager({
        client,
        paths: this.paths,
        proposedName: PI_ANTIGRAVITY_ENROLLMENT_NAME,
        ...(this.#options.now && { now: this.#options.now }),
      })
      const current = await manager.status()
      if (current.state === 'denied' || current.state === 'blocked')
        await manager.resetTerminal()
      const reconciled = await manager.reconcile()
      if (reconciled.state === 'approved') {
        const saved = readPiVaultMode(this.#options.modeFile)
        await this.useVault(
          saved.ok && saved.record.mode === 'custody'
            ? saved.record.routeId
            : undefined,
        )
      }
      return reconciled
    } finally {
      client.close()
    }
  }

  /**
   * Select the vault account used for requests after the operator approves
   * enrollment. Await the host's Google credential-slot transition before
   * returning, so provider registration cannot race it.
   */
  async useVault(routeId?: string): Promise<PiVaultModeRecord> {
    const enrollment =
      await this.#options.claustrum.readClaustrumEnrollmentStatus(
        this.paths,
        PI_ANTIGRAVITY_ENROLLMENT_NAME,
      )
    if (enrollment.state !== 'approved')
      throw new PiVaultSetupError(
        'Pi is not enrolled with the vault yet. Request access and wait for the operator to approve it first.',
      )
    if (routeId !== undefined && routeId.trim() === '')
      throw new PiVaultSetupError('Choose a vault account to use.')
    const record: PiVaultModeRecord =
      routeId === undefined
        ? { version: 1, mode: 'custody' }
        : { version: 1, mode: 'custody', routeId }
    await writePiVaultMode(this.#options.modeFile, record)
    await this.#options.onModeChanged?.(record)
    return record
  }

  /** Use Pi's local login only after vault enrollment has been disconnected. */
  async useLocal(): Promise<PiVaultModeRecord> {
    if (
      (await enrollmentAuthority(
        this.paths,
        PI_ANTIGRAVITY_ENROLLMENT_NAME,
        this.#options.claustrum,
      )) !== 'local'
    ) {
      throw new PiVaultSetupError(
        'Disconnect vault enrollment before using local accounts.',
      )
    }
    await writePiVaultMode(this.#options.modeFile, LOCAL_MODE)
    await this.#options.onModeChanged?.(LOCAL_MODE)
    return LOCAL_MODE
  }

  /**
   * Forget this host's enrollment (token and ceremony state) and go back to
   * local mode. The vault keeps the enrollment approved until the operator
   * revokes it there.
   */
  async disconnect(): Promise<void> {
    const result = await this.#options.claustrum.disconnectClaustrumEnrollment(
      this.paths,
      PI_ANTIGRAVITY_ENROLLMENT_NAME,
    )
    if (result === 'busy')
      throw new PiVaultSetupError(
        'Vault enrollment is busy; disconnect did not change it.',
      )
    await writePiVaultMode(this.#options.modeFile, LOCAL_MODE)
    await this.#options.onModeChanged?.(LOCAL_MODE)
  }
}

// ---------------------------------------------------------------------------
// Rendering through Pi's command and dialog surfaces
// ---------------------------------------------------------------------------

function describeEnrollment(status: ClaustrumEnrollmentStatus): string {
  switch (status.state) {
    case 'idle':
      return 'not requested'
    case 'pending':
      return status.retryCode
        ? `waiting for operator approval (retrying: ${status.retryCode})`
        : 'waiting for operator approval'
    case 'approved':
      return `approved as ${status.approvedName ?? status.proposedName}`
    case 'denied':
      return 'denied by the operator'
    case 'blocked':
      return `blocked (${status.code})`
    case 'unavailable':
      return `vault unavailable (${status.code})`
    case 'busy':
      return 'another setup step is running'
  }
}

// The vault operator approves and grants with Claustrum's `ck` command,
// outside Pi. Approval alone serves nothing: the enrollment also needs read
// access to the vault's Antigravity accounts.

/** The operator's command that grants Pi's enrollment read access to Antigravity accounts. */
export const PI_VAULT_GRANT_COMMAND = `ck auth grant --principal enrolled:${PI_ANTIGRAVITY_ENROLLMENT_NAME} --selector-kind category --selector antigravity-native --operation read`

/** What to do while Pi's request waits in the vault; names the request when Pi knows its ID. */
function piPendingEnrollmentGuidance(requestId?: string): string[] {
  return [
    'Next, the vault operator runs these outside Pi:',
    requestId === undefined
      ? '1. Find the request ID with ck auth enroll list, then approve it: ck auth enroll approve --request-id <id>'
      : `1. Approve the request: ck auth enroll approve --request-id ${requestId}`,
    `2. Grant read access: ${PI_VAULT_GRANT_COMMAND}`,
    'Both are needed: an approval without the grant serves Pi no accounts.',
    '3. Pi switches to the vault once it sees the approval; Request vault access checks again.',
  ]
}

/**
 * Why a new request was refused with `pending_exists`, and the way out. The
 * vault holds one pending request per name; an earlier one, for example from
 * an enrollment forgotten in Pi, blocks a new one until it expires or the
 * operator denies it.
 */
function piPendingExistsGuidance(): string[] {
  return [
    `An earlier request for ${PI_ANTIGRAVITY_ENROLLMENT_NAME} is still pending in the vault, possibly from an enrollment forgotten here.`,
    'It expires 15 minutes after it was made; request vault access again after that.',
    'Or the vault operator clears it now: find its ID with ck auth enroll list, run ck auth enroll deny --request-id <id>, then request vault access again here.',
  ]
}

/** Shown when Pi is approved but the vault lists no Antigravity accounts for it. */
export function piNoVaultAccountsGuidance(): string[] {
  return [
    `Enrollment is approved, but the vault serves ${PI_ANTIGRAVITY_ENROLLMENT_NAME} no Antigravity accounts.`,
    `The vault operator grants read access with: ${PI_VAULT_GRANT_COMMAND}`,
  ]
}

/** The next steps for an enrollment state that needs the user or the operator to act. */
function enrollmentGuidance(status: ClaustrumEnrollmentStatus): string[] {
  if (status.state === 'pending')
    return piPendingEnrollmentGuidance(status.requestId)
  if (status.state === 'blocked' && status.code === 'pending_exists')
    return piPendingExistsGuidance()
  return []
}

function describeHostSlot(slot: HostSlotContent): string {
  switch (slot) {
    case 'login':
      return 'signed in with a Pi login'
    case 'placeholder':
      return 'holds the vault placeholder'
    case 'empty':
      return 'empty'
  }
}

/** Setup-menu status text with no credentials or Antigravity project identifiers. */
export function formatPiVaultSetupStatus(status: PiVaultSetupStatus): string[] {
  const lines = [
    `Mode: ${
      status.mode === 'custody'
        ? 'vault (custody)'
        : status.mode === 'local'
          ? 'local Pi login'
          : `unreadable (${status.modeProblem ?? 'unknown problem'})`
    }`,
    `Enrollment (${PI_ANTIGRAVITY_ENROLLMENT_NAME}): ${describeEnrollment(status.enrollment)}`,
    status.hostSlot === 'dormant'
      ? 'Pi auth slot: dormant (not read)'
      : `Pi auth slot: ${describeHostSlot(status.hostSlot)}`,
  ]
  if (status.selectedRouteId !== undefined)
    lines.push('Vault account: a specific account is chosen (marked below)')
  if (status.mode === 'local' && status.hostSlot === 'placeholder')
    lines.push(
      'Conflict: local mode has no login to serve. Run /login or switch to the vault.',
    )
  lines.push(...enrollmentGuidance(status.enrollment))
  return lines
}

// ---------------------------------------------------------------------------
// Vault section of the shared command menu
// ---------------------------------------------------------------------------

export interface PiVaultSectionOptions {
  /** The setup controller; created on first use so the vault library loads lazily. */
  setup: () => Promise<PiVaultSetup>
  /** Vault account actions, available only after the approved account source is constructed. */
  accounts?: () => PiVaultAccountsPort | undefined
  /** How Request access polls for the operator's approval (tests shorten it). */
  wait?: PiVaultWaitOptions
}

export interface PiVaultWaitOptions {
  pollIntervalMs?: number
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Menu payloads leave this process (the shared menu may hand them to a
 * renderer), so a vault account's item id is an opaque digest of its route
 * id under a per-process salt: stable while Pi runs, so an apply finds the
 * same account the user saw, but never the raw route id.
 */
const ITEM_ID_SALT = randomBytes(16)

/**
 * A vault account's display name in the menu: its position in the vault's
 * list. The roster label is usually the account's email, which must not
 * leave this process in a menu payload; positions are shown, never accepted
 * as targets.
 */
export function vaultAccountName(
  listed: readonly PiVaultAccountChoice[],
  account: PiVaultAccountChoice,
): string {
  return `Vault account ${listed.indexOf(account) + 1}`
}

export function opaqueItemId(routeId: string): string {
  return `vault-${createHash('sha256').update(ITEM_ID_SALT).update(routeId).digest('hex').slice(0, 16)}`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function refused(error: unknown): ActionOutcome {
  if (error instanceof PiVaultSetupError)
    return { ok: false, text: error.message, code: 'vault-refused' }
  throw error
}

/**
 * Poll the enrollment until it leaves `pending`/`busy` or the wait ends.
 * Returns undefined when Pi's local request disappears while waiting (it was
 * forgotten elsewhere): polling on would propose a fresh request, which the
 * vault refuses with `pending_exists` while the old one is still pending.
 */
async function waitForApproval(
  setup: PiVaultSetup,
  wait: PiVaultWaitOptions = {},
): Promise<ClaustrumEnrollmentStatus | undefined> {
  const sleep =
    wait.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const interval = wait.pollIntervalMs ?? 2_000
  const deadline = Date.now() + (wait.timeoutMs ?? 10 * 60_000)
  let status = await setup.connectStep()
  while (status.state === 'pending' || status.state === 'busy') {
    if (Date.now() >= deadline) return status
    await sleep(interval)
    if ((await setup.sourceStatus()).enrollment.state === 'idle')
      return undefined
    status = await setup.connectStep()
  }
  return status
}

/**
 * The Vault section of Pi's command menu: mode and enrollment status, the
 * vault accounts with use/decline/accept, requesting access (the only place
 * enrollment runs), switching between the vault and the local Pi login, and
 * forgetting the enrollment. Shows status only, never the enrollment token,
 * and never a raw route id, roster label or email.
 */
export function createPiVaultSection(
  options: PiVaultSectionOptions,
): PluginExtraSection {
  // One approval watch at a time, so a second Request vault access while
  // the first is still waiting does not report the operator's decision twice.
  let watching = false

  /** Lines for an approved enrollment whose vault roster is empty; empty when unknown. */
  const approvedRosterGuidance = async (): Promise<string[]> => {
    const port = options.accounts?.()
    if (!port) return []
    try {
      return (await port.list()).length === 0 ? piNoVaultAccountsGuidance() : []
    } catch {
      // The Vault section reports an unreachable roster when it is opened;
      // an action result says nothing it cannot confirm.
      return []
    }
  }

  /** An enrollment step's result: its state, then what to do next. */
  const stepText = async (
    step: ClaustrumEnrollmentStatus,
    suffix = '',
  ): Promise<string> =>
    [
      `Enrollment: ${describeEnrollment(step)}${suffix}`,
      ...enrollmentGuidance(step),
      ...(step.state === 'approved' ? await approvedRosterGuidance() : []),
    ].join('\n')

  return {
    id: 'vault',
    title: 'Vault',
    build: async () => {
      const setup = await options.setup()
      const status = await setup.status()
      const approved = status.enrollment.state === 'approved'
      const lines = formatPiVaultSetupStatus(status)
      const items: ItemDefinition[] = []
      const port = approved ? options.accounts?.() : undefined
      if (port) {
        try {
          const listed = await port.list()
          for (const account of listed) {
            const name = vaultAccountName(listed, account)
            const serving =
              status.mode === 'custody' &&
              status.selectedRouteId === account.routeId
            items.push({
              id: opaqueItemId(account.routeId),
              label: name,
              detail: account.declined
                ? 'declined on this host'
                : serving
                  ? 'serving Pi'
                  : 'available',
              actions: account.declined
                ? [
                    {
                      id: 'accept',
                      label: 'Accept on this host',
                      run: async () => {
                        await port.accept(account.routeId)
                        return `${name} is accepted on this host.`
                      },
                    },
                  ]
                : [
                    {
                      id: 'use',
                      label: 'Serve Pi from this account',
                      run: async () => {
                        try {
                          await setup.useVault(account.routeId)
                        } catch (error) {
                          return refused(error)
                        }
                        return `Pi now serves Antigravity from ${name}.`
                      },
                    },
                    {
                      id: 'decline',
                      label: 'Decline on this host',
                      description:
                        'It stays in the vault and in this list, and is never sent from this host until accepted again.',
                      run: async () => {
                        await port.decline(account.routeId)
                        return `${name} is declined on this host.`
                      },
                    },
                  ],
            })
          }
          if (listed.length === 0) lines.push(...piNoVaultAccountsGuidance())
          else if (status.mode !== 'custody')
            lines.push(
              'Next: choose Serve Pi from the vault to serve Pi from these accounts.',
            )
        } catch (error) {
          lines.push(`Vault accounts unavailable: ${errorText(error)}`)
        }
      }

      const actions: ActionDefinition[] = []
      if (!approved)
        actions.push({
          id: 'request-access',
          label: 'Request vault access',
          description: `Asks the vault to enroll Pi as ${PI_ANTIGRAVITY_ENROLLMENT_NAME}; the operator approves it in the vault.`,
          run: async ({ invocation }) => {
            const step = await setup.connectStep()
            if (step.state !== 'pending' && step.state !== 'busy')
              return {
                ok: step.state === 'approved',
                text: await stepText(step),
              }
            // The approval happens outside Pi; keep polling and report to
            // the session that asked.
            if (!watching) {
              watching = true
              void waitForApproval(setup, options.wait)
                .then(async (final) => {
                  if (final === undefined) return
                  invocation.notify(
                    await stepText(final),
                    final.state === 'approved' ? 'info' : 'warning',
                  )
                })
                .catch((error: unknown) => {
                  invocation.notify(
                    `Requesting vault access failed: ${errorText(error)}`,
                    'error',
                  )
                })
                .finally(() => {
                  watching = false
                })
            }
            return {
              ok: true,
              text: await stepText(
                step,
                '. You are told here when the operator decides.',
              ),
            }
          },
        })
      if (approved && status.mode !== 'custody')
        actions.push({
          id: 'use-vault',
          label: 'Serve Pi from the vault',
          run: async () => {
            try {
              await setup.useVault(status.selectedRouteId)
            } catch (error) {
              return refused(error)
            }
            return 'Pi now serves Antigravity from the vault.'
          },
        })
      if (
        status.mode !== 'local' &&
        (status.enrollment.state === 'idle' ||
          status.enrollment.state === 'pending' ||
          status.enrollment.state === 'denied')
      )
        actions.push({
          id: 'use-local',
          label: 'Serve Pi from its own login',
          run: async () => {
            await setup.useLocal()
            return 'Pi now serves Antigravity from its own login. Run /login if it has none.'
          },
        })
      // No Forget while a request is pending: the vault has no way to withdraw
      // it, so forgetting would delete the only secret that can still collect
      // the approval and leave the request blocking a new one. It returns once
      // the operator approves or denies the request.
      if (status.enrollment.state === 'pending')
        lines.push(
          `Forget vault enrollment is offered again once Pi sees the request approved or denied. To drop it, the operator runs ck auth enroll deny --request-id ${status.enrollment.requestId ?? '<id>'}; then choose Request vault access here.`,
        )
      else if (status.enrollment.state !== 'idle')
        actions.push({
          id: 'forget',
          label: 'Forget vault enrollment',
          description:
            "Deletes Pi's enrollment token and returns to the local login. The operator can still revoke the enrollment in the vault.",
          irreversible: true,
          confirm: `Forget the ${PI_ANTIGRAVITY_ENROLLMENT_NAME} enrollment? Using the vault again needs a new approval.`,
          run: async () => {
            await setup.disconnect()
            return 'Vault enrollment forgotten; Pi serves Antigravity from its own login.'
          },
        })

      return { lines, items, actions }
    },
  }
}

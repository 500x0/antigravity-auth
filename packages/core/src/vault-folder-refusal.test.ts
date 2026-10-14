import { afterEach, describe, expect, it } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeEnrollmentTokenFile } from '@cortexkit/claustrum-client'
import { refuseWritableAncestor } from './common-auth-embedded/claustrum/enrollment.js'
import {
  SHARED_VAULT_TOKEN_FOLDER_CODE,
  sharedVaultTokenFolder,
  sharedVaultTokenFolderOutcome,
  sharedVaultTokenFolderText,
} from './vault-folder-refusal.ts'

const TOKEN = { token: 'c'.repeat(64), token_generation: 1 }

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

/** An owner-only temp root with one child folder that the test then shares. */
function ownedRootWithChild(): { root: string; shared: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vault-folder-')))
  roots.push(root)
  chmodSync(root, 0o700)
  const shared = join(root, 'shared')
  mkdirSync(shared, { mode: 0o700 })
  return { root, shared }
}

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run()
  } catch (error) {
    return error
  }
  throw new Error('expected the vault library to refuse')
}

// The refusals are POSIX permission checks; Windows uses ACLs instead.
describe.skipIf(process.platform === 'win32')(
  'shared vault token folder refusal',
  () => {
    it("names the folder from claustrum-client's real refusal of a group-writable parent", async () => {
      const { shared } = ownedRootWithChild()
      // Group-writable and sticky: the client refuses a group-writable folder
      // unless it is a non-sticky folder of the user's own private group, so
      // the sticky bit makes the refusal certain on hosts with private groups.
      chmodSync(shared, 0o1770)
      const error = await caught(() =>
        writeEnrollmentTokenFile(join(shared, 'vault', 'token.json'), TOKEN),
      )
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain('is not private')
      expect(sharedVaultTokenFolder(error)).toBe(shared)
      expect(sharedVaultTokenFolderOutcome(error)).toEqual({
        ok: false,
        code: SHARED_VAULT_TOKEN_FOLDER_CODE,
        text: `The vault token can't be saved because ${shared} is shared with other users. Make it owned by you and not writable by your group or by others, then try again.`,
      })
    })

    it("names the folder from the embedded enrollment code's real refusal of a group-writable parent", async () => {
      const { root, shared } = ownedRootWithChild()
      chmodSync(shared, 0o770)
      // The embedded check accepts a group-writable folder only when the
      // account files prove the user's group is private; these list another
      // member in it, so the real check refuses on every host.
      const uid = process.geteuid?.() ?? 0
      const gid = process.getegid?.() ?? 0
      const passwdPath = join(root, 'passwd')
      const groupPath = join(root, 'group')
      writeFileSync(passwdPath, `me:x:${uid}:${gid}::/:/bin/sh\n`)
      writeFileSync(groupPath, `mine:x:${gid}:me,someone-else\n`)
      const error = await caught(() =>
        refuseWritableAncestor(shared, {
          passwdPath,
          groupPath,
        }),
      )
      expect((error as Error).message).toContain('writable ancestor')
      expect(sharedVaultTokenFolder(error)).toBe(shared)
    })

    it('leaves other vault errors to the caller', async () => {
      const { root } = ownedRootWithChild()
      // A real "is not private" refusal whose cause is not sharing: a path
      // component that is a file, not a folder.
      const file = join(root, 'not-a-folder')
      writeFileSync(file, '')
      const notFolder = await caught(() =>
        writeEnrollmentTokenFile(join(file, 'vault', 'token.json'), TOKEN),
      )
      expect(sharedVaultTokenFolder(notFolder)).toBeUndefined()
      const badToken = await caught(() =>
        writeEnrollmentTokenFile(join(root, 'token.json'), {
          token: 'short',
          token_generation: 1,
        }),
      )
      expect(sharedVaultTokenFolder(badToken)).toBeUndefined()
      expect(
        sharedVaultTokenFolder('enrollment token folder /x is not private'),
      ).toBeUndefined()
      expect(sharedVaultTokenFolderOutcome(new Error('boom'))).toBeUndefined()
    })

    it('says what to change in one sentence', () => {
      expect(sharedVaultTokenFolderText('/home/me/shared')).toBe(
        "The vault token can't be saved because /home/me/shared is shared with other users. Make it owned by you and not writable by your group or by others, then try again.",
      )
    })
  },
)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { assertPrivateTokenDacl, redactDacl } from './dacl.mjs'
import { installLocalReadFence } from './local-reads.mjs'

const userSid = 'S-1-5-21-1-2-3-1001'
const privateDacl = () => ({
  userSid,
  ownerSid: userSid,
  protected: true,
  aces: [{ sid: userSid, type: 'AccessAllowed', flags: 0, mask: 0x1f01ff }],
})

test('accepts the common-auth private-file template and trusted owners', () => {
  for (const ownerSid of [userSid, 'S-1-5-18', 'S-1-5-32-544'])
    assertPrivateTokenDacl({ ...privateDacl(), ownerSid })
  assert.equal(
    JSON.stringify(redactDacl(privateDacl())).includes(userSid),
    false,
  )
})

test('rejects extra and foreign grants including SYSTEM and Administrators', () => {
  for (const sid of ['S-1-1-0', 'S-1-5-18', 'S-1-5-32-544']) {
    const descriptor = privateDacl()
    descriptor.aces.push({ ...descriptor.aces[0], sid })
    assert.throws(() => assertPrivateTokenDacl(descriptor))
    descriptor.aces.shift()
    assert.throws(() => assertPrivateTokenDacl(descriptor))
  }
})

test('rejects noncanonical owner, protection, type, flags, mask and empty DACLs', () => {
  for (const descriptor of [
    { ...privateDacl(), ownerSid: 'S-1-1-0' },
    { ...privateDacl(), protected: false },
    { ...privateDacl(), aces: null },
    { ...privateDacl(), aces: [] },
    ...[
      { type: 'AccessDenied' },
      { type: 'AccessAllowedObject' },
      { flags: 16 },
      { mask: 0x120089 },
    ].map((change) => ({
      ...privateDacl(),
      aces: [{ ...privateDacl().aces[0], ...change }],
    })),
  ])
    assert.throws(() => assertPrivateTokenDacl(descriptor))
})

test('fences both filesystem and native local-account reads without blocking other files', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'agy-vault-guards-'))
  const account = join(root, 'antigravity-accounts.json')
  const other = join(root, 'opencode-enrollment.json')
  fs.writeFileSync(account, 'dormant')
  fs.writeFileSync(other, 'unrelated')
  let nativeReads = 0
  const native = { read: () => ++nativeReads }
  const fence = installLocalReadFence(account, native)
  try {
    for (const read of [
      () => fs.readFileSync(account),
      () => fsp.readFile(account),
      () => fs.openSync(`${account}.store/pointer.json`, 'r'),
      () => native.read(account),
    ])
      assert.throws(read, { code: 'LOCAL_ACCOUNT_READ' })
    assert.equal(nativeReads, 0)
    assert.equal(fence.events.length, 4)
    assert.equal(await fsp.readFile(other, 'utf8'), 'unrelated')
    fence.reset()
    assert.equal(fence.events.length, 0)
  } finally {
    fence.restore()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

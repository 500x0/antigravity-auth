import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

export function assertPrivateTokenDacl(descriptor) {
  assert.ok(descriptor.userSid, 'Missing process token user SID')
  assert.ok(
    [descriptor.userSid, 'S-1-5-18', 'S-1-5-32-544'].includes(
      descriptor.ownerSid,
    ),
    'Untrusted token owner',
  )
  // New common-auth files use a protected, single-user FILE_ALL_ACCESS template.
  // SYSTEM and Administrators are accepted owners, not additional DACL grants.
  assert.equal(descriptor.protected, true, 'Token DACL is not protected')
  assert.ok(Array.isArray(descriptor.aces), 'Null token DACL')
  assert.equal(descriptor.aces.length, 1, 'Token has extra or missing ACEs')
  const [ace] = descriptor.aces
  assert.equal(ace.type, 'AccessAllowed', 'Unexpected token ACE type')
  assert.equal(ace.sid, descriptor.userSid, 'Token grants another principal')
  assert.equal(ace.flags, 0, 'Token ACE must be explicit and file-only')
  assert.equal(ace.mask, 0x1f01ff, 'Token ACE must grant FILE_ALL_ACCESS')
}

export function readTokenDacl(tokenPath) {
  const result = spawnSync(
    'pwsh',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `
        $ErrorActionPreference = 'Stop'
        $acl = Get-Acl -LiteralPath $env:AGY_VAULT_TOKEN_PATH
        $raw = [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
        $aces = $null
        if ($null -ne $raw.DiscretionaryAcl) {
          $aces = @($raw.DiscretionaryAcl | ForEach-Object {
            @{ sid = $_.SecurityIdentifier.Value; type = $_.AceType.ToString(); flags = [int]$_.AceFlags; mask = $_.AccessMask }
          })
        }
        @{
          userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
          ownerSid = $raw.Owner.Value
          protected = [bool]($raw.ControlFlags -band [System.Security.AccessControl.ControlFlags]::DiscretionaryAclProtected)
          aces = $aces
        } | ConvertTo-Json -Depth 5 -Compress
      `,
    ],
    {
      env: { ...process.env, AGY_VAULT_TOKEN_PATH: tokenPath },
      encoding: 'utf8',
      timeout: 30000,
    },
  )
  assert.equal(result.error, undefined, 'PowerShell did not run')
  assert.equal(result.status, 0, 'PowerShell could not read the token DACL')
  return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim())
}

export function redactDacl(descriptor) {
  return {
    ...descriptor,
    userSid: 'process-user',
    ownerSid:
      descriptor.ownerSid === descriptor.userSid
        ? 'process-user'
        : descriptor.ownerSid,
    aces: descriptor.aces?.map((ace) => ({
      ...ace,
      sid: ace.sid === descriptor.userSid ? 'process-user' : ace.sid,
    })),
  }
}

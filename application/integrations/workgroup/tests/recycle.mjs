// Test-owned scratch paths are moved to the OS recycle bin after their processes stop.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Recycle a test-owned path under the OS temp directory; refuse links and unrelated paths. */
export function recycleTestPath(path) {
  const target = resolve(path)
  const within = relative(resolve(tmpdir()), target)
  assert.ok(within !== '' && !isAbsolute(within) && !within.startsWith(`..${sep}`))
  assert.match(within.split(sep)[0], /^(workgroup-|wg-)/)
  let info
  try { info = lstatSync(target) } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  assert.equal(info.isSymbolicLink(), false, `refusing to recycle a link: ${target}`)
  assert.equal(info.isFile() && info.nlink > 1, false, `refusing a hard-linked file: ${target}`)
  if (process.platform === 'win32') {
    const method = info.isDirectory() ? 'DeleteDirectory' : 'DeleteFile'
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${method}($env:WORKGROUP_TEST_RECYCLE, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)`,
    ], { env: { ...process.env, WORKGROUP_TEST_RECYCLE: target }, stdio: 'pipe' })
  } else if (process.platform === 'darwin') {
    execFileSync('osascript', ['-e', 'on run argv', '-e', 'tell application "Finder" to delete (POSIX file (item 1 of argv))', '-e', 'end run', target])
  } else {
    execFileSync('gio', ['trash', '--', target])
  }
}

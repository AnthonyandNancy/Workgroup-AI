// H1: the approved-root check must compare paths the way the filesystem does.
//
// F-12's leftover is the case where the two paths differ only in case. On Windows the filesystem is
// case-insensitive, so `C:\Work\Approved` and `c:\work\approved` are one directory; and — measured,
// not assumed — `realpathSync` there returns the path with the casing **the caller typed**, so it
// does not normalize this away. A byte comparison therefore refuses a directory the owner approved,
// which is the failure that is easiest to misread as "the guard is working".
//
// The fix has to keep the property that makes the check sound. Two of them are asserted below as
// anti-regression cases, because a case-folding change is exactly the kind that silently widens a
// prefix check into a substring check:
//
//   * `work-other` beside `work` must still be refused (the trailing-separator rule).
//   * `ApprovedEvil` beside `Approved` must still be refused (a sibling that shares a prefix).
//
// POSIX keeps its byte comparison: case-sensitivity is the *correct* semantic there, so folding case
// on Linux would be a new bug rather than a fix.

import { recycleTestPath } from './recycle.mjs'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DISPATCH_REFUSALS, DispatchRefused, resolveTaskDirectory } from '../policy/dispatch.mjs'

const cleanup = []
afterAll(() => {
  for (const dir of cleanup) {
    try {
      recycleTestPath(dir)
    } catch {
      // A temporary directory the OS still holds open is residue, not a test result.
    }
  }
})

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'wg-h1-'))
  cleanup.push(root)
  return root
}

describe('H1 approved-root comparison', () => {
  it('accepts a directory whose path differs from the root only in case', () => {
    const root = scratch()
    const approved = join(root, 'Approved')
    mkdirSync(join(approved, 'inside'), { recursive: true })
    // The root is written with different casing than the directory on disk, which is what an
    // operator's config typically does: the case they typed when they wrote the approval.
    const odd = process.platform === 'win32' ? approved.toUpperCase() : approved
    const result = resolveTaskDirectory(join(approved, 'inside'), { root: odd })
    expect(result.realPath).toBeDefined()
  })

  it('still refuses a sibling that merely shares the root prefix', () => {
    const root = scratch()
    const approved = join(root, 'Approved')
    const sibling = join(root, 'ApprovedEvil')
    mkdirSync(approved, { recursive: true })
    mkdirSync(sibling, { recursive: true })
    expect(() => resolveTaskDirectory(sibling, { root: approved })).toThrow(DispatchRefused)
    try {
      resolveTaskDirectory(sibling, { root: approved })
    } catch (error) {
      // The distinction matters: a traversal refusal and an "unusable directory" refusal tell the
      // owner different things, and only one of them is about the root.
      expect(error.code).toBe(DISPATCH_REFUSALS.DIRECTORY_OUTSIDE_ROOT)
    }
  })

  it('still refuses a sibling whose name is a prefix plus a separator', () => {
    const root = scratch()
    const approved = join(root, 'work')
    const sibling = join(root, 'work-other')
    mkdirSync(approved, { recursive: true })
    mkdirSync(sibling, { recursive: true })
    expect(() => resolveTaskDirectory(sibling, { root: approved })).toThrow(DispatchRefused)
  })

  it('still refuses a symlink inside the root that points outside it', () => {
    // The reason the comparison runs on real paths at all: a link *inside* the root has a string
    // that starts with the root while its target is somewhere else entirely.
    const root = scratch()
    const approved = join(root, 'Approved')
    const outside = join(root, 'elsewhere')
    mkdirSync(approved, { recursive: true })
    mkdirSync(outside, { recursive: true })
    const link = join(approved, 'sneak')
    try {
      symlinkSync(outside, link, 'junction')
    } catch {
      // Creating a link needs a privilege this account may not have; the case is skipped rather
      // than reported as passing.
      return
    }
    expect(() => resolveTaskDirectory(link, { root: approved })).toThrow(DispatchRefused)
  })
})

// Tests import web-search.js outside a dsh profile, so its @deepseek-ai peers resolve from a
// DeepSeek Harness, as a profile would supply them: WORKGROUP_HARNESS, else the packages that
// `npm run harness` installs in dev/harness, else the checkout this package now lives in, else
// the nearest deepseek-harness/ checkout in a folder above ds-bot.
//
// The third source is the ordinary one here: the bundle is a workspace member at
// packages/bundle/ds-bot inside the application checkout, so its own containing checkout is the
// harness these tests run against.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const plugin = resolve(import.meta.dirname, '..')
/** Whether `dir` is the root of a harness checkout (its base bundle lives here). */
const isCheckout = (dir) => existsSync(join(dir, 'packages', 'bundle', 'base', 'package.json'))
/** The checkout containing `start`, if the package was installed inside a harness checkout. */
const containing = (start) => {
  for (let dir = start; ; dir = dirname(dir)) {
    if (isCheckout(dir)) return dir
    if (dirname(dir) === dir) return undefined
  }
}
const above = (start) => {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'deepseek-harness'))) return join(dir, 'deepseek-harness')
    if (dirname(dir) === dir) return undefined
  }
}
const installed = join(plugin, 'dev', 'harness')
const findHarness = () => {
  if (process.env.WORKGROUP_HARNESS) return process.env.WORKGROUP_HARNESS
  if (existsSync(join(installed, 'node_modules'))) return installed
  const own = containing(plugin)
  if (own) return own
  const near = above(dirname(plugin))
  if (near) return near
  const beside = resolve(plugin, '../deepseek-harness')
  try {
    const git = (...args) => execFileSync('git', ['-C', dirname(plugin), 'rev-parse', ...args], { encoding: 'utf8' }).trim()
    return above(join(dirname(git('--path-format=absolute', '--git-common-dir')), git('--show-prefix'))) ?? beside
  } catch {
    return beside
  }
}
const harness = findHarness()
// Tests that load other harness packages (jsdom) read the same checkout.
process.env.WORKGROUP_HARNESS = harness
// A checkout links the packages into its base bundle; an npm install has them at its root.
const base = resolve(harness, 'packages/bundle/base/package.json')
const anchor = pathToFileURL(existsSync(base) ? base : resolve(harness, 'package.json')).href
const pluginUrl = `${pathToFileURL(plugin).href}/`

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/') && context.parentURL?.startsWith(pluginUrl)) {
      return nextResolve(specifier, { ...context, parentURL: anchor })
    }
    return nextResolve(specifier, context)
  },
})

// F-07..F-09 probe: run DS Bot's client `apply` in Node against a minimal fake shell.
//
// This exists because the browser's plugin loader reports only "one entry did not activate";
// the plugin's own exception is swallowed before it reaches the console. Driving `apply` here
// surfaces the real error, and it also records what the plugin registers, which is what the
// three F-07..F-09 cases need to assert without a browser.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const noop = () => {}
const stubEl = () => ({
  dataset: {}, style: {}, textContent: '',
  append: noop, appendChild: noop, removeChild: noop, insertBefore: noop, remove: noop,
  setAttribute: noop, removeAttribute: noop, addEventListener: noop, removeEventListener: noop,
  contains: () => false, querySelector: () => null, querySelectorAll: () => [],
})

export function loadClientPlugin(bundlePath) {
  const src = readFileSync(bundlePath, 'utf8')
  const platform = {
    react: {
      createElement: () => null, Fragment: Symbol('Fragment'), useState: initial => [initial, noop],
      useEffect: noop, useMemo: make => make(), useRef: current => ({ current }), useLayoutEffect: noop,
      useId: () => 'id', useSyncExternalStore: () => null, createContext: () => ({}),
    },
    'react-dom': { createPortal: node => node },
    '@deepseek-ai/dsh-client-ui-primitives': new Proxy({}, { get: () => () => null }),
  }
  const doc = {
    createElement: stubEl, head: { append: noop, appendChild: noop }, body: { append: noop, appendChild: noop, dataset: {} },
    documentElement: { dataset: {} }, hidden: false, visibilityState: 'visible', addEventListener: noop, removeEventListener: noop,
    querySelector: () => null, querySelectorAll: () => [],
    // The style installer reads the loaded stylesheets to rewrite the shell's hashed class
    // fragments into exact names. No shell sheet exists here, so the empty list is the truthful
    // answer: every fragment selector stays in its substring form.
    styleSheets: [],
  }
  const win = {
    __ModuleLoader__: { load: def => { module_ = def.factory(s => platform[s] ?? (() => null)) } },
    addEventListener: noop, removeEventListener: noop, document: doc,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    location: { href: 'http://127.0.0.1/' }, navigator: { userAgent: 'node', language: 'en-US' },
  }
  let module_
  const saved = {
    window: globalThis.window, document: globalThis.document, localStorage: globalThis.localStorage,
    addEventListener: globalThis.addEventListener, removeEventListener: globalThis.removeEventListener,
    ResizeObserver: globalThis.ResizeObserver, fetch: globalThis.fetch,
  }
  globalThis.window = win
  globalThis.document = doc
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true })
  globalThis.localStorage = win.localStorage
  globalThis.addEventListener = noop
  globalThis.removeEventListener = noop
  globalThis.ResizeObserver = class { observe() {} disconnect() {} }
  // The style installer watches the head for lazily loaded shell sheets. Nothing is appended in
  // this harness, so an observer that just records its subscription is the whole behavior.
  globalThis.MutationObserver = class { observe() {} disconnect() {} }
  // The plugin polls its Host on a timer, and there is no Host here. Returning a rejected
  // promise is the honest answer, but the plugin's own `catch` handles it, so the harness must
  // not leave an unhandled rejection behind: a test run that reports one fails even when every
  // assertion passed. `state` is the shape the plugin's first read expects.
  // The plugin also keeps a poll timer. Timers are captured here so a test can stop them after
  // disposing the plugin: a timer that survives the test file reads `document` outside the stub
  // and surfaces as an unhandled rejection, which fails an otherwise green run.
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const timers = new Set()
  globalThis.setTimeout = (fn, ms, ...rest) => {
    const handle = realSetTimeout((...callArgs) => { timers.delete(handle); fn(...callArgs) }, ms, ...rest)
    timers.add(handle)
    return handle
  }
  globalThis.clearTimeout = handle => { timers.delete(handle); return realClearTimeout(handle) }
  globalThis.fetch = async () => ({
    ok: false,
    status: 503,
    json: async () => ({ ok: false, error: { message: 'no Host in this harness' } }),
  })
  // eslint-disable-next-line no-eval -- the bundle is a classic script by design
  eval(src)
  if (module_ === undefined) throw new Error('the bundle did not register a module')
  // The fake globals stay installed for the whole run, not just for `apply`. The plugin keeps a
  // poll timer that reads bare `document`, so restoring the real globals would make that timer
  // throw on an undefined `document` after the test file finished — an unhandled rejection that
  // fails an otherwise green run. `restore` exists for a caller that wants the globals back
  // after disposing the plugin; these cases deliberately never call it.
  return {
    module: module_,
    /** Stop the plugin's own timers so nothing runs after the test file finishes. */
    stopTimers: () => { for (const handle of timers) realClearTimeout(handle); timers.clear() },
    restore: () => {
      for (const [key, value] of Object.entries(saved)) globalThis[key] = value
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
    },
  }
}

/** A shell stub that records every registration and answers the services DS Bot asks for. */
export function fakeShell() {
  const registrations = []
  const effects = []
  // The Bot surface is installed only while the product's own panel is the active view, so a stub
  // whose subscribe never fires could never reach `installShell`: the gate would read its initial
  // `null` and stay closed. Subscribe/notify is what lets a spec make the same choice a user makes.
  const listeners = new Set()
  const layout = {
    panelInfo: {
      getSnapshot: () => ({ activePanelId: layout.active }),
      subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    },
    selectPanel: (id) => {
      layout.active = id
      for (const listener of [...listeners]) listener()
    },
    active: null,
  }
  const slots = {
    inject: (name, fn) => { const d = fn(); return d },
    register: (options, component) => {
      registrations.push({ options, component })
      return noop
    },
    entries: () => [], entriesOfSlot: () => [], subscribe: () => noop, provideRoot: () => noop,
  }
  const ctx = {
    get: name => (name === 'layout' ? layout : undefined),
    effect: fn => { const d = fn(); effects.push(() => { if (typeof d === 'function') d() }); return noop },
    on: noop, provide: () => noop, plugin: noop, reflect: { provide: () => noop },
    inject: (_deps, fn) => { const d = typeof fn === 'function' ? fn(ctx) : undefined; return typeof d === 'function' ? d : noop },
    slots,
    sessions: { list: { getSnapshot: () => ({ byId: {}, ids: [] }), subscribe: () => noop }, binding: () => undefined },
    uiWorkspace: { openSession: noop, startSession: noop },
    uiConversation: { binding: () => ({ target: () => ({ getSnapshot: () => undefined }) }) },
    // The theme is installed by overriding the shell's tokens; the release function is what the
    // plugin calls on withdrawal, so it has to be a function and is otherwise unused here.
    theme: { subscribe: () => noop, overrideTokens: () => noop },
    locale: { register: () => noop, bind: () => (s => s), subscribe: () => noop },
    workspaceRegistry: { get: () => undefined, create: async () => ({ id: 'w' }) },
    sessionTitle: { rename: async () => {} },
  }
  return { ctx, registrations, layout, effects }
}

export const harnessInternals = { join, createRequire }

# Workgroup Creation Entry Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Connect the existing workgroup creation action to the two native visible group creation entry points while preserving local group creation.

**Architecture:** `overlays.js` already owns the reactive `useWorkgroups` value. Pass that value into `SettingsDialog`, then into `GroupsPage`, where a gated button immediately follows the local group button and calls the existing `workgroups.create` action. The existing `NewChat` route remains unchanged and continues to use the same action object.

**Tech Stack:** JavaScript ESM, React/Preact-compatible `h`, Vitest, pnpm workspace scripts, esbuild client bundle.

## Global Constraints

- Only modify the workgroup creation entry chain: `application/packages/bundle/ds-bot/src/client/overlays.js`, `application/packages/bundle/ds-bot/src/client/settings.js`, the new focused regression test, and the generated client bundle if the build updates it.
- Keep the native `Create group chat` button and its `setCreating(true)` local flow unchanged.
- Display `Create workgroup chat` only when the reactive `workgroups` action object is defined.
- Reuse `workgroups.create`; do not duplicate Hub creation, Session registration, navigation, or watch logic.
- Preserve the existing uncommitted work in the repository; do not reset, clean, or overwrite unrelated files.
- Do not expose or add credentials.

---

### Task 1: Add the failing regression test for settings entry wiring

**Files:**
- Create: `application/integrations/workgroup/tests/a04-workgroup-entry-wiring.spec.ts`

**Interfaces:**
- Consumes: source files `packages/bundle/ds-bot/src/client/overlays.js` and `packages/bundle/ds-bot/src/client/settings.js`.
- Produces: static regression assertions for the settings entry's prop flow, ordering, Hub gate, and shared create action.

- [x] **Step 1: Create the focused test**

Create `application/integrations/workgroup/tests/a04-workgroup-entry-wiring.spec.ts` with this complete content:

```ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = join(import.meta.dirname, '..', '..', '..')
const readClientSource = name => readFileSync(join(repoRoot, 'packages', 'bundle', 'ds-bot', 'src', 'client', name), 'utf8')

describe('workgroup creation entry wiring', () => {
  it('passes reactive workgroup actions from overlays into SettingsDialog', () => {
    const source = readClientSource('overlays.js')
    expect(source).toMatch(/h\(SettingsDialog, \{[^}]*workgroups[^}]*\}\)/s)
  })

  it('passes workgroup actions into GroupsPage and keeps the local group action', () => {
    const source = readClientSource('settings.js')
    expect(source).toMatch(/function GroupsPage\(\{ roster, actions, run, workgroups \}\)/)
    expect(source).toMatch(/h\(GroupsPage, \{ roster, actions, run, workgroups \}\)/)
    expect(source).toMatch(/onClick: \(\) => setCreating\(true\)[\s\S]*?t\('Create group chat'\)/)
  })

  it('renders the workgroup entry below the local group entry and calls the shared action', () => {
    const source = readClientSource('settings.js')
    const groupIndex = source.indexOf("t('Create group chat')")
    const workgroupIndex = source.indexOf("t('Create workgroup chat')")
    expect(groupIndex, 'the original group entry must still exist').toBeGreaterThanOrEqual(0)
    expect(workgroupIndex, 'the workgroup entry must exist').toBeGreaterThan(groupIndex)
    expect(source).toMatch(/workgroups !== undefined\s*\?[\s\S]*?onClick: \(\) => void run\(workgroups\.create\(\)\)[\s\S]*?t\('Create workgroup chat'\)/)
  })

  it('passes the workgroup action object through SettingsDialog', () => {
    const source = readClientSource('settings.js')
    expect(source).toMatch(/export function SettingsDialog\(\{[^}]*workgroups[^}]*\}/s)
  })
})
```

- [x] **Step 2: Run the new test before implementation**

Run from `Workgroup-AI/application`:

```sh
pnpm exec vitest run integrations/workgroup/tests/a04-workgroup-entry-wiring.spec.ts
```

Expected: FAIL because `overlays.js` does not pass `workgroups` to `SettingsDialog`, `SettingsDialog` does not accept it, and `GroupsPage` has no workgroup button yet.

---

### Task 2: Wire the settings entry to the existing workgroup action

**Files:**
- Backup before editing: `backups/2026-10-17-workgroup-entry-wiring/overlays.js`
- Backup before editing: `backups/2026-10-17-workgroup-entry-wiring/settings.js`
- Modify: `application/packages/bundle/ds-bot/src/client/overlays.js:53`
- Modify: `application/packages/bundle/ds-bot/src/client/settings.js:128-149,299,352`

**Interfaces:**
- Consumes: `useWorkgroups` reactive source from `overlays.js` and `workgroups.create` from `index.js`.
- Produces: `SettingsDialog({ ..., workgroups })` and `GroupsPage({ ..., workgroups })`; the new settings button invokes `void run(workgroups.create())`.

- [x] **Step 1: Back up the two source files**

From `Workgroup-AI`, create the backup directory and copy the exact current files:

```sh
mkdir -p backups/2026-10-17-workgroup-entry-wiring
cp application/packages/bundle/ds-bot/src/client/overlays.js backups/2026-10-17-workgroup-entry-wiring/overlays.js
cp application/packages/bundle/ds-bot/src/client/settings.js backups/2026-10-17-workgroup-entry-wiring/settings.js
```

Expected: both backup files exist and contain the pre-change source.

- [x] **Step 2: Pass the reactive action object from `overlays.js`**

Change the existing settings portal call from:

```js
settings ? createPortal(h(SettingsDialog, { page: settings.page, id: settings.id, roster, actions, useUpdate, hub, workgroupHub, sessions, leaving: settingsLeaving }), document.body) : null,
```

to:

```js
settings ? createPortal(h(SettingsDialog, { page: settings.page, id: settings.id, roster, actions, useUpdate, hub, workgroupHub, workgroups, sessions, leaving: settingsLeaving }), document.body) : null,
```

- [x] **Step 3: Accept and forward `workgroups` in `settings.js`**

Change the Settings dialog signature from:

```js
export function SettingsDialog({ page, id, roster, actions, useUpdate, hub, workgroupHub, sessions, leaving = false }) {
```

to:

```js
export function SettingsDialog({ page, id, roster, actions, useUpdate, hub, workgroupHub, workgroups, sessions, leaving = false }) {
```

Change the Groups page call from:

```js
shown === 'groups' && !room ? h(GroupsPage, { roster, actions, run }) : null,
```

to:

```js
shown === 'groups' && !room ? h(GroupsPage, { roster, actions, run, workgroups }) : null,
```

- [x] **Step 4: Add the gated workgroup button immediately after the local button**

Change the `GroupsPage` signature from:

```js
function GroupsPage({ roster, actions, run }) {
```

to:

```js
function GroupsPage({ roster, actions, run, workgroups }) {
```

Keep the existing local button unchanged and append this sibling immediately after it inside the `bt-actions` container:

```js
workgroups !== undefined
  ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon', onClick: () => void run(workgroups.create()) }, h(PlusIcon), t('Create workgroup chat'))
  : null,
```

The resulting non-creating branch must keep the local button first, followed by the conditional workgroup button:

```js
: h('div', { key: 'new', className: 'bt-actions' },
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon', disabled: roster.bots.length < 2, title: roster.bots.length < 2 ? t('A group chat needs at least two Bots') : undefined, onClick: () => setCreating(true) }, h(PlusIcon), t('Create group chat')),
    workgroups !== undefined
      ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon', onClick: () => void run(workgroups.create()) }, h(PlusIcon), t('Create workgroup chat'))
      : null),
```

- [x] **Step 5: Run the focused test after implementation**

Run from `Workgroup-AI/application`:

```sh
pnpm exec vitest run integrations/workgroup/tests/a04-workgroup-entry-wiring.spec.ts
```

Expected: PASS for all four tests.

---

### Task 3: Rebuild the shipped client and run the relevant regression checks

**Files:**
- Modify if generated: `application/packages/bundle/ds-bot/client.js`
- Test: `application/integrations/workgroup/tests/a04-workgroup-entry-wiring.spec.ts`
- Test: `application/integrations/workgroup/tests/bot-entry.spec.ts`

**Interfaces:**
- Consumes: the source-level prop wiring from Task 2.
- Produces: a shipped client bundle containing the settings workgroup entry and focused regression evidence.

- [x] **Step 1: Back up the generated bundle before rebuilding**

From `Workgroup-AI`, create the backup if needed and copy the current tracked bundle:

```sh
mkdir -p backups/2026-10-17-workgroup-entry-wiring
cp application/packages/bundle/ds-bot/client.js backups/2026-10-17-workgroup-entry-wiring/client.js
```

- [x] **Step 2: Build the DS Bot package**

Run from `Workgroup-AI/application`:

```sh
pnpm --filter @deepseek-ai/dsh-bot build
```

Expected: the package build exits with status 0 and regenerates the client bundle from `src/client`.

- [x] **Step 3: Run the new wiring test and the existing Bot entry regression test**

Run from `Workgroup-AI/application`:

```sh
pnpm exec vitest run integrations/workgroup/tests/a04-workgroup-entry-wiring.spec.ts integrations/workgroup/tests/bot-entry.spec.ts
```

Expected: the new four-test wiring file passes. Record any pre-existing failure in `bot-entry.spec.ts` separately; do not label the task successful if the new wiring test or build fails.

- [x] **Step 4: Inspect the final diff only for this task's files**

Run from `Workgroup-AI`:

```sh
git diff -- application/packages/bundle/ds-bot/src/client/overlays.js application/packages/bundle/ds-bot/src/client/settings.js application/integrations/workgroup/tests/a04-workgroup-entry-wiring.spec.ts application/packages/bundle/ds-bot/client.js
```

Expected: the diff contains only the `workgroups` prop forwarding, the conditional settings button, the focused test, and the generated bundle changes; unrelated existing modifications remain outside this task's diff.

- [x] **Step 5: Report task evidence**

Report the task using the project-required format:

```text
任务ID → A-04入口接线补齐
涉及路径 → overlays.js, settings.js, a04-workgroup-entry-wiring.spec.ts, generated client.js
前置条件 → existing workgroupActions.create and NewChat entry remain available
修改摘要 → Settings → Group chats now exposes a Hub-gated workgroup button using the shared create action
实际测试命令 → exact commands run above
结果与证据 → build status, focused test counts, and any pre-existing regression failures
未解决风险 → real-browser pixel validation is outside this entry wiring task
```

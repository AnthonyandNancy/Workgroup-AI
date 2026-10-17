# Workgroup Guest Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the standalone Workgroup Hub create and persist a demo guest identity automatically when DS Bot first enters the workgroup provider, so `Create workgroup chat` is usable without Hub authentication UI.

**Architecture:** `server/` owns an unauthenticated, configuration-gated `POST /api/v1/auth/bootstrap` route that creates a user, device, refresh family, and audit records atomically, then returns a normal Bearer session. The Host owns the installation identifier and all tokens, resumes or refreshes existing sessions, and bootstraps a new session when needed. The renderer receives only public identity and connection state; the existing workgroup entry remains gated by `workgroups !== undefined`.

**Tech Stack:** Node.js 24 ESM, Fastify, SQLite, existing auth/token/store modules, Vitest, node:test, React/JS client glue, generated DS Bot client bundle.

## Global Constraints

- `server/` remains the only independently deployed Hub and must not import `application/`.
- `HUB_ANONYMOUS_BOOTSTRAP` defaults to `false`; demo deployments must explicitly set it to `true`.
- Ordinary Hub routes continue to require Bearer access tokens and active devices.
- Host stores access/refresh tokens; renderer never receives tokens, passwords, device secrets, or internal password hashes.
- `installationId` is the only identity input supplied by the Host; the Hub generates user IDs, handles, display names, permissions, device keys, and credentials.
- The identity lifecycle is scoped to the local application data directory; clearing that data creates a new guest user.
- Preserve menu order: `Create group chat` → `Create workgroup chat` → `Add DSH Agent`.
- Do not add root runtime directories or independently deployed code outside `application/` and `server/`.
- Do not run permanent deletion commands. Test cleanup must use the repository recycle helper or leave OS temporary data for later recycling.

---

### Task 1: Back up the implementation surface

**Files:**
- Create: `backups/2026-10-17-workgroup-guest-bootstrap/` copies of the server config, identity route, server setup, auth store, OpenAPI contract, Hub protocol client, Host adapter, Bot settings, and their focused tests.

**Interfaces:**
- Consumes: the current files listed above.
- Produces: a reviewable point-in-time backup before core-file edits.

- [ ] **Step 1: Copy the current core files into the root backup directory**

Run from `Workgroup-AI/`:

```sh
mkdir -p backups/2026-10-17-workgroup-guest-bootstrap
cp server/src/config/index.js backups/2026-10-17-workgroup-guest-bootstrap/server-config-index.js
cp server/src/api/identity.js backups/2026-10-17-workgroup-guest-bootstrap/server-api-identity.js
cp server/src/server.js backups/2026-10-17-workgroup-guest-bootstrap/server-server.js
cp server/src/auth/store.js backups/2026-10-17-workgroup-guest-bootstrap/server-auth-store.js
cp server/contracts/openapi.yaml backups/2026-10-17-workgroup-guest-bootstrap/server-openapi.yaml
cp application/integrations/workgroup/protocol/hub-client.mjs backups/2026-10-17-workgroup-guest-bootstrap/hub-client.mjs
cp application/packages/bundle/ds-bot/src/host/workgroup-hub.js backups/2026-10-17-workgroup-guest-bootstrap/host-workgroup-hub.js
cp application/packages/bundle/ds-bot/src/client/settings.js backups/2026-10-17-workgroup-guest-bootstrap/client-settings.js
cp server/tests/h03-identity.test.js backups/2026-10-17-workgroup-guest-bootstrap/h03-identity.test.js
cp application/integrations/workgroup/tests/a01-hub-client.spec.ts backups/2026-10-17-workgroup-guest-bootstrap/a01-hub-client.spec.ts
cp application/integrations/workgroup/tests/a13-hub-provider-host.spec.ts backups/2026-10-17-workgroup-guest-bootstrap/a13-hub-provider-host.spec.ts
cp application/integrations/workgroup/tests/a14-hub-settings.spec.ts backups/2026-10-17-workgroup-guest-bootstrap/a14-hub-settings.spec.ts
```

Expected: every source file and focused test has one matching backup under the dated directory.

- [ ] **Step 2: Verify the backup contains the expected files without reading unrelated directories**

Run:

```sh
find backups/2026-10-17-workgroup-guest-bootstrap -maxdepth 1 -type f -print
```

Expected: the twelve named backup files are present; no project source is modified by this step.

---

### Task 2: Add the server bootstrap contract, configuration, storage transaction, and tests

**Files:**
- Modify: `server/src/config/index.js`
- Modify: `server/src/server.js`
- Modify: `server/src/auth/store.js`
- Modify: `server/src/api/identity.js`
- Modify: `server/contracts/openapi.yaml`
- Create: `server/tests/h15-guest-bootstrap.test.js`

**Interfaces:**
- Consumes: existing `hashPassword`, `issueAccessToken`, `generateRefreshToken`, `PersistentLimiter`, `createUser` validation rules, device/revocation queries, and the existing identity error response helper.
- Produces: `config.security.anonymousBootstrap`, `config.security.bootstrapMaxAttempts`, `config.security.bootstrapWindowSeconds`; `createGuestIdentity(...)`; and `POST /api/v1/auth/bootstrap` returning `{ user, device, accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt }`.

- [ ] **Step 1: Write the failing real HTTP tests**

Create `server/tests/h15-guest-bootstrap.test.js` with a real Fastify/SQLite harness and these behavior cases:

```js
test('bootstrap is disabled by default and returns no credentials', async () => {
  await withHub(async ({ call }) => {
    const result = await call('POST', '/auth/bootstrap', {
      installationId: '11111111-1111-4111-8111-111111111111',
      deviceLabel: 'DSH Bot',
      platform: 'web',
      appVersion: 'test',
    })
    assert.equal(result.status, 403)
    assert.equal(result.body.error.code, 'ANONYMOUS_BOOTSTRAP_DISABLED')
    assert.equal('accessToken' in result.body, false)
  })
})

test('enabled bootstrap creates an active identity and its token reaches rooms', async () => {
  await withHub(async ({ call, db }) => {
    const result = await call('POST', '/auth/bootstrap', BOOTSTRAP_REQUEST)
    assert.equal(result.status, 201)
    assert.match(result.body.user.id, /^[0-9a-f-]{36}$/)
    assert.match(result.body.user.userHandle, /^guest-/)
    assert.equal(result.body.user.status, 'active')
    assert.equal(result.body.device.platform, 'web')
    assert.equal(result.body.passwordHash, undefined)
    assert.equal(result.body.device.publicKey, undefined)
    const rooms = await call('GET', '/rooms', undefined, result.body.accessToken)
    assert.equal(rooms.status, 200)
    assert.equal(db.prepare('SELECT count(*) AS n FROM devices WHERE user_id = ?').get(result.body.user.id).n, 1)
    assert.equal(db.prepare("SELECT count(*) AS n FROM audit_events WHERE actor_user_id = ? AND event_type IN ('user.created', 'device.registered')").get(result.body.user.id).n, 2)
  }, { HUB_ANONYMOUS_BOOTSTRAP: 'true' })
})

test('bootstrap validates UUID, display length, and unknown fields', async () => {
  await withHub(async ({ call }) => {
    for (const body of [
      { ...BOOTSTRAP_REQUEST, installationId: 'bad' },
      { ...BOOTSTRAP_REQUEST, deviceLabel: 'x'.repeat(121) },
      { ...BOOTSTRAP_REQUEST, userId: 'client-chosen' },
    ]) {
      const result = await call('POST', '/auth/bootstrap', body)
      assert.equal(result.status, 400)
      assert.equal(result.body.accessToken, undefined)
    }
  }, { HUB_ANONYMOUS_BOOTSTRAP: 'true' })
})

test('bootstrap refresh rotates credentials and revoking the device blocks refresh', async () => {
  await withHub(async ({ call, db }) => {
    const created = await call('POST', '/auth/bootstrap', BOOTSTRAP_REQUEST)
    const rotated = await call('POST', '/auth/refresh', { refreshToken: created.body.refreshToken })
    assert.equal(rotated.status, 200)
    assert.notEqual(rotated.body.refreshToken, created.body.refreshToken)
    const deviceId = created.body.device.id
    await call('POST', `/auth/devices/${deviceId}/revoke`, {}, created.body.accessToken)
    const refused = await call('POST', '/auth/refresh', { refreshToken: rotated.body.refreshToken })
    assert.equal(refused.status, 401)
    assert.equal(db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(deviceId).revoked_at !== null, true)
  }, { HUB_ANONYMOUS_BOOTSTRAP: 'true' })
})

test('bootstrap rate limit counts failures and uses configured values', async () => {
  await withHub(async ({ call }) => {
    const first = await call('POST', '/auth/bootstrap', { ...BOOTSTRAP_REQUEST, installationId: 'not-a-uuid' })
    const second = await call('POST', '/auth/bootstrap', { ...BOOTSTRAP_REQUEST, installationId: 'not-a-uuid' })
    assert.equal(first.status, 400)
    assert.equal(second.status, 429)
    assert.equal(second.body.error.code, 'TOO_MANY_ATTEMPTS')
  }, { HUB_ANONYMOUS_BOOTSTRAP: 'true', HUB_BOOTSTRAP_MAX_ATTEMPTS: '1', HUB_BOOTSTRAP_WINDOW_SECONDS: '60' })
})
```

The helper must use a recycle-safe teardown; do not copy the existing `rmSync` cleanup into the new test.

- [ ] **Step 2: Run the new test file to verify the feature is absent**

Run from `Workgroup-AI/server`:

```sh
node --test tests/h15-guest-bootstrap.test.js
```

Expected: FAIL because the bootstrap configuration and route do not exist yet. Fix only test harness mistakes if the failure is an import or assertion error rather than the missing behavior.

- [ ] **Step 3: Add validated bootstrap configuration**

In `loadConfig`, parse the three new settings into `config.security`:

```js
const anonymousBootstrap = readString(env, 'HUB_ANONYMOUS_BOOTSTRAP') === 'true'
const bootstrapMaxAttempts = readInteger(env, 'HUB_BOOTSTRAP_MAX_ATTEMPTS', problems, { min: 1, max: 1000 }) ?? 10
const bootstrapWindowSeconds = readInteger(env, 'HUB_BOOTSTRAP_WINDOW_SECONDS', problems, { min: 10, max: 86400 }) ?? 300
```

Keep the existing invalid boolean convention: a non-empty value other than `true` is false, and expose the two numeric values beside the login limiter settings.

- [ ] **Step 4: Add the atomic guest identity store operation**

Add `createGuestIdentity(db, options)` to `server/src/auth/store.js`. It must generate UUIDs for user and device, insert the active user with the supplied internal password hash, insert the device using server-generated `guest:<installationId>` fingerprint and `guest:<random>` public key, insert the first refresh token with only its lookup ID and hash, and write `user.created`, `device.registered`, and `token.issued` audit rows inside one `BEGIN IMMEDIATE` transaction. On any error, roll back and rethrow; return the user row, device row, refresh token expiry, and IDs needed by the route.

The function accepts only server-side generated `userHandle`, `displayName`, `passwordHash`, `installationId`, `label`, `platform`, `appVersion`, `refreshSecret`, `refreshTtlSeconds`, and `now`. It must call `assertUserHandle` and `assertDisplayName` so the route cannot bypass existing identity rules.

- [ ] **Step 5: Add the unauthenticated bootstrap route and limiter**

Construct a `bootstrapLimiter` in `server/src/server.js` with `config.security.bootstrapMaxAttempts`, `config.security.bootstrapWindowSeconds`, and the existing lockout setting, decorate it as `fastify.hub.bootstrapLimiter`, and register it in `server/src/api/identity.js`.

The route must:

1. Reject with `403 ANONYMOUS_BOOTSTRAP_DISABLED` before parsing secrets when the flag is false.
2. Count each invalid request against a source key such as `bootstrap:${request.ip}` and return `429 TOO_MANY_ATTEMPTS` with `retry-after` after the configured budget.
3. Accept exactly `installationId`, `deviceLabel`, `platform`, and `appVersion`; require a UUID installation ID and enforce the existing 1–120 display length on `deviceLabel` plus bounded string lengths for platform and app version.
4. Generate `guest-<uuid fragment>` and `Guest <uuid fragment>` server-side, hash a random internal password with `hashPassword`, generate refresh/access credentials with existing token helpers, and call `createGuestIdentity`.
5. Return status 201 with only public user/device fields and session expiry fields; never include the internal password hash, generated public key, installation ID, limiter details, or raw database error.
6. Clear the source limiter after success and use the existing identity error envelope for validation and persistence failures.

- [ ] **Step 6: Run the server tests to verify green**

Run:

```sh
node --test tests/h15-guest-bootstrap.test.js
```

Expected: all bootstrap cases pass. Then run the existing identity regression without claiming cleanup safety until its teardown is converted to the recycle helper:

```sh
node --test tests/h03-identity.test.js
```

Expected: existing registration, login, refresh, and device revocation cases still pass.

- [ ] **Step 7: Update the versioned OpenAPI contract**

Add `POST /auth/bootstrap` under `server/contracts/openapi.yaml` with `security: []`, the four exact request properties, a 201 response matching the public response fields, and documented 400/403/429 errors. Do not weaken the global Bearer requirement for any existing path.

- [ ] **Step 8: Run the contract parity test**

Run:

```sh
node --test tests/d-contract-parity.test.js
```

Expected: PASS with the new route present in the contract and implementation.

---

### Task 3: Add protocol-level bootstrap and installation state

**Files:**
- Modify: `application/integrations/workgroup/protocol/hub-client.mjs`
- Modify: `application/integrations/workgroup/tests/a01-hub-client.spec.ts`

**Interfaces:**
- Consumes: `POST /api/v1/auth/bootstrap` and the existing session persistence helpers.
- Produces: `hubInstallationPath(dshHome)`, `loadInstallationState(path)`, `saveInstallationState(path, state)`, and `client.bootstrap({ installationId, deviceLabel, platform })`; the client continues exposing only public `identity` to callers.

- [ ] **Step 1: Write failing client tests against the real Hub**

Add cases to `a01-hub-client.spec.ts` that start the real Hub with `HUB_ANONYMOUS_BOOTSTRAP=true` and assert:

```ts
it('bootstraps a guest session and persists only the Host session fields', async () => {
  const statePath = join(tempDir(), 'session.json')
  const agent = client({ statePath })
  const session = await agent.bootstrap({ installationId: '22222222-2222-4222-8222-222222222222', deviceLabel: 'DSH Bot', platform: 'web' })
  expect(session.user.userHandle).toMatch(/^guest-/)
  expect(agent.signedIn).toBe(true)
  expect(agent.identity.userHandle).toBe(session.user.userHandle)
  expect(agent.identity.accessToken).toBeUndefined()
  expect(readFileSync(statePath, 'utf8')).toContain('refreshToken')
})

it('rejects bootstrap when the Hub demo flag is disabled', async () => {
  const agent = client({ statePath: join(tempDir(), 'session.json') })
  await expect(agent.bootstrap({ installationId: '33333333-3333-4333-8333-333333333333', deviceLabel: 'DSH Bot', platform: 'web' })).rejects.toMatchObject({ code: 'ANONYMOUS_BOOTSTRAP_DISABLED', status: 403 })
})
```

- [ ] **Step 2: Run the focused client tests to verify they fail**

Run from `Workgroup-AI/application`:

```sh
pnpm exec vitest run integrations/workgroup/tests/a01-hub-client.spec.ts
```

Expected: FAIL because the client has no `bootstrap` method and no installation-state helper.

- [ ] **Step 3: Implement the client bootstrap method and installation helpers**

Use the existing `request('POST', '/auth/bootstrap', { auth: false })`, persist the returned session using the same atomic owner-only write used by login, and derive `accessTokenExpiresAt` from the returned TTL when needed. Add an installation state file helper that stores only `{ installationId, hubUrl, appVersion }`; generate the ID in Host code, not in the renderer or Hub client module.

- [ ] **Step 4: Run the focused client tests to verify green**

Run the same Vitest command. Expected: the new bootstrap and disabled-flag cases pass, and all existing Hub client cases remain green.

---

### Task 4: Make the Host automatically ensure a guest session

**Files:**
- Modify: `application/packages/bundle/ds-bot/src/host/workgroup-hub.js`
- Modify: `application/integrations/workgroup/tests/a13-hub-provider-host.spec.ts`

**Interfaces:**
- Consumes: protocol `hubInstallationPath` helpers and `client.bootstrap`, existing `resume`, `startBridge`, and `hubView` behavior.
- Produces: Host-private `ensureGuestSession()`; `hub-view` becomes an async readiness projection that never exposes credentials and returns a stable unavailable state on Hub transport/configuration errors.

- [ ] **Step 1: Write failing Host tests**

Add Host adapter cases with scripted `fetch` and `WebSocket` implementations:

```ts
it('bootstraps once on first hub-view and keeps credentials out of the returned view', async () => {
  const requests = []
  vi.stubGlobal('fetch', async (url, init) => {
    requests.push({ url: String(url), init })
    if (String(url).endsWith('/auth/bootstrap')) return response({
      user: { id: 'guest-user', userHandle: 'guest-abcd', displayName: 'Guest ABCD', status: 'active' },
      device: { id: 'guest-device', label: 'DSH Bot', platform: 'web', appVersion: 'test' },
      accessToken: 'host-only-access', refreshToken: 'host-only-refresh',
      accessTokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
      refreshTokenExpiresAt: new Date(Date.now() + 86400000).toISOString(),
    })
    throw new Error(`unexpected request ${String(url)}`)
  })
  const rt = runtime({ hubUrl: 'https://initial.example' })
  install(rt)
  const view = await rt.hubEndpoint('hub-view')
  expect(view).toMatchObject({ configured: true, signedIn: true, userHandle: 'guest-abcd' })
  expect(JSON.stringify(view)).not.toContain('host-only')
  expect(requests.filter(item => item.url.endsWith('/auth/bootstrap'))).toHaveLength(1)
})

it('keeps the provider unavailable when bootstrap cannot reach the Hub', async () => {
  vi.stubGlobal('fetch', async () => { throw new Error('offline') })
  const rt = runtime({ hubUrl: 'https://initial.example' })
  install(rt)
  await expect(rt.hubEndpoint('hub-view')).resolves.toMatchObject({ configured: true, signedIn: false, state: 'unavailable' })
})
```

Add a persisted-session case proving a second `hub-view` uses refresh/resume and does not call bootstrap again, plus a refresh-failure case proving the Host clears the invalid session and bootstraps a replacement identity. Keep all tokens in the temporary Host session file and assert they never occur in the endpoint result.

- [ ] **Step 2: Run the focused Host tests to verify red**

Run:

```sh
pnpm exec vitest run integrations/workgroup/tests/a13-hub-provider-host.spec.ts
```

Expected: the new cases fail because `hub-view` currently only reports `signedIn` and never bootstraps.

- [ ] **Step 3: Implement `ensureGuestSession()` with one in-flight operation**

Add an installation-state path beside `hubStatePath(dshHome)`. On first use, load or create a UUID installation ID, persist it with the resolved Hub URL and app version, create the Host Hub client, then:

```js
async function ensureGuestSession() {
  const current = ensureClient()
  if (current.signedIn) {
    await startBridge()
    return
  }
  if (current.hasRefreshToken) {
    try {
      await current.resume()
      await startBridge()
      return
    } catch {
      clearHubSession(statePath)
      client = undefined
      workgroup = undefined
    }
  }
  await ensureClient().bootstrap({ installationId, deviceLabel: 'DSH Bot', platform: 'web' })
  await startBridge()
}
```

Use an operation-local promise to coalesce concurrent `hub-view` calls. Catch `HUB_UNREACHABLE`, `ANONYMOUS_BOOTSTRAP_DISABLED`, invalid configuration, and revoked-session failures in the endpoint projection, set `connectionState = 'unavailable'`, and return `signedIn: false` without throwing through the renderer. Do not clear installation state when re-bootstrap is needed. Preserve local Bot operation because only workgroup provider availability changes.

Expose no new credential-bearing RPC. Update `hub-view` to await `ensureGuestSession()` and then return the existing redacted `hubView()`.

- [ ] **Step 4: Run the Host tests to verify green**

Run the same Vitest command. Expected: bootstrap, resume, re-bootstrap, offline, credential redaction, and existing Bridge cases pass.

---

### Task 5: Remove Hub authentication UI and preserve the entry behavior

**Files:**
- Modify: `application/packages/bundle/ds-bot/src/client/settings.js`
- Modify: `application/integrations/workgroup/tests/a14-hub-settings.spec.ts`
- Modify: `application/integrations/workgroup/tests/a11-hub-provider.spec.ts` only where assertions still describe the removed settings API.

**Interfaces:**
- Consumes: the Host-driven `hub-view` provider state and existing workgroup UI.
- Produces: Settings navigation without the `hub` page; Bot continues rendering `Create workgroup chat` only when the Host provider is available.

- [ ] **Step 1: Write the failing UI test**

Replace the old Hub form tests with a focused Settings navigation assertion:

```ts
it('does not expose a Workgroup Hub settings page or credential form', async () => {
  const { props } = await mountSettings({ page: 'hub' })
  expect(container.textContent).not.toContain('Workgroup Hub')
  expect(container.textContent).not.toContain('Sign in')
  expect(container.textContent).not.toContain('Register')
  expect(container.textContent).not.toContain('Configure Hub')
  expect(props.actions.openSettings).not.toHaveBeenCalledWith(expect.objectContaining({ page: 'hub' }))
})
```

Keep one existing test proving ordinary `general` settings still render.

- [ ] **Step 2: Run the settings test to verify it fails**

Run:

```sh
pnpm exec vitest run integrations/workgroup/tests/a14-hub-settings.spec.ts
```

Expected: FAIL because `SETTINGS_PAGES` still contains `hub` and `HubPage` renders authentication controls.

- [ ] **Step 3: Remove the Hub page and its authentication controls**

Delete the `['hub', 'Workgroup Hub']` navigation item, remove `HubPage`, and remove the `shown === 'hub'` render branch. Leave workgroup room/member behavior in the existing workgroup panes and preserve all unrelated settings pages. Do not add a replacement URL, password, registration, sign-in, sign-out, or invitation-management page.

- [ ] **Step 4: Run UI and entry regression tests**

Run:

```sh
pnpm exec vitest run integrations/workgroup/tests/a14-hub-settings.spec.ts integrations/workgroup/tests/a11-hub-provider.spec.ts integrations/workgroup/tests/a04-workgroup-entry-wiring.spec.ts integrations/workgroup/tests/bot-entry.spec.ts
```

Expected: Settings has no Hub page, the provider becomes available from Host state, and menu order remains `Create group chat`, `Create workgroup chat`, `Add DSH Agent`.

---

### Task 6: Build the generated client and run the required verification

**Files:**
- Modify: `application/packages/bundle/ds-bot/client.js` only through the repository build script if the source/artifact check requires regeneration.
- Review: all files changed in Tasks 2–5 and their direct imports.

**Interfaces:**
- Consumes: the completed server route, Host session flow, UI removal, and focused tests.
- Produces: a fresh build artifact and evidence for the approved acceptance criteria.

- [ ] **Step 1: Run the focused server and application tests after the latest source changes**

Run:

```sh
cd server && node --test tests/h15-guest-bootstrap.test.js tests/d-contract-parity.test.js
cd ../application && pnpm exec vitest run integrations/workgroup/tests/a01-hub-client.spec.ts integrations/workgroup/tests/a11-hub-provider.spec.ts integrations/workgroup/tests/a13-hub-provider-host.spec.ts integrations/workgroup/tests/a14-hub-settings.spec.ts integrations/workgroup/tests/a04-workgroup-entry-wiring.spec.ts integrations/workgroup/tests/bot-entry.spec.ts
```

Expected: every selected test passes with exit code 0.

- [ ] **Step 2: Build DS Bot and refresh the generated bundle when required**

Run:

```sh
pnpm --filter @deepseek-ai/dsh-bot build
node packages/bundle/ds-bot/scripts/build-client.mjs --check
```

Expected: build succeeds and the bundle freshness check passes.

- [ ] **Step 3: Perform the bounded read-only review**

Review only the changed server files, changed protocol/Host/UI files, their direct imports, and the approved design spec. Check that:

- bootstrap is the only unauthenticated business route;
- all success responses redact password hashes, device public keys, installation IDs, and tokens from renderer projections;
- refresh rotation and device revocation still use existing auth paths;
- offline Host failures do not disable local Bot/group/session behavior;
- no Hub settings page remains;
- workgroup entry order is unchanged;
- no application code is imported by `server/`.

- [ ] **Step 4: Run final static checks**

Run from `Workgroup-AI/application` and the repository root as applicable:

```sh
git diff --check
```

Expected: exit code 0 and no whitespace errors. Report source tests, real single-Hub tests, and any unavailable real two-device evidence separately.

## Spec coverage self-review

- Sections 1–3: Tasks 4–5 keep Hub independent, Host-owned credentials, and the existing workgroup entry.
- Section 4: Task 2 adds the gated route, exact request/response fields, atomic identity creation, redaction, and rate limits.
- Section 5: Task 4 adds installation state, refresh/re-bootstrap behavior, Bridge startup, and offline degradation.
- Section 6: Task 5 removes the Settings page while retaining workgroup rendering.
- Section 7: Task 2 adds the three config values and preserves existing auth paths.
- Section 8: Tasks 2–6 cover every listed server/application acceptance case and required commands.
- Section 9: Task 6 reports the demo-only limits without expanding implementation scope.

No step depends on a placeholder or an undefined neighboring function: the plan names the new store function, client bootstrap method, installation helpers, Host ensure operation, endpoint, test files, and verification commands explicitly.

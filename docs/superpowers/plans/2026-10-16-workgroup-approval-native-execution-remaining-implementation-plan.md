# Workgroup W3-W4 Remaining Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the remaining W3 approval, native execution, progress/cancellation/review work, then perform W4 verification and evidence closeout without overstating unverified results.

**Architecture:** The Hub remains the task, membership, approval, grant, and redacted-event authority. Execution remains on the task owner's Host through the existing DSH native Bot and an isolated Task Session; W4 validates the two existing runtime boundaries and records evidence by S/M/L/N/P level.

**Tech Stack:** JavaScript/React, Cordis/DSH Loader and app process, Fastify/SQLite Hub APIs, DSH native Bot Task Sessions, Vitest, pnpm, existing bundle generation scripts, Markdown evidence records.

## Global Constraints

- This is a continuation of the approved plan `docs/superpowers/plans/2026-10-16-workgroup-approval-native-execution-implementation-plan.md`; it does not approve new product scope or server protocol/schema changes.
- API and realtime protocol authority remains `server/contracts/`; application-side generated types/validators or thin adapters belong under `application/integrations/workgroup/protocol/`. Do not create a third shared-contract project. If the approved scope cannot fit the existing contract, stop and request approval before changing it.
- The prior session checkpoint reports W1, W2, W3-T1, and W3-T2 complete. The original task-plan checkboxes may still be unchecked; reconcile source, focused tests, and current diffs before relying on that status. Do not reimplement completed work merely because a checkbox is stale.
- Mentions may create only `PENDING_APPROVAL` tasks. No grant, Task Session, or tool call may occur before an owner decision.
- Only `task.ownerUserId` may approve or reject, and every decision uses `expectedVersion = task.version`. The server remains authoritative even when the UI hides non-owner controls.
- Approved scope is owner-private: assignment mode, applicable Bot, realpath-validated working directory, tools, expiry, and recipients. Other members see only redacted task state.
- Assignment modes are `existing_bot`, `chief_auto`, and `create_bot`. Validate mode-specific fields against the existing Bot adapter and server policy; do not invent new mode semantics.
- Use the existing `cleanWorkDir`/realpath guard. Invalid, missing, root, or disallowed paths fail closed; never fall back to a default directory.
- Use the current owner's published Bot directory for owner selection. Room-visible Bots are not a substitute for the owner's published Bot list.
- Hub never executes commands. Do not add a third runtime/process, rewrite the DSH Agent Loop, substitute an ordinary Agent for a native Bot, or reuse the user's ordinary chat session for task execution.
- Every tool, path, network, process, grant, and artifact operation must be authorized at the execution boundary. Recheck scope and revocation on each operation; fail closed.
- Product-visible plugin behavior requires a REAL-composition test that boots a test-only `cordis.yml` through the actual Loader and app/process path. A hand-built `ctx.plugin(...)` test is insufficient.
- Write a failing test and observe RED before implementation; run the focused GREEN suite after the smallest change. Preserve the test failure's actual cause and output.
- Before changing important source files, create a unique, non-overwriting backup under `Workgroup-AI/backups/`. Existing backups include `backups/w3-owner-ui/{workgroup.js,workgroup-pane.js,workgroup-hub.js,index.js}` and `backups/w3-decision-host/workgroup-hub.js`; do not overwrite them.
- Preserve the current dirty worktree and remain on `main`. Do not reset, clean, stage broadly, or commit unless explicitly requested.
- Do not put credentials or private values in tests, commands, logs, screenshots, or documents. Record configuration key names, presence/absence, or placeholders only.
- S/M evidence cannot substitute for L/N/P. Missing live resources produce `BLOCKED`; an unmet release gate remains `NO-GO`.

---

## Current Checkpoint

These are inherited checkpoint facts, not fresh verification results in this document:

- W1/W2 and W3-T1/W3-T2 were reported complete in the preceding session; verify against the current worktree before proceeding.
- `application/integrations/workgroup/tests/a16-workgroup-interactions.spec.ts` is an existing untracked focused suite. Preserve it and inspect its current diff before editing.
- The last reported run of that suite had 11 tests: 9 passed and 2 expected failures for the missing approval form and assignment selector. It also emitted a non-blocking `vite-tsconfig-paths` deprecation warning. Rerun before treating this as the current RED baseline.
- Current known approval path facts: `approvalScope()` can represent an expiry, but `createApprovalClient().decide()` and Host `hub-approve-task` do not yet propagate it; the UI callback currently forwards only `{ task, decision }`.
- Current known directory fact: `publishedBots({ ownerUserId, query })` calls the owner-scoped `/bots/directory` endpoint.
- Current known realpath fact: `cleanWorkDir` rejects invalid paths and returns no usable directory on failure; the approval flow must stop rather than fall back.

The previous focused command was run from `Workgroup-AI/application`:

```text
"C:/Users/guojl/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe" "C:/Users/guojl/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs" exec vitest run integrations/workgroup/tests/a16-workgroup-interactions.spec.ts
```

If that runner path is unavailable in the new session, use the project-provided Node/pnpm invocation already configured for the workspace; do not run environment inventory commands or install a new package manager.

---

## Execution status (2026-10-17)

Executed by the continuation session in order (Task 1 → 7). The detailed per-task records, commands, counts, and blockers are in `docs/superpowers/plans/2026-10-17-workgroup-w3-w4-execution-evidence.md`; the ledger row is in `TASK_BOARD.md` under "2026-10-17 W3-T3 至 W3-T6 / W4 验证与证据收口".

- **Done with M-level evidence**: owner-only approval form and full scope (including `approvedScope.expiresAt`), the Host consumer that turns `task.approved` into one isolated native Bot Task Session, redacted progress, cancellation (revoke → stop, OS process-tree termination still unconfirmed because no per-task subprocess registry exists in DSH), owner review and controlled sharing, the cancel control and its Host endpoint, task-Session send isolation, and the real Loader composition (test-only `cordis.yml`, real services, real Bot package, `/api/bot` provider path, Bridge-delivered pending-event denial).
- **Final focused gate**: 15 files, 256 tests, exit 0. W1 regression 36/36; W2 regression 87/87. Bundle build exit 0; `client.js` and `lib/client.js` equal at 954937 bytes; `git diff --check` exit 0.
- **Still BLOCKED, so the release decision is NO-GO**: L (real browser UI + independent Hub + owner Host + real model; no `DEEPSEEK_API_KEY` in this session and no browser app run), N (single machine), P (no packaging run), real-browser `conversation` panel observation, OS child-process termination confirmation, and reconciliation for approvals/cancellations missed while the owner Host was offline.
- **Known product gaps recorded, not fixed**: `task.approved` reaches only subscribed rooms (no Hub queue for approved tasks; adding one is a protocol change); `chief_auto` fails closed without a Host Chief decider; failure reasons stay on the owner Host because the progress route publishes only stage/state.


---

## Execution status (2026-10-17, continuation)

Under the follow-up instruction ("execute the remaining items per the plan, except dual-machine; use the historical record for the real-model test"), the remaining in-scope code was completed: per-call revocation-version recheck (`task-grants.recordRevocationVersion`), the `chief_auto` decider (`task-dispatch.askChief` through `ctx.llm`), the task cancel control and `hub-cancel-task`/`cancelTask`, and refusing chat `send` into a task Session. The real-model suite `a19-workgroup-real-model-execution.host.spec.ts` now passes (2/2) with a real Hub process, a real Loader Host composition, and `deepseek-v4.1-flash` through the historical local endpoint; the credential is passed only as `LOCATION_API_KEY` and is never printed. Final focused gate: 16 files, 265 tests, exit 0.

After a further explicit approval, the two protocol items were implemented: Hub `GET /api/v1/tasks/approved` (owner-only approved queue, documented in `server/contracts/openapi.yaml`) plus Host reconciliation on sign-in/resume/open-room and a 60-second timer, and a validated failure-category `reason` on the progress route that reaches the room task list and UI (free-form text is refused). The focused gate is now 16 files / 270 tests, exit 0; the bundle is 958890 bytes. Still open, and why: OS process-tree termination (no per-task subprocess registry or lifecycle event in DSH; `cancellation.mjs` remains test-only, and no DSH core change was made); real-browser UI L, N, P (not run). Release remains **NO-GO**.

### Task 1: Reconcile the checkpoint and establish W3-T3 RED

**Files:**
- Read-only: `docs/superpowers/plans/2026-10-16-workgroup-approval-native-execution-implementation-plan.md`
- Read-only: current diffs for the W3 paths listed in Tasks 2-4
- Existing test: `application/integrations/workgroup/tests/a16-workgroup-interactions.spec.ts`
- Test: `application/integrations/workgroup/tests/a06-approvals.spec.ts`, `application/integrations/workgroup/tests/q02-security.spec.ts`

**Interfaces:**
- Consumes: current task state, `task.version`, `approvalScope()`, existing owner-scoped directory and folder helpers.
- Produces: a recorded baseline that distinguishes already-implemented behavior from W3-T3 gaps, without changing source.

- [x] **Step 1: Inspect the existing worktree and relevant diffs**

  Confirm the branch is still `main`, preserve every pre-existing dirty/untracked file, and inspect only the W1/W2/W3 paths and tests relevant to this plan. Do not stage or rewrite the existing `a16` suite.

- [x] **Step 2: Reconcile completed tasks**

  For W1, W2, W3-T1, and W3-T2, record the exact source/test evidence already present. If the checkpoint claim cannot be supported, mark that item `UNVERIFIED` and run only its existing focused test; do not silently call it complete or redo unrelated work.

- [x] **Step 3: Rerun the approval interaction suite**

  From `Workgroup-AI/application`, run:

  ```text
  pnpm exec vitest run integrations/workgroup/tests/a16-workgroup-interactions.spec.ts
  ```

  Expected baseline from the prior session: 9 passed, 2 failed because the approval form and assignment selector are absent. Treat a different result as the new baseline and investigate it before editing.

- [x] **Step 4: Confirm the decision route contract before changing expiry propagation**

  Read the actual decision schema and mapping in `server/src/api/tasks.js` and its directly used task store. Confirm how `approvedScope.expiresAt` is derived and validated. Keep the current server contract if it represents the required expiry. Do not add a route, database field, or server schema change to hide an application adapter mismatch; stop for approval if the contract cannot represent the requested scope.

---

### Task 2: Complete the owner-only approval form and full scope propagation

**Files:**
- Backup before editing: `application/packages/bundle/ds-bot/src/client/workgroup.js`, `workgroup-pane.js`, `workgroup-hub.js`, `application/packages/bundle/ds-bot/src/host/workgroup-hub.js`
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup.js`
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup-pane.js`
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup-hub.js`
- Modify: `application/packages/bundle/ds-bot/src/host/workgroup-hub.js`
- Modify: `application/integrations/workgroup/client/approvals.mjs`
- Reuse: `application/integrations/workgroup/client/index.mjs`, `application/packages/bundle/ds-bot/src/client/folder-menu.js`, `application/packages/bundle/ds-bot/src/host/folders.js`, `application/packages/bundle/ds-bot/src/client/i18n.js`
- Test: `application/integrations/workgroup/tests/a16-workgroup-interactions.spec.ts`, `a06-approvals.spec.ts`, `q02-security.spec.ts`

**Interfaces:**
- Consumes: `WorkgroupTasks({ tasks, selfUserId, onDecision })`, `WorkgroupView({ identity, actions, run })`, `publishedBots({ ownerUserId, query })`, `FolderMenu({ value, actions, run, onPick })`, and `cleanWorkDir`.
- Produces: a complete owner-only decision payload with mode, target Bot, validated work directory, tools, expiry, recipients, decision, and `expectedVersion`; non-owners receive only redacted task state.

- [x] **Step 1: Expand failing tests before implementation**

  In the existing interaction/approval suites, assert:

  - An owner sees the approval form; requester, room admin, and ordinary member do not receive an actionable approval callback.
  - The form requires a valid mode, mode-appropriate Bot selection, validated work directory, non-empty permitted tools, valid expiry, explicit recipients, and the current `expectedVersion`.
  - Missing or invalid scope makes no Hub request.
  - The decision chain preserves the scope and expiry from UI callback through Browser provider, Host endpoint, `createApprovalClient().decide()`, and the existing `/tasks/:taskId/decision` request body.
  - Owner Bot choices use `publishedBots({ ownerUserId })`, not the mixed room directory.
  - The public task projection and events do not contain the owner's private path, tool parameters, machine fields, grant data, or credentials.

- [x] **Step 2: Run the focused RED suite**

  ```text
  pnpm exec vitest run integrations/workgroup/tests/a16-workgroup-interactions.spec.ts integrations/workgroup/tests/a06-approvals.spec.ts integrations/workgroup/tests/q02-security.spec.ts
  ```

  Expected: the form/selector and missing expiry forwarding assertions fail before implementation. Record actual failures; do not infer RED from a missing import or broken fixture.

- [x] **Step 3: Implement only the form and adapter propagation**

  Add the owner-only mode/scope form in `workgroup.js` and pass its values through `workgroup-pane.js` and `workgroup-hub.js`. Use the existing owner Bot directory, `FolderMenu`, `cleanWorkDir`, and tool policy. If directory validation fails or yields no approved path, disable/deny approval; do not select a default directory. Add locale text in `i18n.js`, not hard-coded UI strings.

  Forward expiry through each adapter boundary. Serialize it using the actual server-supported contract confirmed in Task 1, which currently documents `approvedScope.expiresAt`. Do not create a parallel expiry field or change the server contract without a separately approved plan adjustment.

- [x] **Step 4: Run the focused GREEN suite**

  ```text
  pnpm exec vitest run integrations/workgroup/tests/a16-workgroup-interactions.spec.ts integrations/workgroup/tests/a06-approvals.spec.ts integrations/workgroup/tests/q02-security.spec.ts
  ```

  Expected: all assertions pass; no request is sent for incomplete scope; server remains the authority for authorization and version checks.

- [x] **Step 5: Review the approval boundary**

  Check only the changed approval files and direct dependencies. Confirm no private scope enters non-owner responses/events, and that localized labels fit the existing UI. Record unresolved server-contract mismatches instead of bypassing them.

---

### Task 3: Connect approved tasks to the owner's native Bot Task Session

**Files:**
- Backup before editing: `application/packages/bundle/ds-bot/src/host/channel.js`, `task-sessions.js`, `task-grants.js`, `workgroup-hub.js`
- Modify: `application/packages/bundle/ds-bot/src/host/workgroup-hub.js`
- Modify: `application/packages/bundle/ds-bot/src/host/channel.js`
- Modify: `application/packages/bundle/ds-bot/src/host/task-sessions.js`
- Modify: `application/packages/bundle/ds-bot/src/host/task-grants.js`
- Modify only as required: `application/integrations/workgroup/policy/dispatch.mjs`, `application/integrations/workgroup/bot-adapter/flows.mjs`
- Test: `application/integrations/workgroup/tests/a07-dispatch.spec.ts`, `a08-flows.spec.ts`, `q02-security.spec.ts`, `q03-recovery.spec.ts`
- REAL-composition test: create `application/integrations/workgroup/tests/a17-workgroup-loader-composition.spec.ts` if no existing actual-Loader test can be reused

**Interfaces:**
- Consumes: owner-scoped approved task detail/event, `acceptDispatch` or its existing policy entry, grant consume/revoke, `runDispatch`, and the native Bot Task Session factory.
- Produces: a single isolated, cancellable native Bot Task Session on the matching owner Host, with persistent task/owner/Bot binding and per-operation authorization.

- [x] **Step 1: Write execution-chain and denial tests**

  Use existing policy/flow helpers and a controlled native Bot test double. Assert that `PENDING_APPROVAL`, rejected, stale-version, wrong-owner, wrong-Bot, expired, revoked, and replayed tasks cannot start or continue execution. Assert that a valid decision starts exactly one isolated Task Session, never reuses the user's ordinary conversation session, and cannot be started by a room admin or requester.

- [x] **Step 2: Add the production-composition test**

  Boot a test-only `cordis.yml` through the actual DSH Loader and application/process composition. Verify the real Bot package loads, registers its existing `conversation` panel, and reaches the Host/provider workgroup path. Exercise at least one approved-event handoff and one denied pre-approval path. Follow the actual Loader API found in the direct runtime dependency; do not replace it with a hand-built `ctx.plugin(...)` test. Keep test configuration and identities synthetic and keyless.

  The current focused test directory has no matching Loader/`cordis.yml` composition spec. Before creating `a17-workgroup-loader-composition.spec.ts`, inspect only the directly relevant application test harness and Loader entrypoint. If the real application/process cannot be booted in the available test environment, mark this coverage `BLOCKED`; do not downgrade it to a mocked plugin test.

- [x] **Step 3: Run execution tests to verify RED**

  ```text
  pnpm exec vitest run integrations/workgroup/tests/a07-dispatch.spec.ts integrations/workgroup/tests/a08-flows.spec.ts integrations/workgroup/tests/q02-security.spec.ts integrations/workgroup/tests/q03-recovery.spec.ts
  ```

  Expected: assertions fail for the missing approved-task production consumer or missing isolated session/grant binding. Preserve any unrelated pre-existing failures separately.

- [ ] **Step 4: Trace the owner Host path and implement one consumer** — partially done: the consumer, realpath/root, tool allowlist, and network default-deny are in place; **process-tree termination is BLOCKED** on a missing DSH subprocess capability (see the evidence file §5)

  Trace the event from Host Bridge to owner-scoped task fetch, owner/task/version/scope revalidation, grant consume, dispatch policy, Bot mode selection, and native Task Session creation. Treat an event as a notification, not as authority for private task fields. Use persistent identity binding and object-level authorization; a process-local map alone is not an authoritative owner/task binding.

  Implement the smallest consumer that enters the existing dispatch flow. Every task must bind to owner, task, target Bot, approved scope, expiry, nonce, and revocation version. Recheck the grant and policy on each tool call/retry. Apply realpath/root, tool allowlist, network default-deny, and process controls at the execution boundary. A failed policy check rejects execution; it never falls back to another Bot, model, session, or working directory.

- [x] **Step 5: Run execution tests to verify GREEN**

  ```text
  pnpm exec vitest run integrations/workgroup/tests/a07-dispatch.spec.ts integrations/workgroup/tests/a08-flows.spec.ts integrations/workgroup/tests/q02-security.spec.ts integrations/workgroup/tests/q03-recovery.spec.ts integrations/workgroup/tests/a17-workgroup-loader-composition.spec.ts
  ```

  Expected: all runnable tests pass; if the real Loader/app composition is unavailable, its status remains explicitly `BLOCKED` and no full production-path claim is made.

- [x] **Step 6: Review only the execution boundary**

  Review changed Host/dispatch/grant/session code and direct dependencies. Confirm there is no Hub-side execution, ordinary-Agent substitution, cross-user session reuse, authorization based only on an event payload, or unguarded tool path.

---

### Task 4: Complete redacted progress, cancellation, result review, and controlled sharing

**Files:**
- Modify: `application/packages/bundle/ds-bot/src/host/channel.js`, `task-sessions.js`, `workgroup-hub.js`
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup.js`, `workgroup-pane.js`, `i18n.js`
- Modify: `application/integrations/workgroup/client/approvals.mjs` only if an existing review/cancel adapter is incomplete
- Reuse: existing Hub progress/cancel/review/share endpoints and artifact ACL
- Test: `application/integrations/workgroup/tests/a09-review.spec.ts`, `q02-security.spec.ts`, `q03-recovery.spec.ts`, plus relevant existing process/egress tests when the corresponding boundary changes

**Interfaces:**
- Consumes: Task Session progress/cancellation signal, grant revoke, redacted Hub task projection, review decision, artifact ACL, explicit recipient IDs.
- Produces: allowlisted public progress, truthful cancellation state, owner-only review, and artifact references shared only to authorized recipients.

- [x] **Step 1: Write privacy, cancellation, and share tests**

  Assert that progress/events exclude absolute paths, raw tool arguments/logs, credentials, private file contents, storage keys, and unrelated room/task data. Assert cancellation revokes the grant before signaling the session; subsequent tool calls/retries are denied. Assert child-process termination is reported as unconfirmed unless termination is observed. Assert `keep` and `reject` publish no artifact and `share` requires explicit recipients who still pass membership and artifact ACL checks.

- [x] **Step 2: Run focused RED**

  ```text
  pnpm exec vitest run integrations/workgroup/tests/a09-review.spec.ts integrations/workgroup/tests/q02-security.spec.ts integrations/workgroup/tests/q03-recovery.spec.ts
  ```

  Expected: missing propagation, redaction, revoke ordering, or recipient checks fail for their actual behavioral reason.

- [x] **Step 3: Implement progress/cancel/review adapters**

  Publish only allowlisted state, stage, and safe error category. Cancellation order is: authorize cancel, revoke grants, deliver the cancellation signal, stop the Task Session/process tree, then report the observed result. If termination cannot be confirmed, preserve an explicit unconfirmed state. Keep review owner-only; share only approved artifact references after current membership and ACL validation.

- [x] **Step 4: Run focused GREEN**

  ```text
  pnpm exec vitest run integrations/workgroup/tests/a09-review.spec.ts integrations/workgroup/tests/q02-security.spec.ts integrations/workgroup/tests/q03-recovery.spec.ts
  ```

  Expected: all focused assertions pass, with no public event containing private scope or raw execution data.

- [x] **Step 5: Check the owner and recipient projections**

  Verify that owner UI receives its private review controls while other members see only the redacted state; reject stale task versions and recipients removed before publication.

---

### Task 5: Run the W3 focused gate and make an evidence-based execution decision

**Files:**
- Test scope: W3 paths and focused tests from Tasks 2-4
- Generated artifacts only after source/test gates: `application/packages/bundle/ds-bot/client.js`, `application/packages/bundle/ds-bot/lib/client.js`
- Evidence: one record per W3 task using the template in Task 7

- [x] **Step 1: Run the W3 focused suite**

  From `Workgroup-AI/application`:

  ```text
  pnpm exec vitest run integrations/workgroup/tests/a02-workgroup-view.spec.ts integrations/workgroup/tests/a06-approvals.spec.ts integrations/workgroup/tests/a07-dispatch.spec.ts integrations/workgroup/tests/a08-flows.spec.ts integrations/workgroup/tests/a09-review.spec.ts integrations/workgroup/tests/q02-security.spec.ts integrations/workgroup/tests/q03-recovery.spec.ts integrations/workgroup/tests/a16-workgroup-interactions.spec.ts integrations/workgroup/tests/a17-workgroup-loader-composition.spec.ts
  ```

  Record the real exit code, passed/failed counts, warnings, fixture errors, and any blocked composition case.

- [x] **Step 2: Prove mention has no pre-approval side effect**

  With the server/Host test harness, post a message containing a remote Bot mention. Assert task state is exactly `PENDING_APPROVAL` and that no grant consume, Task Session creation, dispatch, or tool invocation occurs before the owner's decision.

- [x] **Step 3: Prove server-side non-owner rejection**

  Attempt a decision as requester, room admin, and ordinary member using the current route and a current `expectedVersion`. Assert the server rejects each request even though the UI also hides its controls.

- [x] **Step 4: Record execution blockers honestly**

  If the owner Host, real model endpoint, approved working directory, or real Loader/app test is unavailable, record the specific W3 item as `BLOCKED` or `NO-GO`. Mocks and helper tests do not establish L-level execution.

- [x] **Step 5: Review the W3 exit criteria**

  Do not advance to a W3 `PASS` unless owner-only scope, grant lifecycle, native isolated session, per-operation policy checks, privacy, cancellation, review, and share ACLs each have focused evidence. Any unexplained failure returns to root-cause investigation.

---

### Task 6: Perform W4 focused validation, bundle verification, and evidence closeout

**Files:**
- Read-only first: `application/package.json`, `application/packages/bundle/ds-bot/package.json` if present, current diffs and existing gate scripts
- Generated: `application/packages/bundle/ds-bot/client.js`, `application/packages/bundle/ds-bot/lib/client.js`
- Update only after evidence exists: `Workgroup-AI/TASK_BOARD.md`, `REQUIREMENTS_GAP_FILL.md`, `TECH_DESIGN_GAP_FILL.md`, and directly affected README/JSDoc/locale/task-gap documentation
- Evidence: W1-W4 task records and a keyless configuration snapshot (names/presence only)

- [x] **Step 1: Rerun W1/W2 regression gates**

  From `Workgroup-AI/application`:

  ```text
  pnpm exec vitest run integrations/workgroup/tests/a11-hub-provider.spec.ts integrations/workgroup/tests/a02-workgroup-view.spec.ts integrations/workgroup/tests/bot-entry.spec.ts
  pnpm exec vitest run integrations/workgroup/tests/a05-workgroup.spec.ts integrations/workgroup/tests/a09-review.spec.ts integrations/workgroup/tests/q02-security.spec.ts integrations/workgroup/tests/q03-recovery.spec.ts
  ```

  These runs establish current M-level regression evidence only; they do not replace L/N/P.

- [x] **Step 2: Perform the bounded S-level contract review**

  Inspect only changed paths and direct dependencies. Verify the `conversation` panel remains order `1`, local group state/actions remain separate, workgroup sessions remain `wg:<roomId>`, Browser/Host/integration fields align, the decision route matches the server, and credentials/private scope do not enter Browser responses or public events.

- [x] **Step 3: Build using the existing package script**

  Inspect package scripts and the current generated-file diffs first. Use the repository's defined bundle/client generation command; do not invent a script or manually edit generated output. Preserve pre-existing generated changes and stop if a build would overwrite unrelated user work.

- [x] **Step 4: Compare generated artifacts byte-for-byte**

  From `Workgroup-AI/application`, use the established repository command if available. Otherwise:

  ```text
  python -c "from pathlib import Path; a=Path('packages/bundle/ds-bot/client.js').read_bytes(); b=Path('packages/bundle/ds-bot/lib/client.js').read_bytes(); print('equal=', a == b, 'bytes=', len(a), len(b)); raise SystemExit(0 if a == b else 1)"
  ```

  Expected: `equal= True` and exit code 0. Record exact byte counts. A mismatch blocks W4 closeout until explained.

- [x] **Step 5: Run the REAL product composition gate**

  Run the test-only `cordis.yml` through the actual Loader/app process test from Task 3. Confirm the real plugin entry, provider/Host path, owner-only denial, and pre-approval no-execution behavior. If the real process cannot start in this environment, record `BLOCKED`; do not substitute a hand-built plugin or component test.

- [x] **Step 6: Run live evidence levels only when prerequisites exist**

  For L, require an independent Hub, the project Host, a real browser, an owner Host, and the actual model endpoint. Record the complete single-machine flow and negative authorization cases. For N, require two independent clients and a real Hub. For P, record only platforms actually built and run. Missing any prerequisite remains `BLOCKED`; do not infer a pass from S/M.

- [x] **Step 7: Update status documents without erasing history**

  After saving the actual outputs, update only the affected rows in `TASK_BOARD.md`, `REQUIREMENTS_GAP_FILL.md`, and `TECH_DESIGN_GAP_FILL.md`. Correct stale descriptions only where current source/evidence proves the correction. Preserve failures, blocked items, deferred items, and evidence level. Do not copy private values from older documents; use configuration key names and placeholders only. Update README/JSDoc/locales only where the delivered behavior or interface actually changed.

- [x] **Step 8: Run final focused checks and bounded review**

  Rerun the exact tests supporting each final claim, run `git diff --check` on changed files only, and perform a read-only review limited to this delivery and direct dependencies. Record findings and fix only in-scope issues; rerun affected tests after any fix.

---

### Task 7: Close W1-W4 evidence and publish the final decision

**Files:**
- Evidence/documents: the current W1-W4 plans, `TASK_BOARD.md`, `REQUIREMENTS_GAP_FILL.md`, `TECH_DESIGN_GAP_FILL.md`, and the actual test/build outputs
- No source modifications unless a prior task fails and returns to its owning plan

- [x] **Step 1: Record every task with the required evidence fields**

  Use this exact format for each completed, blocked, or failed item:

  ```text
  任务ID → 涉及路径 → 前置条件 → 修改摘要 → 实际测试命令 → 结果与证据 → 未解决风险
  ```

- [x] **Step 2: Reconcile plan status**

  Mark a checkbox complete only when the implementation and its stated test evidence are present. Keep the inherited W1/W2/W3-T1/T2 claims separate from results freshly rerun in this session. Never turn `BLOCKED`, `NO-GO`, a test failure, or an unconfirmed process termination into `PASS`.

- [x] **Step 3: State the release decision**

  Report `GO` only if the approved acceptance criteria and required evidence levels all pass. Otherwise report `NO-GO`, enumerate each blocker and its evidence level, and state which resources or follow-up work are needed. Do not claim multi-machine behavior, real-model execution, or platform packaging without corresponding current evidence.

- [x] **Step 4: Preserve the worktree boundary**

  Leave pre-existing dirty changes intact. Do not commit, reset, clean, or broaden file scope unless the user separately authorizes it.

---

## Related Documents

### Current W1-W4 requirement and design baseline

- `docs/superpowers/specs/2026-10-16-workgroup-bot-gaps-index.md` — canonical requirement decomposition index and W1-W4 map.
- `docs/superpowers/specs/2026-10-16-bot-entry-hub-provider-spec.md` — W1 entry, provider, identity, and admission requirements.
- `docs/superpowers/specs/2026-10-16-workgroup-collaboration-realtime-spec.md` — W2 messages, attachments, membership, events, presence, and recovery.
- `docs/superpowers/specs/2026-10-16-workgroup-approval-native-execution-spec.md` — W3 owner approval, scope, native execution, cancellation, review, and sharing requirements.
- `docs/superpowers/specs/2026-10-16-workgroup-verification-evidence-matrix.md` — S/M/L/N/P definitions and release evidence gates.

### Current W1-W4 implementation plan set

- `docs/superpowers/plans/2026-10-16-workgroup-bot-execution-plan-index.md` — plan order and cross-plan gates.
- `docs/superpowers/plans/2026-10-16-workgroup-bot-entry-hub-provider-implementation-plan.md` — W1 plan.
- `docs/superpowers/plans/2026-10-16-workgroup-collaboration-realtime-implementation-plan.md` — W2 plan.
- `docs/superpowers/plans/2026-10-16-workgroup-approval-native-execution-implementation-plan.md` — approved W3 plan and source of its original task details.
- `docs/superpowers/plans/2026-10-16-workgroup-verification-evidence-implementation-plan.md` — W4 plan.
- `docs/superpowers/plans/2026-10-16-workgroup-approval-native-execution-remaining-implementation-plan.md` — this continuation plan for the remaining work.

### Project acceptance and status documents used by W4

- `TASK_BOARD.md` — task status and evidence ledger.
- `REQUIREMENTS_GAP_FILL.md` — business requirement gaps and acceptance history.
- `TECH_DESIGN_GAP_FILL.md` — implementation design and system facts.
- `ACCEPTANCE.md` — evidence-level definitions and acceptance rules.
- `技术实施任务书.docx` — upstream implementation task brief.

### Related historical plan

- `docs/plans/2026-10-16-workgroup-bot-entry-gaps-implementation-plan.md` — earlier broad plan. Its header says “待用户审批”; do not treat it as the authority for this already-approved W1-W4 execution unless the user explicitly reactivates it. The current authority is the approved superpowers plan index and its W1-W4 plans.

The `docs/superpowers/plans/2026-10-15-m1-evidence.md`, `2026-10-15-v1-gap-fill.md`, and `2026-10-16-m3-m4-m5.md` files are historical phase artifacts, not part of the current linked W1-W4 plan set. Consult them only if a direct dependency or conflict is found; do not reopen their unrelated scope.

---

## New-Session Handoff

Start from the current `main` worktree and preserve all existing dirty and untracked changes. Read this plan and the linked W3 spec/plan, use `executing-plans`, reconcile the checkpoint before coding, and execute Tasks 1-7 in order. Work only on W3-T3 through W4; do not redo verified earlier tasks, do not commit, and keep unsupported L/N/P claims `BLOCKED` or `NO-GO`.

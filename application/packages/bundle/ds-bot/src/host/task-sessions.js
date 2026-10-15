// Task Sessions: an isolated Session that speaks for one existing Bot on behalf of one
// approved cross-user task.
//
// Why this module exists. DS Bot has three kinds of Session, all of them the user's:
// a Bot's own chat, a Bot's Session inside a group, and archived earlier segments of
// either. None of them is suitable for work another person asked for, because:
//
//   * A task must not read or extend the owner's private conversation with that Bot. The
//     owner agreed to a specific piece of work, not to opening their chat history to it.
//   * A task must not appear in the group's message stream as if the Bot had spoken there.
//   * A task's permissions, working folder, and lifetime come from the approval, not from
//     whatever the Bot's chat happens to be set to.
//
// So a task gets a Session of its own, created the same way the Bot's own Session is created
// — same preset, same model, same instructions, same tools — which is what makes it *the
// Bot* speaking rather than an ordinary agent wearing the Bot's name. What differs is only
// the lifecycle: it is created for one task, bound to that task's approval, and released when
// the task ends.
//
// Identity survives a rebuild because the binding is written into the team file rather than
// kept in memory. `indexTaskSessions()` rebuilds the index from that file on every load, so a
// refresh, a restart, or a crash leaves every task pointing at the same Bot it started with.
// The in-memory map is a cache over that record, never the record itself.

/** Task Sessions are remembered per task id, and never reused for a second task. */
const TASK_SESSION_VERSION = 1

export function install(rt) {
  const { ctx, state } = rt

  // `state.taskSessions` is the durable record: taskId -> binding. A file written before this
  // module existed has none, so the shape is created on demand and saved with the team.
  if (state.taskSessions === undefined) state.taskSessions = {}
  if (state.taskSessionVersion === undefined) state.taskSessionVersion = TASK_SESSION_VERSION

  /** @type {Map<string, object>} taskId -> binding, rebuilt from `state` on every load. */
  const byTask = new Map()
  /** @type {Map<string, string>} sessionId -> taskId, for the reverse lookup Session hooks need. */
  const bySession = new Map()

  const rebuildIndex = () => {
    byTask.clear()
    bySession.clear()
    for (const [taskId, binding] of Object.entries(state.taskSessions ?? {})) {
      byTask.set(taskId, binding)
      if (typeof binding.sessionId === 'string') bySession.set(binding.sessionId, taskId)
    }
    // The agents module owns the DSH Agent session index and installs after this module.
    rt.indexAgents?.()
  }

  /**
   * A task Session's identity, or undefined for a Session that is not one.
   *
   * Session hooks ask this to decide whether they are looking at task work. Answering from the
   * rebuilt index — not from a map that only the creating process filled in — is what makes the
   * answer survive a reload.
   */
  const taskSessionOf = sessionId => {
    if (sessionId === undefined) return undefined
    const taskId = bySession.get(sessionId)
    return taskId === undefined ? undefined : byTask.get(taskId)
  }

  const isTaskSession = sessionId => bySession.has(sessionId)

  const taskBinding = taskId => byTask.get(taskId)

  /**
   * The agent preset a Bot's Session is made with.
   *
   * The same choice the roster makes for a Bot's own Session: `standard` where the composition
   * offers it, because under the `ptc` preset a model may call only `run_code`, which turns down
   * the relay and question tools a team Session is given. A Session keeps the preset it is made
   * with, so this has to match at creation time.
   */
  async function standardPreset() {
    const presets = ctx.get?.('agentPresets')
    if (presets === undefined) return {}
    const list = await presets.list()
    const standard = list.some(preset => preset.id === 'standard' && preset.broken === undefined)
    return standard ? { agentPreset: 'standard' } : {}
  }

  /**
   * Create the isolated Session for one task.
   *
   * The Bot must already exist: a task names a Bot the owner published, and inventing a Bot for
   * a task would mean the approval was given for something that did not exist.
   *
   * `workDir` is optional. When the approval named one, it must be a usable folder; an unusable
   * one is refused rather than substituted, because a task that silently ran in the team
   * workspace would read files the owner never approved.
   *
   * @param {{ taskId: string, botId: string, workDir?: string, title?: string }} options
   */
  async function openTaskSession({ taskId, botId, workDir, title }) {
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw new Error(readOnly)
    if (typeof taskId !== 'string' || taskId.length === 0) throw new Error('ds-bot: a task Session needs a task id')
    const bot = rt.botOf(botId)
    if (bot === undefined) throw new Error(`ds-bot: no Bot ${botId} to run this task`)

    const existing = byTask.get(taskId)
    if (existing !== undefined) {
      // A retry after a lost response must reuse the Session rather than start a second one:
      // two Sessions for one task would double its memory and could double its side effects.
      if (existing.botId !== botId) {
        throw new Error(`ds-bot: task ${taskId} is already bound to Bot ${existing.botId}`)
      }
      return existing
    }

    let place
    if (workDir !== undefined) {
      const usable = await rt.isFolder(workDir)
      if (!usable) {
        // F-12: refuse, never fall back. A silent substitution would put approved-for-a-folder
        // work into the team workspace, which the owner did not agree to.
        throw new Error(`ds-bot: the approved folder ${workDir} is not a usable directory, so this task will not start`)
      }
      place = { cwd: workDir }
    } else {
      place = { workspaceId: await rt.ensureWorkspace() }
    }

    const { sessionId } = await ctx.sessionController.create({ ...place, ...await standardPreset() })
    const agent = await rt.resolveAgent(sessionId)
    // The title is what the owner sees in the session list, so it names the task rather than
    // claiming the Bot's own chat.
    await ctx.sessionTitle.rename(agent.session, title ?? `Task ${taskId.slice(0, 8)} · ${bot.name}`)

    const binding = {
      taskId,
      botId,
      sessionId,
      workDir: workDir ?? null,
      openedAt: Date.now(),
      closedAt: null,
    }
    return binding
  }

  /**
   * Write a binding into the team file and the index.
   *
   * Separate from `openTaskSession` so the durable write happens once, after the Session
   * exists, and so a failure to write cannot leave a Session the team file does not know about.
   */
  async function rememberTaskSession(binding) {
    state.taskSessions[binding.taskId] = binding
    await rt.save()
    rebuildIndex()
    return binding
  }

  /**
   * Release a task Session.
   *
   * The Session is archived rather than deleted: the owner may still need to read what a task
   * did, and DS Bot's archive keeps a Session readable while stopping its work. The binding
   * stays in the team file with `closedAt` set, so a later lookup still answers "this task ran
   * as that Bot" instead of forgetting the task ever existed.
   */
  async function closeTaskSession(taskId) {
    const binding = byTask.get(taskId)
    if (binding === undefined) return undefined
    if (binding.closedAt !== null) return binding
    binding.closedAt = Date.now()
    state.taskSessions[taskId] = binding
    await rt.save()
    await ctx.workspaceRegistry.archiveSession(binding.sessionId, { stopActivity: true }).catch(() => {})
    rebuildIndex()
    return binding
  }

  // Rebuild once at install, so a Session hook that runs before the first load still gets the
  // right answer for a Session the team file already records.
  rebuildIndex()

  Object.assign(rt, {
    openTaskSession, rememberTaskSession, closeTaskSession,
    taskSessionOf, isTaskSession, taskBinding, indexTaskSessions: rebuildIndex,
  })
}

export const taskSessionInternals = { TASK_SESSION_VERSION }

// The workgroup surface, and the identity rules the rest of the team shares.
//
// The interface itself lives in `./workgroup-ui`: it is a copy of the original group chat's message,
// composer, settings, details, and task-activity surfaces, evolved separately. This module stays as
// the stable entry the pane and the team's own code import — one place that answers "what is a
// workgroup", "what is a member called", and "which view renders a `wg:` Session" — so a later
// change inside the copied interface does not ripple through every caller.
//
// The Hub is the authority for every fact rendered here. Nothing in this layer guesses from a name,
// a member count, or local roster state, and there is deliberately no code path from an inbound frame
// to an execution: the one component that acts on a task is the Host adapter, behind the local
// policy check.

import { createElement as h } from 'react'
import { t } from './i18n.js'
import { presenceOf } from './workgroup-presence.js'
import { memberSummary } from './workgroup-ui/model.js'

export { WORKGROUP_KIND, ORDINARY_KIND, isWorkgroup, memberSummary, unreadCount, newWorkgroupName, workgroupSubtitle } from './workgroup-ui/model.js'
export { WorkgroupThread } from './workgroup-ui/thread.js'
export { WorkgroupTasks } from './workgroup-ui/activity.js'
export { WorkgroupConversation as WorkgroupView } from './workgroup-ui/index.js'
export { WorkgroupDetails, WorkgroupSettingsForm, WorkgroupComposer } from './workgroup-ui/index.js'
export { workgroupSessionId, roomIdOfSession, isWorkgroupSession } from '../shared/workgroup-session.js'

/**
 * The workgroup's member list, in the original group chat's pill language.
 *
 * Humans first: a workgroup's point is that a colleague is on the other end, and putting Bots at the
 * top would bury them. Bots keep their owner's name attached, because a Bot acts for someone and the
 * list must not suggest otherwise. Only a human carries the presence dot; a Bot's own `state` is a
 * different fact, and marking a Bot "offline" beside a colleague's dot would misread both.
 */
export function WorkgroupMembers({ members, bots, onOpenBot }) {
  const humans = (members ?? []).map(member => h('div', {
    key: member.userId,
    className: `bt-wg-member bt-wg-member-${presenceOf(member)}`,
    'data-wg-member': member.userId,
    'data-wg-presence': presenceOf(member),
  },
  h('span', { className: 'bt-wg-member-dot', 'aria-hidden': 'true' }),
  h('span', { className: 'bt-wg-member-name' }, memberSummary(member))))
  const machines = (bots ?? []).map(bot => h('div', {
    key: `${bot.ownerUserId}:${bot.botId}`,
    className: 'bt-wg-member bt-wg-member-bot',
    'data-wg-bot': bot.botId,
  },
  h('button', { type: 'button', className: 'bt-wg-member-name', onClick: () => onOpenBot?.(bot) },
    bot.displayName ?? bot.botId),
  h('span', { className: 'bt-wg-member-owner' }, t('for {name}', { name: bot.ownerDisplayName ?? bot.ownerUserId }))))
  return h('div', { className: 'bt-wg-members', 'data-wg-members': String((members ?? []).length) }, ...humans, ...machines)
}

// Workgroup settings: the copied group-settings surface, with the workgroup's own semantics.
//
// The structure is the original group form's — a hero with the group's face, then Profile, Members,
// Sidebar, and Manage cards — because the requirement is that a member manages a workgroup in the
// interface they already know. What differs is stated rather than hidden:
//
//  * the original "who answers", "working folder", and shared "permissions" are local-execution
//    settings; a workgroup cannot share an execution scope across people, so the card explains that
//    a Bot's folder, tools, and lifetime are chosen by its owner when approving a task;
//  * members are humans, invited by id and joining only after accepting; Bots are explicit members
//    with an owner, added directly when they are your own and by invitation otherwise;
//  * the ending is "dissolve": history stays readable, and only the owner (or the Hub operator) can
//    do it.
//
// The Hub re-checks every action. This form decides what a viewer is offered.

import { createElement as h, useEffect, useState } from 'react'
import { Card, Row, SwitchRow } from '../bot-settings.js'
import { ChevronRightIcon } from '../icons.js'
import { BotAvatar, RoomAvatar } from '../mark.js'
import { t } from '../i18n.js'

const roleLabel = role => t(role === 'owner' ? 'Owner' : role === 'admin' ? 'Admin' : 'Member')

function Hero({ room, members }) {
  const humans = (members ?? []).length
  return h('div', { className: 'bt-bs-hero' },
    h(RoomAvatar, { room: { ...room, members: (members ?? []).map(member => member.userId) }, roster: { byId: {}, bots: [] }, size: 64 }),
    h('div', { className: 'bt-bs-who' },
      h('span', { className: 'bt-bs-name' }, room.name),
      h('span', { className: 'bt-bs-sub' }, t('Workgroup · {count} members', { count: humans }))))
}

function MemberRow({ member, manage, selfUserId, busy, act, onAction }) {
  const removable = manage && member.role !== 'owner' && member.userId !== selfUserId
  return h('div', { className: 'bt-set-row bt-bs-row bt-gs-member' },
    h('span', { className: 'bt-gs-who' },
      h('span', { className: 'bt-human-face bt-human-face-sm', 'aria-hidden': true }, [...String(member.displayName ?? member.userId ?? '?')][0].toUpperCase()),
      h('span', { className: 'bt-row-title' }, member.displayName ?? member.userHandle ?? member.userId),
      member.role === 'owner' ? h('span', { className: 'bt-tag' }, t('Owner')) : null),
    removable
      ? h('select', {
        'data-wg-role': member.userId,
        'aria-label': t('Role for {name}', { name: member.displayName ?? member.userId }),
        value: member.role,
        disabled: busy,
        onChange: event => { void act(() => onAction('setRole', { userId: member.userId, role: event.target.value })) },
      },
      h('option', { value: 'member' }, t('Member')),
      h('option', { value: 'admin' }, t('Admin')))
      : h('span', { className: 'bt-tag' }, roleLabel(member.role)),
    removable
      ? h('button', {
        type: 'button', className: 'bt-soft', disabled: busy, 'data-wg-remove': member.userId,
        onClick: () => act(() => onAction('removeMember', { userId: member.userId })),
      }, t('Remove'))
      : null)
}

function BotRow({ bot, selfUserId, manage, busy, act, onAction, visibility, onVisibility }) {
  const removable = manage || bot.ownerUserId === selfUserId
  return h('div', { className: 'bt-set-row bt-bs-row bt-gs-member' },
    h('span', { className: 'bt-gs-who' },
      h(BotAvatar, {
        bot: { id: `${bot.ownerUserId}:${bot.botId}`, name: bot.displayName ?? bot.botId, look: { shape: 'circle', color: 'blue' } },
        size: 26,
        live: false,
      }),
      h('span', { className: 'bt-row-title' }, bot.displayName ?? bot.botId),
      h('span', { className: 'bt-tag' }, t('Bot of {owner}', { owner: bot.ownerDisplayName ?? bot.ownerUserId }))),
    // Only the owner decides who may discover their Bot. A room administrator can remove it from the
    // room, but cannot widen the directory entry on someone else's behalf.
    bot.ownerUserId === selfUserId
      ? h('label', { className: 'bt-wg-visibility', title: t('Visible to members') },
        h('input', {
          type: 'checkbox', 'data-wg-bot-visibility': bot.botId, disabled: busy,
          checked: visibility === 'room',
          onChange: event => onVisibility?.(event.target.checked ? 'room' : 'private'),
        }),
        h('span', { className: 'bt-set-hint' }, t('Visible to members')))
      : null,
    removable
      ? h('button', {
        type: 'button', className: 'bt-soft', disabled: busy, 'data-wg-remove-bot': bot.botId,
        onClick: () => act(() => onAction('removeBot', { ownerUserId: bot.ownerUserId, botId: bot.botId })),
      }, t('Remove'))
      : null)
}

/**
 * The form.
 *
 * `onAction(operation, payload)` is the workgroup adapter's room-operation table; `onDissolve` is the
 * owner's ending action, kept separate because it is a different authority. `onFlag` writes this
 * device's sidebar preference and is optional: a host without local storage simply hides the card.
 */
export function WorkgroupSettingsForm({
  room,
  members = [],
  bots = [],
  selfUserId,
  identity,
  prefs,
  onAction,
  onDissolve,
  onClose,
  onFlag,
  loadOwnerBots,
  loadBotCandidates,
}) {
  const [name, setName] = useState(room.name)
  const [notice, setNotice] = useState(room.notice ?? '')
  const [target, setTarget] = useState('')
  const [candidates, setCandidates] = useState([])
  const [candidateNote, setCandidateNote] = useState(undefined)
  const [visibilityOverrides, setVisibilityOverrides] = useState({})
  const [botId, setBotId] = useState('')
  const [inviteTarget, setInviteTarget] = useState('')
  const [invitation, setInvitation] = useState(undefined)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(undefined)
  const role = (members ?? []).find(member => member.userId === selfUserId)?.role
  const owner = role === 'owner'
  const manage = (owner || role === 'admin') && room.dissolvedAt === undefined
  const act = async (operation) => {
    if (busy) return
    setBusy(true); setError(undefined)
    try { return await operation() } catch (failure) { setError(failure?.message ?? String(failure)) } finally { setBusy(false) }
  }
  useEffect(() => { setName(room.name) }, [room.name])
  useEffect(() => { setNotice(room.notice ?? '') }, [room.notice])
  useEffect(() => {
    let live = true
    if (!manage) return () => { live = false }
    const read = typeof loadBotCandidates === 'function'
      ? loadBotCandidates
      : (typeof loadOwnerBots === 'function' ? async () => (await loadOwnerBots()).map(entry => ({ ...entry, mine: true })) : undefined)
    if (read === undefined) return () => { live = false }
    Promise.resolve(read()).then((listed) => {
      if (live) setCandidates(Array.isArray(listed) ? listed : [])
    }).catch((failure) => { if (live) setCandidateNote(failure?.message ?? String(failure)) })
    return () => { live = false }
  }, [manage, loadBotCandidates, loadOwnerBots])

  const present = new Set((bots ?? []).map(bot => `${bot.ownerUserId}:${bot.botId}`))
  const available = candidates.filter(entry => entry?.botId !== undefined && !present.has(`${entry.ownerUserId ?? selfUserId}:${entry.botId}`) && entry.inRoom !== true)
  // The candidate list is where a Bot's directory visibility is known; the room list carries only what
  // the room shows. A local override keeps the switch honest immediately after it is flipped.
  const visibilityOf = (bot) => {
    if (Object.hasOwn(visibilityOverrides, bot.botId)) return visibilityOverrides[bot.botId]
    const candidate = candidates.find(entry => entry.botId === bot.botId && (entry.mine === true || entry.ownerUserId === selfUserId))
    return candidate?.visibility === 'room' || candidate?.visibility === 'public' ? 'room' : 'private'
  }
  const changeVisibility = (bot, value) => act(async () => {
    await onAction('setBotVisibility', { botId: bot.botId, visibility: value })
    setVisibilityOverrides(current => ({ ...current, [bot.botId]: value }))
  })
  const own = available.filter(entry => entry.mine === true || entry.ownerUserId === selfUserId)
  const others = available.filter(entry => entry.mine !== true && entry.ownerUserId !== selfUserId && entry.visibility !== 'private')

  return h('div', { className: 'bt-bs bt-wg-settings-form' },
    h(Hero, { room, members }),
    h(Card, { title: t('Profile') },
      manage
        ? h('div', { className: 'bt-set-row bt-bs-row' },
          h('input', {
            className: 'bt-bs-input', 'aria-label': t('Group name'), value: name, maxLength: 60,
            onChange: event => setName(event.target.value),
          }),
          h('button', {
            type: 'button', className: 'bt-soft', disabled: busy || name.trim() === '' || name.trim() === room.name,
            'data-wg-action': 'rename', onClick: () => act(() => onAction('renameRoom', { name: name.trim() })),
          }, t('Save changes')))
        : h(Row, { label: t('Name') }, room.name),
      manage
        ? h(Row, { label: t('Notice'), hint: t('Every member reads it before speaking in this group.'), stack: true },
          h('textarea', {
            className: 'bt-bs-input bt-bs-area', 'aria-label': t('Notice'), value: notice, maxLength: 2000, rows: 3,
            onChange: event => setNotice(event.target.value),
          }),
          h('button', {
            type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || notice === (room.notice ?? ''),
            'data-wg-action': 'notice', onClick: () => act(() => onAction('updateNotice', { notice })),
          }, t('Save notice')))
        : h(Row, { label: t('Notice') }, room.notice ?? '')),
    // The original group's execution settings are replaced with an explanation, not removed
    // silently: a member who looks for "who answers" or "working folder" must find out why a
    // workgroup does not have one.
    h(Card, { title: t('Task collaboration') },
      h('div', { className: 'bt-set-row bt-bs-row bt-bs-stack' },
        h('span', { className: 'bt-set-hint' },
          t('A Bot here belongs to someone else. When you @ it, its owner approves the folder, tools, and lifetime of that one task — the group never shares an execution scope.')))),
    h(Card, { title: t('Members · {count}', { count: (members ?? []).length }) },
      (members ?? []).map(member => h(MemberRow, { key: member.userId, member, manage, selfUserId, busy, act, onAction })),
      manage
        ? h('div', { className: 'bt-set-row bt-bs-row' },
          h('input', {
            className: 'bt-bs-input', 'aria-label': t('User ID'), placeholder: t('User ID to invite'),
            value: target, onChange: event => setTarget(event.target.value),
          }),
          h('button', {
            type: 'button', className: 'bt-soft', disabled: busy || target.trim() === '', 'data-wg-action': 'invite',
            onClick: () => act(async () => {
              const created = await onAction('invite', { targetUserId: target.trim() })
              setInvitation(created)
              setTarget('')
            }),
          }, t('Invite')))
        : null,
      invitation
        ? h('button', {
          type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, 'data-wg-action': 'revoke',
          onClick: () => act(async () => { await onAction('revokeInvitation', { invitationId: invitation.id }); setInvitation(undefined) }),
        }, t('Revoke invitation'))
        : null),
    h(Card, { title: t('Bots · {count}', { count: (bots ?? []).length }) },
      (bots ?? []).length === 0
        ? h('div', { className: 'bt-set-row bt-bs-row' }, h('span', { className: 'bt-set-hint' }, t('No Bots in this workgroup.')))
        : (bots ?? []).map(bot => h(BotRow, {
          key: `${bot.ownerUserId}:${bot.botId}`,
          bot,
          selfUserId,
          manage,
          busy,
          act,
          onAction,
          visibility: visibilityOf(bot),
          onVisibility: value => changeVisibility(bot, value),
        })),
      candidateNote === undefined ? null : h('div', { className: 'bt-set-row bt-bs-row' }, h('span', { className: 'bt-set-hint' }, candidateNote)),
      manage && own.length > 0
        ? h('div', { className: 'bt-set-row bt-bs-row' },
          h('select', { className: 'bt-bs-input', 'aria-label': t('Add a Bot'), value: botId, onChange: event => setBotId(event.target.value) },
            h('option', { value: '' }, t('Choose a Bot')),
            own.map(entry => h('option', { key: `${entry.ownerUserId}:${entry.botId}`, value: entry.botId }, entry.displayName ?? entry.botId))),
          h('button', {
            type: 'button', className: 'bt-soft', disabled: busy || botId === '', 'data-wg-action': 'add-bot',
            onClick: () => act(async () => { await onAction('addBot', { botId }); setBotId('') }),
          }, t('Add Bot')))
        : null,
      // Somebody else's Bot joins only when its owner accepts; the row asks for that, it does not add.
      manage && others.length > 0
        ? h('div', { className: 'bt-set-row bt-bs-row' },
          h('select', {
            className: 'bt-bs-input', 'aria-label': t("Invite another member's Bot"), value: inviteTarget,
            onChange: event => setInviteTarget(event.target.value),
          },
          h('option', { value: '' }, t('Choose a colleague’s Bot')),
          others.map(entry => h('option', { key: `${entry.ownerUserId}:${entry.botId}`, value: `${entry.ownerUserId}:${entry.botId}` },
            `${entry.displayName ?? entry.botId} · ${entry.ownerDisplayName ?? entry.ownerUserId}`))),
          h('button', {
            type: 'button', className: 'bt-soft', disabled: busy || inviteTarget === '', 'data-wg-action': 'invite-bot',
            onClick: () => act(async () => {
              const [ownerUserId, bot] = inviteTarget.split(':')
              await onAction('inviteBot', { ownerUserId, botId: bot })
              setInviteTarget('')
            }),
          }, t('Ask the owner')))
        : null,
      h('div', { className: 'bt-set-row bt-gs-note' }, h('span', { className: 'bt-set-hint' },
        t('A Bot’s owner approves every task it runs. A workgroup never appoints a Bot as an administrator.')))),
    onFlag === undefined
      ? null
      : h(Card, { title: t('Sidebar') },
        h(SwitchRow, {
          label: t('Pin'), hint: t('Kept above the other chats.'), on: prefs?.pinned === true,
          onChange: pinned => onFlag({ pinned }),
        }),
        h(SwitchRow, {
          label: t('Hide from sidebar'), hint: t('Search still finds it.'), on: prefs?.hidden === true,
          onChange: hidden => onFlag({ hidden }),
        })),
    h(Card, { title: t('Manage') },
      owner && room.dissolvedAt === undefined
        ? h('button', {
          type: 'button', className: 'bt-set-row bt-bs-row bt-bs-danger', disabled: busy,
          'data-group-action': 'dissolve', 'data-confirm': confirming || undefined,
          onClick: () => { if (!confirming) { setConfirming(true); return } void act(() => onDissolve(room.id)) },
        },
        h('span', { className: 'bt-set-copy' },
          h('span', { className: 'bt-bs-label' }, confirming ? t('Dissolve {name}?', { name: room.name }) : t('Dissolve workgroup')),
          h('span', { className: 'bt-set-hint' }, confirming ? t('Click again to dissolve. History and records are kept.') : t('Ends the workgroup for everyone. Its history is kept and stays readable.'))),
        h('span', { className: 'bt-chevron' }, h(ChevronRightIcon)))
        : null,
      !owner && role !== undefined && room.dissolvedAt === undefined
        ? h('button', {
          type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, 'data-wg-action': 'leave',
          onClick: () => act(async () => { await onAction('leaveRoom', {}); onClose() }),
        }, t('Leave workgroup'))
        : null,
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onClose }, t('Close'))),
    identity === undefined ? null : h('div', { className: 'bt-set-row bt-gs-note' },
      h('span', { className: 'bt-set-hint' }, t('Your user id: {id}', { id: identity.userId ?? '' }))),
    error === undefined ? null : h('div', { role: 'alert', className: 'bt-danger', 'data-wg-settings-error': 'true' }, error))
}

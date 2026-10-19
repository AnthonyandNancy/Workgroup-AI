// Creating a workgroup: the copied new-chat surface, with the workgroup's joining rules.
//
// The original group form picks a local admin Bot first, then the other members. A workgroup cannot
// copy the admin step: its administrator is a person and its members join by accepting an
// invitation. What remains is the same surface: the `bt-newchat` pane, the `bt-to` recipient row,
// the `bt-drop` option list, and the `bt-nc-compose` card. A workgroup adds the one field the
// original new-chat flow does not have — its name — inside that same card.
//
// Three kinds of choice are offered, and each behaves as the workgroup model requires:
//
//  * the creator and at least one Bot make a workgroup; a blank name is derived from those members;
//  * a Bot may be one of the creator's own; it joins immediately, because its owner is the creator;
//  * a colleague is named by their Hub user id and is only *invited*: they appear in the room after
//    accepting, not before.
//
// The form performs no request itself. The Host's creation action owns the Hub calls and reports
// their failures, so this surface cannot become a second path into room creation.

import { createElement as h, useEffect, useState } from 'react'
import { ArrowUpIcon, PlusIcon } from '../icons.js'
import { BotMark } from '../mark.js'
import { useEscape, usePaneLeft } from '../overlay-hooks.js'
import { t } from '../i18n.js'
import { hubCreateHint, hubStatusOf } from '../workgroup-status.js'
import { HumanFace } from './thread.js'

/** Normalise the typed invitations into distinct user ids. */
export function inviteIdsOf(list) {
  const seen = new Set()
  const ids = []
  for (const entry of Array.isArray(list) ? list : []) {
    const id = String(entry ?? '').trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

/**
 * The creation form.
 *
 * @param workgroups - the Host adapter: `createRoom`, `invite`, `directory`, `identity`, and `available`.
 * @param hub - the current Hub view, used to tell "not configured" from "signed out" or "offline".
 * @param onCreated - called with the created room after the Hub answered.
 * @param onCancel - closes the form without creating anything.
 * @param report - receives a failure the form cannot recover from.
 */
export function WorkgroupCreate({ workgroups, hub, onCreated, onCancel, report }) {
  const [name, setName] = useState('')
  const [bots, setBots] = useState([])
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState([])
  const [target, setTarget] = useState('')
  const [invites, setInvites] = useState([])
  const [cursor, setCursor] = useState(0)
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState(undefined)
  const [error, setError] = useState(undefined)
  const paneLeft = usePaneLeft()
  useEscape(onCancel)

  useEffect(() => {
    let live = true
    if (typeof workgroups?.directory !== 'function') return () => { live = false }
    const owner = workgroups.identity?.userId
    Promise.resolve(workgroups.directory({ ownerUserId: owner }))
      .then((listed) => {
        if (!live) return
        const entries = Array.isArray(listed) ? listed : []
        // The Hub's directory also carries colleagues' visible Bots. Only the creator's own entries
        // can join without an invitation, so only those are offered here.
        setBots(owner === undefined
          ? entries.filter(entry => entry?.mine === true)
          : entries.filter(entry => entry?.mine === true || entry?.ownerUserId === owner))
      })
      .catch((failure) => { if (live) setError(failure?.message ?? String(failure)) })
    return () => { live = false }
  }, [workgroups])

  const status = hub === undefined ? undefined : hubStatusOf(hub)
  const blockedReason = status === undefined
    ? (workgroups?.available === false
        ? t('Creating a workgroup needs the Workgroup Hub. Ask your administrator to configure one.')
        : undefined)
    : (status === 'live' ? undefined : t(hubCreateHint(status, hub)))
  const blocked = blockedReason !== undefined
  const wanted = query.trim().toLowerCase()
  const filteredBots = wanted === ''
    ? bots
    : bots.filter(bot => String(bot.displayName ?? bot.botId).toLowerCase().includes(wanted))
  const active = Math.min(cursor, Math.max(0, filteredBots.length - 1))
  const pickedBots = picked.map(id => bots.find(bot => bot.botId === id)).filter(Boolean)
  const defaultName = pickedBots.length === 0
    ? ''
    : [t('You'), ...pickedBots.map(bot => bot.displayName ?? bot.botId)]
      .join(t(', '))
      .slice(0, 60)
  const roomName = name.trim() === '' ? defaultName : name.trim()
  // Which Bot the Hub will pick as administrator, computed with the same rule it uses: the first
  // Main Bot in the order the user added them. The form does not send it — the Hub generates it, as
  // a local group does — but knowing it here is what lets the button be disabled with a reason
  // instead of the click ending in a 400.
  const leaderBotId = pickedBots.find(bot => bot.isChief === true)?.botId
  // The two conditions the Hub checks, asked here first. They are the original group chat's own
  // two conditions: at least two Bots, and a Main Bot among them.
  const missingLeader = pickedBots.length > 0 && leaderBotId === undefined
  const missingSecondBot = pickedBots.length === 1
  const canCreate = !busy
    && created === undefined
    && !blocked
    && pickedBots.length >= 2
    && leaderBotId !== undefined
    && roomName !== ''
  // Why the submit is disabled, on the button itself: a hover explains the same two conditions the
  // notice above spells out, for a user who reaches for the button first.
  const blockedTitle = pickedBots.length === 0
    ? t('Add at least one Bot')
    : (missingLeader
        ? t('This workgroup needs a Main Bot to lead it. Publish one and add it here.')
        : (missingSecondBot ? t('A workgroup needs at least two Bots: your Main Bot and one more.') : undefined))

  const toggleBot = (botId) => {
    setPicked(list => (list.includes(botId) ? list.filter(id => id !== botId) : [...list, botId]))
    setQuery('')
    setCursor(0)
  }
  const dropBot = (botId) => setPicked(list => list.filter(id => id !== botId))
  const addInvite = () => {
    setInvites(inviteIdsOf([...invites, target]))
    setTarget('')
  }
  const dropInvite = (id) => setInvites(list => list.filter(entry => entry !== id))

  const handleBotKeyDown = (event) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setCursor(Math.min(active + 1, Math.max(0, filteredBots.length - 1)))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setCursor(Math.max(active - 1, 0))
    } else if (event.key === 'Enter' && filteredBots[active] !== undefined) {
      event.preventDefault()
      toggleBot(filteredBots[active].botId)
    } else if (event.key === 'Backspace' && query === '' && picked.length > 0) {
      event.preventDefault()
      setPicked(list => list.slice(0, -1))
    }
  }
  const handleInviteKeyDown = (event) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      addInvite()
    }
  }

  const create = async () => {
    if (!canCreate) return
    setBusy(true); setError(undefined)
    let room
    try {
      // The room and the creator's chosen Bots are one Hub transaction: a room that exists without
      // the Bots it was created with would be a half-made workgroup. Invitations are separate by
      // nature — they are pending until each colleague accepts.
      // No `adminBotId`: the Hub generates the leader from `botIds` the way a local group takes its
      // first Main Bot. Naming it here would duplicate a rule the Hub already owns.
      room = await workgroups.createRoom(roomName, { kind: 'workgroup', botIds: pickedBots.map(bot => bot.botId) })
    } catch (failure) {
      setError(failure?.message ?? String(failure))
      report?.(failure)
      setBusy(false)
      return
    }
    // From here the room exists. A failed invitation must not leave the creator on this form and
    // invite a second room on the next click: remember the room, then report the invitation failure
    // after opening it.
    setCreated(room)
    const failed = []
    for (const targetUserId of invites) {
      try {
        await workgroups.invite(room.id, { targetUserId, role: 'member' })
      } catch (failure) {
        failed.push({ targetUserId, failure })
      }
    }
    try {
      onCreated?.(room)
    } catch (failure) {
      setError(failure?.message ?? String(failure))
      report?.(failure)
    }
    if (failed.length > 0) {
      const reason = failed
        .map(({ targetUserId, failure }) => `${targetUserId}: ${failure?.message ?? String(failure)}`)
        .join('; ')
      report?.(new Error(t('Workgroup created, but invitations failed: {reason}', { reason })))
    }
  }

  return h('div', { className: 'bt-pane', style: { left: paneLeft } },
    h('div', { className: 'bt-newchat', role: 'dialog', 'aria-label': t('Create workgroup chat') },
      h('div', { className: 'bt-to' },
        h('span', { className: 'bt-to-label' }, t('To:')),
        pickedBots.map(bot => h('span', { key: bot.botId, className: 'bt-token' },
          h(BotMark, { bot: { id: bot.botId, name: bot.displayName ?? bot.botId }, size: 16 }),
          bot.displayName ?? bot.botId,
          h('button', { type: 'button', 'aria-label': t('Remove {name}', { name: bot.displayName ?? bot.botId }), onClick: () => dropBot(bot.botId) }, '×'))),
        invites.map(id => h('span', { key: id, className: 'bt-token' },
          h(HumanFace, { name: id, size: 16 }), id,
          h('button', { type: 'button', 'aria-label': t('Remove {name}', { name: id }), onClick: () => dropInvite(id) }, '×'))),
        h('input', {
          autoFocus: true, value: query, 'aria-label': t('Add your Bot'), placeholder: t('Add your Bot'),
          onChange: (event) => { setQuery(event.target.value); setCursor(0) },
          onKeyDown: handleBotKeyDown,
        }),
        h('input', {
          className: 'bt-wg-invite-input', value: target, 'aria-label': t('User ID to invite'),
          placeholder: t('User ID to invite'),
          onChange: event => setTarget(event.target.value),
          onKeyDown: handleInviteKeyDown,
        }),
        target.trim() === ''
          ? null
          : h('button', {
            type: 'button', className: 'bt-soft bt-soft-sm', 'data-wg-create-invite': 'add',
            onClick: addInvite,
          }, h(PlusIcon), t('Add')),
        h('button', {
          type: 'button', className: 'bt-send bt-to-create', 'data-wg-create-submit': 'true',
          disabled: !canCreate,
          title: blockedTitle,
          onClick: () => { void create() },
        }, t('Create workgroup chat')),
        h('button', { type: 'button', className: 'bt-x', 'aria-label': t('Close'), onClick: onCancel }, '×')),
      h('div', { className: 'bt-drop' },
        h('div', { className: 'bt-drop-list', role: 'listbox', 'aria-label': t('Bots to add') },
          bots.length === 0
            ? h('div', { className: 'bt-hint' }, t('You have no published Bots. Publish one before creating a workgroup.'))
            : filteredBots.map((bot, index) => h('button', {
              key: bot.botId, type: 'button', role: 'option', className: 'bt-option',
              'aria-selected': index === active, 'data-wg-create-bot': bot.botId,
              onMouseEnter: () => setCursor(index),
              onClick: () => toggleBot(bot.botId),
            },
            h(BotMark, { bot: { id: bot.botId, name: bot.displayName ?? bot.botId }, size: 22 }),
            h('span', { className: 'bt-option-label' }, bot.displayName ?? bot.botId),
            bot.isChief === true ? h('span', { className: 'bt-option-hint', 'data-wg-create-chief': bot.botId }, t('Main Bot')) : null,
            picked.includes(bot.botId) ? h('span', { className: 'bt-option-hint' }, t('Added')) : null)))),
      h('div', { className: 'bt-nc-spacer' }),
      blockedReason === undefined
        ? null
        : h('div', { className: 'bt-error', role: 'status', 'data-wg-create-unavailable': 'true' }, blockedReason),
      missingLeader || missingSecondBot
        ? h('div', { className: 'bt-error', role: 'status', 'data-wg-create-blocked': missingLeader ? 'leader' : 'second-bot' },
          missingLeader
            ? t('This workgroup needs a Main Bot to lead it. Publish one and add it here.')
            : t('A workgroup needs at least two Bots: your Main Bot and one more.'))
        : null,
      error === undefined
        ? null
        : h('div', { className: 'bt-error', role: 'alert', 'data-wg-create-error': 'true' }, error),
      h('div', { className: 'bt-nc-compose' },
        h('div', { className: 'bt-nc-card' },
          h('span', { className: 'bt-nc-plus', 'aria-hidden': true }, h(PlusIcon)),
          h('textarea', {
            rows: 1, value: name, 'aria-label': t('Workgroup name'), placeholder: t('Workgroup name'), maxLength: 60,
            onChange: event => setName(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void create()
              }
            },
          }),
          h('button', {
            type: 'button', className: 'bt-nc-send', 'data-wg-create-send': 'true',
            'aria-label': t('Create workgroup chat'),
            title: blockedTitle,
            disabled: !canCreate,
            onClick: () => { void create() },
          }, h(ArrowUpIcon))))))
}

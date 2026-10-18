// Creating a workgroup: the copied creation surface, with the workgroup's joining rules.
//
// The original group form picks a local admin Bot first, then the other members, then a name. A
// workgroup cannot copy the admin step: its administrator is a person, its members join by accepting
// an invitation, and a Bot is optional. What remains is the same form: a name to type, members to
// choose, and one button that creates and opens the room.
//
// Three kinds of choice are offered, and each behaves as the workgroup model requires:
//
//  * the name is required — a workgroup is never created from a date alone;
//  * a Bot may be one of the creator's own; it joins immediately, because its owner is the creator;
//  * a colleague is named by their Hub user id and is only *invited*: they appear in the room after
//    accepting, not before.
//
// The form performs no request itself. The Host's creation action owns the Hub calls and reports
// their failures, so this surface cannot become a second path into room creation.

import { createElement as h, useEffect, useState } from 'react'
import { CloseIcon, PlusIcon } from '../icons.js'
import { BotAvatar } from '../mark.js'
import { t } from '../i18n.js'

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
 * @param workinggroups - the Host adapter: `createRoom`, `addBot`, `invite`, and `available`.
 * @param onCreated - called with the created room after the Hub answered.
 * @param onCancel - closes the form without creating anything.
 * @param report - receives a failure the form cannot recover from.
 */
export function WorkgroupCreate({ workgroups, onCreated, onCancel, report }) {
  const [name, setName] = useState('')
  const [bots, setBots] = useState([])
  const [picked, setPicked] = useState([])
  const [target, setTarget] = useState('')
  const [invites, setInvites] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(undefined)
  const available = workgroups?.available !== false
  useEffect(() => {
    let live = true
    if (typeof workgroups?.directory !== 'function') return () => { live = false }
    Promise.resolve(workgroups.directory({ ownerUserId: workgroups.identity?.userId }))
      .then((listed) => { if (live) setBots(Array.isArray(listed) ? listed : []) })
      .catch((failure) => { if (live) setError(failure?.message ?? String(failure)) })
    return () => { live = false }
  }, [workgroups])
  const addInvite = () => {
    const next = inviteIdsOf([...invites, target])
    setInvites(next)
    setTarget('')
  }
  const create = async () => {
    if (busy || name.trim() === '' || available === false) return
    setBusy(true); setError(undefined)
    try {
      // The room and the creator's chosen Bots are one Hub transaction: a room that exists without
      // the Bots it was created with would be a half-made workgroup. Invitations are separate by
      // nature — they are pending until each colleague accepts.
      const room = await workgroups.createRoom(name.trim(), { kind: 'workgroup', botIds: [...picked] })
      for (const targetUserId of invites) await workgroups.invite(room.id, { targetUserId, role: 'member' })
      onCreated?.(room)
    } catch (failure) {
      setError(failure?.message ?? String(failure))
      report?.(failure)
    } finally { setBusy(false) }
  }
  return h('div', { className: 'bt-pane bt-wg-create-pane' },
    h('div', { className: 'bt-newchat bt-wg-create', role: 'dialog', 'aria-label': t('Create workgroup chat') },
      h('div', { className: 'bt-wg-create-head' },
        h('span', { className: 'bt-wg-create-title' }, t('Create workgroup chat')),
        h('button', { type: 'button', className: 'bt-x', 'aria-label': t('Close'), onClick: onCancel }, h(CloseIcon))),
      h('label', { className: 'bt-wg-create-row' },
        h('span', { className: 'bt-bs-label' }, t('Name')),
        h('input', {
          className: 'bt-bs-input', 'aria-label': t('Workgroup name'), autoFocus: true, value: name, maxLength: 60,
          placeholder: t('What this workgroup is for'),
          onChange: event => setName(event.target.value),
        })),
      h('div', { className: 'bt-wg-create-row' },
        h('span', { className: 'bt-bs-label' }, t('Bots')),
        bots.length === 0
          ? h('span', { className: 'bt-set-hint' }, t('You have no published Bots. You can create the workgroup without one.'))
          : h('div', { className: 'bt-ng-picks', role: 'group', 'aria-label': t('Bots to add') },
            bots.map(bot => h('button', {
              key: bot.botId, type: 'button', role: 'checkbox', className: 'bt-ng-chip',
              'aria-checked': picked.includes(bot.botId), 'data-wg-create-bot': bot.botId,
              onClick: () => setPicked(list => (list.includes(bot.botId) ? list.filter(id => id !== bot.botId) : [...list, bot.botId])),
            },
            h(BotAvatar, { bot: { id: bot.botId, name: bot.displayName ?? bot.botId, look: { shape: 'circle', color: 'blue' } }, size: 22, badge: false, live: false }),
            h('span', { className: 'bt-ng-name' }, bot.displayName ?? bot.botId)))))),
      h('div', { className: 'bt-wg-create-row' },
        h('span', { className: 'bt-bs-label' }, t('Invite by user id')),
        h('div', { className: 'bt-wg-create-invites' },
          invites.map(id => h('span', { key: id, className: 'bt-token' }, id,
            h('button', {
              type: 'button', 'aria-label': t('Remove {name}', { name: id }),
              onClick: () => setInvites(list => list.filter(entry => entry !== id)),
            }, '×'))),
          h('input', {
            className: 'bt-bs-input', 'aria-label': t('User ID'), placeholder: t('User ID to invite'),
            value: target,
            onChange: event => setTarget(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); addInvite() }
            },
          }),
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', 'data-wg-create-invite': 'add', disabled: target.trim() === '', onClick: addInvite }, h(PlusIcon), t('Add'))),
        h('span', { className: 'bt-set-hint' }, t('An invited colleague joins after accepting.'))),
      available ? null : h('div', { className: 'bt-danger', role: 'status', 'data-wg-create-unavailable': 'true' }, t('Creating a workgroup needs the Workgroup Hub. Ask your administrator to configure one.')),
      error === undefined ? null : h('div', { className: 'bt-danger', role: 'alert', 'data-wg-create-error': 'true' }, error),
      h('div', { className: 'bt-set-row bt-task-foot bt-wg-create-foot' },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onCancel }, t('Cancel')),
        h('button', {
          type: 'button', className: 'bt-send bt-soft-sm', 'data-wg-create-submit': 'true',
          disabled: busy || available === false || name.trim() === '', onClick: () => { void create() },
        }, t('Create workgroup chat'))))
}

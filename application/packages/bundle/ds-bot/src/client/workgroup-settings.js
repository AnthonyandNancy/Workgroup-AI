// Workgroup settings use Hub profile and membership operations.
import { createElement as h, useState } from 'react'
import { Card, Row } from './bot-settings.js'
import { t } from './i18n.js'

/** Render Hub actions permitted by the viewer's current membership; failures remain visible. */
export function WorkgroupSettings({ room, members = [], selfUserId, onAction, onDissolve, onClose }) {
  const [name, setName] = useState(room.name)
  const [target, setTarget] = useState('')
  const [invitation, setInvitation] = useState(undefined)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(undefined)
  const role = members.find(member => member.userId === selfUserId)?.role
  const owner = role === 'owner'
  const manage = (owner || role === 'admin') && !room.dissolvedAt
  const act = async (operation) => {
    if (busy) return
    setBusy(true); setError(undefined)
    try { return await operation() } catch (failure) { setError(failure?.message ?? String(failure)) } finally { setBusy(false) }
  }
  return h('div', { className: 'bt-bs' },
    h(Card, { title: t('Profile') },
      manage ? h('div', { className: 'bt-set-row bt-bs-row' },
        h('input', { className: 'bt-bs-input', 'aria-label': t('Group name'), value: name, maxLength: 60, onChange: event => setName(event.target.value) }),
        h('button', { type: 'button', className: 'bt-soft', disabled: busy || name.trim() === '', 'data-wg-action': 'rename',
          onClick: () => act(() => onAction('renameRoom', { name: name.trim() })) }, t('Save changes')))
        : h(Row, { label: t('Name'), value: room.name })),
    h(Card, { title: t('Members · {count}', { count: members.length }) },
      members.map(member => h('div', { key: member.userId, className: 'bt-set-row bt-bs-row' },
        h('span', { className: 'bt-set-copy' }, member.displayName ?? member.userHandle ?? member.userId),
        manage && member.role !== 'owner' && member.userId !== selfUserId
          ? h('select', { 'data-wg-role': member.userId, 'aria-label': t('Role for {name}', { name: member.displayName ?? member.userId }), value: member.role, disabled: busy,
            onChange: event => { void act(() => onAction('setRole', { userId: member.userId, role: event.target.value })) } },
          h('option', { value: 'member' }, t('Member')), h('option', { value: 'admin' }, t('Admin')))
          : h('span', { className: 'bt-tag' }, member.role === 'owner' ? t('Owner') : member.role === 'admin' ? t('Admin') : t('Member')),
        manage && member.role !== 'owner' && member.userId !== selfUserId
          ? h('button', { type: 'button', className: 'bt-soft', disabled: busy, 'data-wg-remove': member.userId,
            onClick: () => act(() => onAction('removeMember', { userId: member.userId })) }, t('Remove')) : null)),
      manage ? h('div', { className: 'bt-set-row bt-bs-row' },
        h('input', { className: 'bt-bs-input', 'aria-label': t('User ID'), value: target, onChange: event => setTarget(event.target.value) }),
        h('button', { type: 'button', className: 'bt-soft', disabled: busy || target.trim() === '', 'data-wg-action': 'invite',
          onClick: () => act(async () => { setInvitation(await onAction('invite', { targetUserId: target.trim() })); setTarget('') }) }, t('Invite')))
        : null,
      invitation ? h('button', { type: 'button', className: 'bt-soft', disabled: busy, 'data-wg-action': 'revoke',
        onClick: () => act(async () => { await onAction('revokeInvitation', { invitationId: invitation.id }); setInvitation(undefined) }) }, t('Revoke invitation')) : null),
    h(Card, { title: t('Manage') },
      owner && !room.dissolvedAt ? h('button', { type: 'button', className: 'bt-set-row bt-bs-row bt-bs-danger', disabled: busy,
        'data-group-action': 'dissolve', 'data-confirm': confirming || undefined,
        onClick: () => { if (!confirming) { setConfirming(true); return } void act(() => onDissolve(room.id)) } },
      confirming ? t('Dissolve {name}?', { name: room.name }) : t('Dissolve workgroup')) : null,
      !owner && role !== undefined && !room.dissolvedAt ? h('button', { type: 'button', className: 'bt-soft', disabled: busy, 'data-wg-action': 'leave',
        onClick: () => act(async () => { await onAction('leaveRoom', {}); onClose() }) }, t('Leave workgroup')) : null,
      h('button', { type: 'button', className: 'bt-soft', onClick: onClose }, t('Close'))),
    error === undefined ? null : h('div', { role: 'alert', className: 'bt-danger' }, error))
}

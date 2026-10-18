// The workgroup conversation body: messages and task activity, in one timeline.
//
// This is the copied half of the original group chat's message surface. A local group draws a
// member's words as a Bubble with that member's avatar and name; a workgroup does the same, but a
// member is a person on another machine rather than one of this team's Bots. The markup and the
// classes are the original ones (`bt-group-msg`, `bt-umsg`, `bt-ubody`, `bt-uattach`), so the two
// surfaces are the same interface rather than two that resemble each other.
//
// Task activity is not a message: it has no sender, no sequence number, and the Hub never writes it
// into the message log. It is projected into this timeline at its own time, which is what lets a
// reader follow "Bob asked, Alice approved, the Bot finished" in one column without the workgroup
// pretending a Bot said something it did not.

import { createElement as h, useEffect, useMemo, useState } from 'react'
import { DownloadIcon, ReplyIcon } from '../icons.js'
import { dateLocale, t } from '../i18n.js'
import { replyParent } from '../workgroup-reply.js'

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i
const stamp = value => {
  const parsed = typeof value === 'number' ? value : Date.parse(value ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}
const clock = value => (stamp(value) > 0 ? new Date(stamp(value)).toLocaleTimeString(dateLocale(), { hour: 'numeric', minute: '2-digit' }) : undefined)
const day = value => (stamp(value) > 0 ? new Date(stamp(value)).toLocaleDateString(dateLocale(), { year: 'numeric', month: 'short', day: 'numeric' }) : undefined)

/** A person's disc: the same shape and size as a Bot mark, with their initial. */
export function HumanFace({ name, size = 32 }) {
  const label = String(name ?? '').trim()
  return h('span', {
    className: 'bt-human-face',
    style: { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size / 2.4)}px` },
    'aria-hidden': true,
  }, label === '' ? '?' : [...label][0].toUpperCase())
}

/**
 * Merge messages and tasks into one ordered timeline.
 *
 * Messages keep their `roomSeq` order; tasks sit at their creation time. Ties fall back to the id so
 * a repeated read cannot reorder two entries that share a millisecond. A task without a time goes
 * after the messages it could not be placed against, which is visible rather than silently lost.
 */
export function mergeTimeline(messages, tasks) {
  const lines = (messages ?? []).map(message => ({
    kind: 'message',
    id: message.id ?? `seq:${message.roomSeq}`,
    at: message.createdAt,
    seq: message.roomSeq ?? 0,
    message,
  }))
  const cards = (tasks ?? []).map(task => ({
    kind: 'activity',
    id: `task:${task.id}`,
    at: task.createdAt ?? task.updatedAt,
    seq: 0,
    task,
  }))
  return [...lines, ...cards].sort((left, right) => {
    if (left.kind === 'message' && right.kind === 'message') return left.seq - right.seq
    const diff = stamp(left.at) - stamp(right.at)
    if (diff !== 0) return diff
    return left.id.localeCompare(right.id)
  })
}

function AttachmentRow({ entry, onDownload, onImage }) {
  const image = IMAGE.test(entry.fileName ?? '')
  const [url, setUrl] = useState(undefined)
  const [failed, setFailed] = useState(false)
  // An image is displayed where the original group chat displays one; the bytes still come from the
  // Hub's authorized download route, so a viewer without the attachment's ACL gets no picture.
  useEffect(() => {
    let live = true
    let created
    if (!image || onImage === undefined) return () => { live = false }
    Promise.resolve(onImage(entry)).then((value) => {
      if (!live) { if (typeof value === 'string') URL.revokeObjectURL(value); return }
      created = value
      setUrl(value)
    }).catch(() => { if (live) setFailed(true) })
    return () => { live = false; if (typeof created === 'string') URL.revokeObjectURL(created) }
  }, [entry.artifactId])
  return h('button', {
    type: 'button',
    className: image ? 'bt-uattach-image' : 'bt-ufile',
    'data-wg-artifact': entry.artifactId,
    title: entry.fileName ?? entry.artifactId,
    onClick: () => { void onDownload?.(entry) },
  },
  image
    ? (url === undefined
      ? h('span', { className: 'bt-uattach-image-name' }, failed ? t('Image unavailable') : (entry.fileName ?? entry.artifactId))
      : h('img', { className: 'bt-uattach-img', src: url, alt: entry.fileName ?? t('Image attachment') }))
    : h('span', { className: 'bt-ufile-text' },
      h('span', { className: 'bt-ufile-name' }, entry.fileName ?? entry.artifactId),
      h('span', { className: 'bt-ufile-meta' }, h(DownloadIcon))),
  )
}

function Quote({ quoted }) {
  if (quoted === undefined) return null
  return h('div', { className: 'bt-wg-quote', 'data-wg-quote': quoted.id },
    h('span', { className: 'bt-wg-quote-who' }, quoted.who ?? t('An earlier message')),
    quoted.body === undefined ? null : h('span', { className: 'bt-wg-quote-body' }, quoted.body))
}

/**
 * One message, in the shape the original group chat uses for a member's words.
 *
 * The viewer's own messages sit on the right without a face, like the original composer's bubbles;
 * everyone else's sit on the left under their name, like a group member's post.
 */
function MessageLine({ message, quoted, selfUserId, onReply, onDownload, onImage }) {
  const own = message.senderUserId === selfUserId
  const name = message.senderDisplayName ?? message.senderUserId ?? ''
  const body = message.body ?? ''
  const attachments = message.attachments ?? []
  if (own) {
    return h('div', { className: 'bt-umsg', 'data-wg-message': message.id ?? String(message.roomSeq) },
      h('div', { className: 'bt-ustack' },
        h(Quote, { quoted }),
        attachments.length > 0 ? h('div', { className: 'bt-uattach' }, attachments.map(entry => h(AttachmentRow, { key: entry.artifactId, entry, onDownload, onImage }))) : null,
        body === '' ? null : h('div', { className: 'bt-ubody', title: clock(message.createdAt) }, body),
        message.failed ? h('div', { className: 'bt-wg-message-failed', role: 'status' }, t('Not delivered')) : null),
      h('div', { className: 'bt-utools' }, message.id === undefined ? null : h('button', {
        type: 'button', className: 'bt-tool', 'data-wg-reply': message.id, 'aria-label': t('Quote this message'), title: t('Quote'),
        onClick: () => onReply?.(message),
      }, h(ReplyIcon))))
  }
  return h('div', { className: 'bt-group-msg', 'data-wg-message': message.id ?? String(message.roomSeq) },
    h('span', { className: 'bt-group-name' }, h(HumanFace, { name, size: 18 }), name),
    h('div', { className: 'bt-msg-line' },
      h('div', { className: 'bt-bubble' },
        h(Quote, { quoted }),
        body === '' ? null : h('span', { className: 'bt-wg-message-text' }, body),
        attachments.length > 0 ? h('div', { className: 'bt-uattach' }, attachments.map(entry => h(AttachmentRow, { key: entry.artifactId, entry, onDownload, onImage }))) : null,
        message.failed ? h('div', { className: 'bt-wg-message-failed', role: 'status' }, t('Not delivered')) : null)),
    h('div', { className: 'bt-utools' }, message.id === undefined ? null : h('button', {
      type: 'button', className: 'bt-tool', 'data-wg-reply': message.id, 'aria-label': t('Quote this message'), title: t('Quote'),
      onClick: () => onReply?.(message),
    }, h(ReplyIcon))))
}

/**
 * The conversation's timeline.
 *
 * `renderActivity` is supplied by the assembly: the thread owns ordering, and the activity module
 * owns a task card's contents. Keeping the two apart is what lets the activity surface change
 * without touching message ordering, and vice versa.
 */
export function WorkgroupThread({ messages, tasks, selfUserId, empty, onReply, onDownload, onImage, renderActivity }) {
  const ordered = useMemo(() => mergeTimeline(messages, tasks), [messages, tasks])
  const messagesById = useMemo(() => new Map((messages ?? []).map(message => [message.id, message])), [messages])
  if (ordered.length === 0) {
    return h('div', { className: 'bt-wg-empty', 'data-wg-thread': 'empty' }, empty ?? t('No messages yet'))
  }
  let lastDay
  return h('div', { className: 'bt-wg-thread', 'data-wg-thread': 'list' },
    ordered.map((line) => {
      const entryDay = day(line.at)
      const separator = entryDay !== undefined && entryDay !== lastDay ? h('div', { key: `day:${line.id}`, className: 'bt-wg-day', 'data-wg-day': entryDay }, entryDay) : null
      if (entryDay !== undefined) lastDay = entryDay
      if (line.kind === 'activity') {
        return h('div', { key: line.id, 'data-wg-line': 'activity' }, separator, renderActivity?.(line.task))
      }
      const message = messagesById.get(line.id) ?? line.message
      const quoted = replyParent(message, messages ?? [])
      return h('div', { key: line.id, className: 'bt-wg-line', 'data-wg-seq': String(message.roomSeq ?? ''), 'data-wg-line': 'message' },
        separator,
        h(MessageLine, {
          message,
          quoted,
          selfUserId,
          onReply,
          onDownload,
          onImage,
        }))
    }))
}

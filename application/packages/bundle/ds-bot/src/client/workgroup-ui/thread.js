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
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { DownloadIcon, ReplyIcon, SmileIcon } from '../icons.js'
import { BotMark } from '../mark.js'
import { dateLocale, t } from '../i18n.js'
import { replyParent } from '../workgroup-reply.js'
import { avatarFaces, seatBots } from './model.js'

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i
const mdLabels = () => ({ code: { copyLabel: t('Copy'), copiedLabel: t('Copied') }, footnotes: t('Footnotes') })
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
 * A group avatar's seat geometry, copied from the original `mark.js` (`clusterSeats`, not exported
 * there): two on a diagonal, three in a triangle, four in a grid.
 */
function clusterSeats(count, frame) {
  if (count === 1) return [[0, 0, frame]]
  if (count === 2) return [[0, 0, frame * 2 / 3], [frame / 3, frame / 3, frame * 2 / 3]]
  if (count === 3) {
    const size = frame * 5 / 9
    const rest = frame - size
    return [[rest / 2, 0, size], [0, rest, size], [rest, rest, size]]
  }
  const half = frame / 2
  return [[0, 0, half], [half, 0, half], [0, half, half], [half, half, half]]
}

/**
 * A workgroup's face, in the original group chat's shape: people as initial discs, the room's Bots
 * as their characters, up to four seats with a `+N` for the rest.
 *
 * This is the workgroup's own copy rather than the original `RoomAvatar`, for three reasons the
 * original cannot express: it resolves members through the local roster and silently drops ids it
 * does not know, it renders every seat as a Bot, and a workgroup seats colleagues and Bots together.
 *
 * @param props - the room's `members` and `bots`, this machine's `local` roster when it has one, and
 *   the pixel `size`.
 */
export function WorkgroupAvatar({ members, bots, local, size = 36 }) {
  const { roster } = seatBots(bots, local)
  const { faces, more } = avatarFaces(members, bots, 4)
  const faceOf = (face, seatSize) => (face.kind === 'person'
    ? h(HumanFace, { name: face.name, size: seatSize })
    : h(BotMark, { bot: roster.byId[`wg:${face.ownerUserId}:${face.botId}`], size: seatSize }))
  const keyOf = (face, index) => (face?.kind === 'person'
    ? `p:${face.userId}`
    : face?.kind === 'bot' ? `b:${face.ownerUserId}:${face.botId}` : `s:${index}`)
  // Inline sizes have no room for a cluster, so the faces line up instead, as the original does.
  if (size <= 20 && faces.length > 1) {
    const shown = faces.slice(0, 3)
    return h('span', { className: 'bt-stack', style: { '--bt-stack-size': `${size}px` } },
      shown.map((face, index) => h('span', { key: keyOf(face, index), className: 'bt-stack-face' }, faceOf(face, size))),
      faces.length > 3 ? h('span', { className: 'bt-stack-more' }, `+${faces.length - 3}`) : null)
  }
  const seats = clusterSeats(Math.min(faces.length, 4), size)
  return h('span', { className: 'bt-cluster', style: { width: size, height: size } },
    seats.map(([x, y, s], index) => (index === 3 && more > 0
      ? h('span', {
        key: 'more',
        className: 'bt-cluster-more',
        style: { position: 'absolute', left: x, top: y, width: s, height: s, fontSize: Math.max(8, Math.round(s * 0.36)) },
      }, `+${more}`)
      : h('span', {
        key: keyOf(faces[index], index),
        style: { position: 'absolute', left: x, top: y, width: s, height: s },
      }, faceOf(faces[index], s)))))
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

/**
 * The control that fetches the page before the oldest message on screen.
 *
 * Three states, because a reader needs to tell them apart: ready to load, loading, and "that failed,
 * try again". It only appears while the Hub says more exists, so an exhausted room does not offer a
 * button that would fetch nothing.
 */
function EarlierButton({ earlier, onLoadEarlier }) {
  if (earlier.hasMore !== true) {
    return earlier.failed === true
      ? h('div', { className: 'bt-wg-earlier-failed', role: 'status', 'data-wg-earlier': 'failed' },
        t('Could not load earlier messages.'))
      : null
  }
  return h('div', { className: 'bt-wg-earlier', 'data-wg-earlier': earlier.loading === true ? 'loading' : 'ready' },
    h('button', {
      type: 'button',
      className: 'bt-soft bt-soft-sm',
      'data-wg-load-earlier': 'true',
      disabled: earlier.loading === true,
      onClick: () => onLoadEarlier?.(),
    }, earlier.loading === true ? t('Loading earlier messages…') : t('Load earlier messages')))
}

/**
 * The strip that adds a reaction.
 *
 * Opened from the message's own tools, so it sits where the other per-message actions are rather than
 * in a global bar. One click adds; the strip closes on the same click, because a reaction is a single
 * act and leaving the strip open would invite a second one by accident.
 */
function ReactionPicker({ message, onReact }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return undefined
    const close = () => setOpen(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [open])
  return h('span', { className: 'bt-react-add' },
    h('button', {
      type: 'button',
      className: 'bt-tool',
      'data-wg-react-open': message.id,
      'aria-haspopup': 'menu',
      'aria-expanded': open,
      'aria-label': t('Add a reaction'),
      title: t('Add a reaction'),
      onClick: (event) => {
        event.stopPropagation()
        setOpen(value => !value)
      },
    }, h(SmileIcon)),
    open
      ? h('span', { className: 'bt-react-strip', role: 'menu', 'aria-label': t('Reactions') },
        REACTION_EMOJI.map(emoji => h('button', {
          key: emoji,
          type: 'button',
          role: 'menuitem',
          className: 'bt-react-pick',
          'data-wg-react': emoji,
          onClick: (event) => {
            event.stopPropagation()
            setOpen(false)
            onReact?.(message.id, emoji)
          },
        }, emoji)))
      : null)
}

/**
 * The reactions on one message.
 *
 * The Hub's set is the single source: each entry names an emoji and the people who chose it, so the
 * bar shows the tally and highlights the viewer's own choices. Clicking an emoji toggles it — adding
 * when the viewer has not chosen it, withdrawing their own when they have. Somebody else's reaction is
 * displayed but not clickable: withdrawing a colleague's reaction would be editing their statement,
 * and the Hub refuses it anyway.
 */
/** The reactions the Hub accepts. Kept beside the picker so the two cannot drift. */
export const REACTION_EMOJI = ['👍', '❤️', '😂', '🎉', '👀', '🙏']

function Reactions({ message, selfUserId, onReact, onUnreact }) {
  const reactions = Array.isArray(message.reactions) ? message.reactions : []
  if (reactions.length === 0 || message.id === undefined) return null
  return h('div', { className: 'bt-reacts', 'data-wg-reactions': message.id },
    reactions.map((entry) => {
      const mine = Array.isArray(entry.userIds) ? entry.userIds.includes(selfUserId) : false
      return h('button', {
        key: entry.emoji,
        type: 'button',
        className: 'bt-react',
        'data-wg-reaction': entry.emoji,
        'data-mine': mine ? 'true' : undefined,
        'aria-pressed': mine,
        title: mine ? t('Withdraw your reaction') : t('{count} reacted', { count: entry.userIds?.length ?? 0 }),
        'aria-label': `${entry.emoji} ${t('{count} reacted', { count: entry.userIds?.length ?? 0 })}`,
        onClick: () => (mine ? onUnreact?.(message.id, entry.emoji) : onReact?.(message.id, entry.emoji)),
      }, entry.emoji, h('span', { className: 'bt-react-count' }, String(entry.userIds?.length ?? 0)))
    }))
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
function MessageLine({ message, quoted, selfUserId, isLeader, onReply, onDownload, onImage, onReact, onUnreact }) {
  // A Bot speaks as itself even when its owner is the reader: the owner's name on the Bot's words
  // would claim the reader said something it did not, so the Bot check comes before the "own" one.
  const fromBot = message.senderBotId !== undefined
  const own = !fromBot && message.senderUserId === selfUserId
  const name = fromBot
    ? (message.senderBotDisplayName ?? message.senderBotId)
    : (message.senderDisplayName ?? message.senderUserId ?? '')
  const body = message.body ?? ''
  const attachments = message.attachments ?? []
  if (own) {
    return h('div', { className: 'bt-umsg', 'data-wg-message': message.id ?? String(message.roomSeq) },
      h('div', { className: 'bt-ustack' },
        h(Quote, { quoted }),
        attachments.length > 0 ? h('div', { className: 'bt-uattach' }, attachments.map(entry => h(AttachmentRow, { key: entry.artifactId, entry, onDownload, onImage }))) : null,
        body === '' ? null : h('div', { className: 'bt-ubody', title: clock(message.createdAt) },
          h(MarkdownText, { text: body, labels: mdLabels(), variant: 'compact' })),
        message.failed ? h('div', { className: 'bt-wg-message-failed', role: 'status' }, t('Not delivered')) : null),
      h(Reactions, { message, selfUserId, onReact, onUnreact }),
      h('div', { className: 'bt-utools' },
        message.id === undefined ? null : h(ReactionPicker, { message, onReact }),
        message.id === undefined ? null : h('button', {
          type: 'button', className: 'bt-tool', 'data-wg-reply': message.id, 'aria-label': t('Quote this message'), title: t('Quote'),
          onClick: () => onReply?.(message),
        }, h(ReplyIcon))))
  }
  return h('div', { className: 'bt-group-msg', 'data-wg-message': message.id ?? String(message.roomSeq) },
    h('span', { className: 'bt-group-name' }, name,
      isLeader ? h('span', { className: 'bt-tag' }, t('Admin')) : null),
    h('div', { className: 'bt-msg-line' },
      h('span', { className: 'bt-lead', 'aria-hidden': true },
        fromBot ? h(BotMark, { bot: { id: message.senderBotId }, size: 22 }) : h(HumanFace, { name, size: 22 })),
      h('div', { className: 'bt-bubble' },
        h(Quote, { quoted }),
        body === '' ? null : h('div', { className: 'bt-wg-message-text' },
          h(MarkdownText, { text: body, labels: mdLabels(), variant: 'compact' })),
        attachments.length > 0 ? h('div', { className: 'bt-uattach' }, attachments.map(entry => h(AttachmentRow, { key: entry.artifactId, entry, onDownload, onImage }))) : null,
        message.failed ? h('div', { className: 'bt-wg-message-failed', role: 'status' }, t('Not delivered')) : null)),
    h(Reactions, { message, selfUserId, onReact, onUnreact }),
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
export function WorkgroupThread({ messages, tasks, selfUserId, leaderBotId, empty, earlier, onLoadEarlier, onReply, onDownload, onImage, onReact, onUnreact, renderActivity }) {
  const ordered = useMemo(() => mergeTimeline(messages, tasks), [messages, tasks])
  const messagesById = useMemo(() => new Map((messages ?? []).map(message => [message.id, message])), [messages])
  if (ordered.length === 0) {
    return h('div', { className: 'bt-wg-empty', 'data-wg-thread': 'empty' }, empty ?? t('No messages yet'))
  }
  // The earlier pages sit above the timeline, inside the same scroller, so a reader reaches them by
  // scrolling up rather than through a separate view.
  const top = earlier === undefined ? null : h(EarlierButton, { earlier, onLoadEarlier })
  let lastDay
  return h('div', { className: 'bt-wg-thread', 'data-wg-thread': 'list' },
    top,
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
          isLeader: leaderBotId !== undefined && message.senderBotId === leaderBotId,
          onReply,
          onDownload,
          onImage,
          onReact,
          onUnreact,
        }))
    }))
}

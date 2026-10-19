// The workgroup composer: the copied input surface, adapted to a Hub room.
//
// The original composer is the shell's: a rounded card with the text on the left, a `+` menu for
// files / chat references / scheduled tasks, and the shell's own send path. A workgroup cannot use
// that send path — its messages go to the Hub, not into a local Session — so this module owns the
// same surface and the same menu for a Hub room. The classes and tokens are the product's own, which
// is what keeps the two composers visually one.
//
// Three safety rules are implemented here rather than trusted to the Hub:
//
//  * mentions are recorded as ids when picked, never derived from the text, so a display-name change
//    cannot retarget a message;
//  * a reference to a private local chat is refused with a stated reason — the workgroup does not
//    copy another person's Session into the Hub;
//  * a scheduled send only sends a message. If that message @s a Bot, the Hub turns it into a
//    pending approval request like any other message; nothing is executed on a timer.
//
// A draft survives a failed send. The idempotency id is created once per distinct payload and reused
// on retry, so a timeout cannot produce two messages.

import { createElement as h, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChatsIcon, ClockIcon, PaperclipIcon, PlusIcon, ArrowUpIcon, CloseIcon, MicIcon } from '../icons.js'
import { useLinger } from '../motion.js'
import { dateLocale, t } from '../i18n.js'
import { composeMessage, filterCandidates, mentionCandidates, MENTION_TRIGGER } from '../workgroup-mentions.js'

// A stable empty queue: an inline `[]` default would be a new array on every render, and the effect
// that mirrors the Host's answer would then set state forever.
const NO_SCHEDULES = Object.freeze([])
const keepFocus = event => event.preventDefault()
const nowMs = () => Date.now()

/**
 * What to tell the person when a send or an upload was refused.
 *
 * The Hub answers refusals with a machine code, and two of them describe a state the person can act
 * on. Everything else falls through to the Hub's own sentence, which is already written for a reader.
 */
const noteOf = (error) => {
  if (error?.code === 'BOT_NOT_AVAILABLE') return t('That Bot is not available in this workgroup any more.')
  if (error?.code === 'ROOM_DISSOLVED') return t('This workgroup has been dissolved, so no new message can be sent.')
  return error?.message ?? String(error)
}

/** A mention picker row's stable key. */
const candidateKey = candidate => {
  if (candidate.all === true) return 'all'
  return candidate.botId === undefined ? candidate.userId : `${candidate.userId}:${candidate.botId}`
}

function MentionMenu({ members, bots, query, canSummonEveryone, onPick }) {
  const all = filterCandidates(mentionCandidates({ members, bots, canSummonEveryone }), query).slice(0, 8)
  if (all.length === 0) return h('div', { className: 'bt-wg-mention-empty' }, t('Nobody in this workgroup matches.'))
  return h('div', { className: 'bt-wg-mentions', 'data-wg-mentions': 'open', role: 'listbox', 'aria-label': t('Mention someone') },
    all.map(candidate => h('button', {
      type: 'button',
      className: 'bt-wg-mention',
      'data-wg-mention': candidateKey(candidate),
      key: candidateKey(candidate),
      role: 'option',
      'aria-selected': 'false',
      onClick: () => onPick(candidate),
    },
    h('span', { className: 'bt-wg-mention-name' }, candidate.label),
    candidate.kind === 'bot'
      ? h('span', { className: 'bt-wg-mention-kind' }, t('Bot of {owner}', { owner: candidate.detail ?? '' }))
      : candidate.kind === 'all'
        ? h('span', { className: 'bt-wg-mention-kind' }, t('Everyone in the room'))
        : null)))
}

/**
 * The composer.
 *
 * `onSend(text, reply, extra)` returns `false` when the Hub did not accept the message; anything else
 * counts as accepted. The draft is cleared only on acceptance, because clearing on submit and then
 * failing loses what the person typed.
 */
/** The browser's speech recognition, or undefined where the browser has none. */
const speechApi = () => window.SpeechRecognition ?? window.webkitSpeechRecognition

/**
 * Dictation for this composer.
 *
 * Copied from the original composer rather than imported from it: the original must not gain a
 * workgroup dependency, and what is duplicated is a browser API call plus its error strings. The
 * final text is appended to the draft; interim text is shown the same way the original shows it, so
 * the two composers behave alike.
 */
function useDictation(onText) {
  const [listening, setListening] = useState(false)
  const [note, setNote] = useState('')
  const recognition = useRef(null)
  const latest = useRef(onText)
  latest.current = onText
  useEffect(() => () => recognition.current?.abort(), [])
  useEffect(() => {
    if (!note) return undefined
    const timer = setTimeout(() => setNote(''), 2600)
    return () => clearTimeout(timer)
  }, [note])
  const start = () => {
    const Api = speechApi()
    if (!Api) { setNote(t('Dictation is not available in this browser')); return false }
    const engine = new Api()
    engine.lang = navigator.language || 'zh-CN'
    engine.interimResults = true
    engine.continuous = true
    engine.onresult = (event) => {
      let interim = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        const text = result[0]?.transcript ?? ''
        if (result.isFinal) { if (text.trim()) latest.current(text, true) } else interim += text
      }
      if (interim) latest.current(interim, false)
    }
    engine.onerror = (event) => {
      if (event.error === 'aborted' || event.error === 'no-speech') return
      setNote(event.error === 'not-allowed' || event.error === 'service-not-allowed' ? t('Microphone access is blocked') : t("Couldn't hear that"))
    }
    engine.onend = () => { setListening(false); recognition.current = null }
    recognition.current = engine
    try { engine.start(); setListening(true); return true } catch { setNote(t("Couldn't start dictation")); return false }
  }
  const stop = () => recognition.current?.stop()
  return { listening, note, start, stop }
}

export function WorkgroupComposer({
  canSummonEveryone = false,
  room,
  members,
  bots,
  reply,
  onClearReply,
  onSend,
  onAttach,
  schedules = NO_SCHEDULES,
  onSchedule,
  onCancelSchedule,
  disabled = false,
}) {
  const [draft, setDraft] = useState('')
  const [picked, setPicked] = useState([])
  const [mentionQuery, setMentionQuery] = useState(undefined)
  const [attachments, setAttachments] = useState([])
  const [note, setNote] = useState(undefined)
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)
  const [menu, setMenu] = useState(undefined)
  const [shown, leaving] = useLinger(menu, 120)
  // The Host owns the queue; this is the last answer it gave, kept so a cancel or an add shows at
  // once instead of waiting for the next room read.
  const [scheduled, setScheduled] = useState(schedules)
  const [schedule, setSchedule] = useState(undefined)
  const [scheduleText, setScheduleText] = useState('')
  const [scheduleDelay, setScheduleDelay] = useState('5')
  const pendingSend = useRef(undefined)
  const button = useRef(null)
  const menuBox = useRef(null)
  const fileInput = useRef(null)
  const input = useRef(null)
  const mentioning = mentionQuery !== undefined

  // A room switch is a new draft: the previous room's words are not this room's.
  useEffect(() => {
    pendingSend.current = undefined
    setDraft('')
    setPicked([])
    setAttachments([])
    setMentionQuery(undefined)
    setFailed(false)
    setNote(undefined)
    if (input.current !== null) input.current.style.height = 'auto'
  }, [room?.id])

  // The box grows with the draft up to the stylesheet's max-height, then scrolls. Measured after
  // every change so a pasted paragraph does not stay a single line.
  useEffect(() => {
    const node = input.current
    if (node === null) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, 160)}px`
  }, [draft])

  useEffect(() => { setScheduled(schedules) }, [schedules])

  // Close the popovers on a press outside, or on Escape.
  useEffect(() => {
    if (menu === undefined) return undefined
    const onDown = (event) => { if (![button.current, menuBox.current].some(node => node?.contains(event.target))) setMenu(undefined) }
    const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); setMenu(undefined) } }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('mousedown', onDown, true); window.removeEventListener('keydown', onKey, true) }
  }, [menu])

  // A scheduled send is the Host's promise: it fires with this window closed, survives a restart,
  // and a refusal is retried rather than dropped. Nothing is executed on a timer — the Host sends a
  // normal message, and any @ in it still needs the Bot owner's approval.

  const trackMention = (value) => {
    const caret = value.length
    const trigger = value.lastIndexOf(MENTION_TRIGGER, caret - 1)
    if (trigger === -1) { setMentionQuery(undefined); return }
    const run = value.slice(trigger + 1, caret)
    if (/\s/.test(run)) { setMentionQuery(undefined); return }
    setMentionQuery(run)
  }

  const pickMention = (candidate) => {
    setPicked(list => (list.some(entry => candidateKey(entry) === candidateKey(candidate)) ? list : [...list, candidate]))
    const trigger = draft.lastIndexOf(MENTION_TRIGGER)
    setDraft(trigger === -1 ? `${draft}@${candidate.label} ` : `${draft.slice(0, trigger)}@${candidate.label} `)
    setMentionQuery(undefined)
  }

  const attach = async (file) => {
    if (file === undefined || file === null) return
    setNote(undefined)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const uploaded = await onAttach?.({ fileName: file.name, bytes, contentType: file.type === '' ? undefined : file.type })
      if (uploaded === undefined || uploaded === null) return
      setAttachments(list => [...list, { artifactId: uploaded.artifactId, fileName: uploaded.fileName ?? file.name }])
    } catch (error) {
      setNote(noteOf(error))
    }
  }

  const send = async () => {
    if (sending || draft.trim() === '' || disabled) return
    setSending(true)
    setNote(undefined)
    const extra = {
      mentions: composeMessage(draft, picked).mentions,
      attachments: attachments.map(entry => ({ artifactId: entry.artifactId })),
    }
    const key = JSON.stringify({ roomId: room?.id, text: draft.trim(), reply: reply?.id, ...extra })
    if (pendingSend.current?.key !== key) pendingSend.current = { key, id: globalThis.crypto.randomUUID() }
    try {
      const accepted = await onSend?.(draft.trim(), reply, { ...extra, clientMessageId: pendingSend.current.id })
      if (accepted !== false) {
        pendingSend.current = undefined
        setDraft(''); setPicked([]); setAttachments([]); setMentionQuery(undefined); setFailed(false)
      } else {
        setFailed(true)
        setNote(t('Not delivered'))
      }
    } catch (error) {
      setFailed(true)
      setNote(noteOf(error))
    } finally {
      setSending(false)
    }
  }

  const addSchedule = async () => {
    const minutes = Number(scheduleDelay)
    const text = scheduleText.trim()
    if (!Number.isFinite(minutes) || minutes <= 0) { setNote(t('Give the scheduled message a delay in minutes.')); return }
    if (text === '') { setNote(t('Write the message to send.')); return }
    setNote(undefined)
    try {
      const answer = await onSchedule?.({ roomId: room?.id, text, at: nowMs() + minutes * 60_000 })
      setScheduled(Array.isArray(answer?.schedules) ? answer.schedules : [...scheduled, answer?.schedule ?? { id: globalThis.crypto.randomUUID(), at: nowMs(), text }])
      setSchedule(undefined)
      setScheduleText('')
      setScheduleDelay('5')
      setNote(t('Scheduled on this machine. It is sent even if this window closes; an @ still needs the Bot owner’s approval.'))
    } catch (error) {
      setNote(error?.message ?? String(error))
    }
  }

  const toggleMenu = () => {
    if (menu !== undefined) { setMenu(undefined); return }
    const rect = button.current?.getBoundingClientRect()
    setMenu({ left: rect?.left ?? 0, bottom: window.innerHeight - (rect?.top ?? 0) + 8 })
  }

  // Dictation appends the recognised text to whatever is already typed, which is what the original
  // composer does: a half-written line must not be replaced by a spoken one.
  const dictation = useDictation((text, final) => {
    if (!final) return
    setDraft(current => (current === '' ? text : `${current}${/\s$/.test(current) ? '' : ' '}${text}`))
  })
  const placeholder = room?.name === undefined ? t('Message') : t('Message {name}', { name: room.name })
  return h('div', { className: 'bt-wg-compose' },
    scheduled.length > 0
      ? h('div', { className: 'bt-wg-scheduled', 'data-wg-scheduled': String(scheduled.length) },
        scheduled.map(entry => h('span', { key: entry.id, className: 'bt-wg-scheduled-item' },
          h(ClockIcon),
          h('span', { className: 'bt-wg-scheduled-text' }, entry.text),
          h('span', { className: 'bt-wg-scheduled-at' }, new Date(entry.at).toLocaleTimeString(dateLocale(), { hour: 'numeric', minute: '2-digit' })),
          h('button', {
            type: 'button', className: 'bt-wg-scheduled-drop', 'aria-label': t('Cancel scheduled message'),
            onClick: () => { void (async () => {
              try {
                const answer = await onCancelSchedule?.(entry.id)
                setScheduled(Array.isArray(answer?.schedules) ? answer.schedules : scheduled.filter(item => item.id !== entry.id))
              } catch (error) { setNote(error?.message ?? String(error)) }
            })() },
          }, h(CloseIcon)))))
      : null,
    reply === undefined ? null : h('div', { className: 'bt-wg-replying', 'data-wg-replying': reply.id },
      h('div', { className: 'bt-wg-replying-text' },
        h('div', { className: 'bt-wg-replying-who' }, t('Replying to {name}', { name: reply.who ?? '' })),
        h('div', { className: 'bt-wg-replying-body' }, reply.body ?? '')),
      h('button', {
        type: 'button', className: 'bt-wg-replying-drop', 'data-wg-reply-drop': 'clear',
        'aria-label': t('Stop replying'), onClick: onClearReply,
      }, t('Cancel'))),
    attachments.length > 0
      ? h('div', { className: 'bt-wg-pending', 'data-wg-pending': 'attachments' },
        attachments.map(entry => h('span', { className: 'bt-wg-pending-item', key: entry.artifactId },
          h('span', { className: 'bt-wg-pending-name' }, entry.fileName),
          h('button', {
            type: 'button', className: 'bt-wg-pending-drop', 'data-wg-pending-drop': entry.artifactId,
            'aria-label': t('Remove {name}', { name: entry.fileName }),
            onClick: () => setAttachments(list => list.filter(item => item.artifactId !== entry.artifactId)),
          }, t('Remove')))))
      : null,
    mentioning
      ? h(MentionMenu, { members, bots, query: mentionQuery, canSummonEveryone, onPick: pickMention })
      : null,
    schedule === undefined ? null : h('div', { className: 'bt-wg-schedule-form', role: 'dialog', 'aria-label': t('Scheduled task') },
      h('div', { className: 'bt-wg-schedule-copy' }, t('A scheduled message is a normal message sent later, even if this window is closed. It cannot run a Bot without the owner’s approval.')),
      h('input', {
        className: 'bt-bs-input', 'aria-label': t('Scheduled message'), placeholder: t('Message to send later'),
        value: scheduleText, onChange: event => setScheduleText(event.target.value),
      }),
      h('input', {
        className: 'bt-bs-input', 'aria-label': t('Delay in minutes'), inputMode: 'numeric', value: scheduleDelay,
        onChange: event => setScheduleDelay(event.target.value),
      }),
      h('div', { className: 'bt-wg-task-actions' },
        h('button', { type: 'button', className: 'bt-soft', onClick: () => setSchedule(undefined) }, t('Cancel')),
        h('button', { type: 'button', className: 'bt-soft', 'data-wg-schedule-add': 'true', onClick: () => { void addSchedule() } }, t('Schedule')))),
    h('div', { className: 'bt-wg-compose-card', 'data-composer-card': '' },
      h('button', {
        ref: button, type: 'button', className: 'bt-plus', 'aria-label': t('Add'), title: t('Add'),
        'aria-haspopup': 'menu', 'aria-expanded': menu !== undefined, onMouseDown: keepFocus, onClick: toggleMenu,
      }, h(PlusIcon)),
      h('button', {
        type: 'button',
        className: 'bt-mic',
        'data-wg-dictate': dictation.listening ? 'listening' : 'ready',
        'aria-label': dictation.listening ? t('Stop dictation') : t('Dictate'),
        'aria-pressed': dictation.listening,
        title: dictation.listening ? t('Stop dictation') : t('Dictate'),
        onMouseDown: keepFocus,
        onClick: () => (dictation.listening ? dictation.stop() : dictation.start()),
      }, h(MicIcon)),
      h('textarea', {
        ref: input,
        className: 'bt-wg-input',
        'data-wg-input': 'message',
        'aria-label': t('Message'),
        placeholder,
        value: draft,
        rows: 1,
        onChange: event => { setDraft(event.target.value); trackMention(event.target.value) },
        onKeyDown: (event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() }
        },
      }),
      h('button', {
        type: 'button', className: 'bt-wg-send', 'data-wg-send': 'submit',
        'aria-label': t('Send message'), disabled: disabled || sending || draft.trim() === '',
        onClick: () => { void send() },
      }, h(ArrowUpIcon))),
    h('input', {
      ref: fileInput, type: 'file', className: 'bt-wg-attach-input', 'aria-label': t('Attach a file'),
      onChange: event => { void attach(event.target.files?.[0]); event.target.value = '' },
    }),
    shown === undefined ? null : createPortal(h('div', {
      ref: menuBox, className: 'bt-menu bt-menu-up bt-plus-menu', role: 'menu', 'aria-label': t('Add'),
      style: { left: shown.left, bottom: shown.bottom }, 'data-leaving': leaving || undefined,
    },
    h('button', { type: 'button', role: 'menuitem', 'data-wg-plus': 'file', onClick: () => { setMenu(undefined); fileInput.current?.click() } },
      h(PaperclipIcon), h('span', { className: 'bt-menu-label' }, t('Add files'))),
    // The original row is kept in place and disabled with a reason: a workgroup message goes to the
    // Hub, so a reference to a private local chat would either send nothing or copy someone's Session
    // into a shared room. Neither is what the row promises.
    h('button', {
      type: 'button', role: 'menuitem', 'data-wg-plus': 'reference', 'aria-disabled': true, disabled: true,
      title: t('A workgroup message cannot reference a private chat on this machine.'),
    }, h(ChatsIcon), h('span', { className: 'bt-menu-label' }, t('Reference a chat'))),
    h('button', {
      type: 'button', role: 'menuitem', 'data-wg-plus': 'schedule',
      onClick: () => { setMenu(undefined); setSchedule({}) }, disabled: typeof onSchedule !== 'function',
    }, h(ClockIcon), h('span', { className: 'bt-menu-label' }, t('Scheduled task')))),
    document.body),
    note === undefined ? null : h('div', { className: failed ? 'bt-danger bt-wg-compose-note' : 'bt-wg-compose-note', role: 'status', 'data-wg-compose-note': failed ? 'failed' : 'info' }, note),
    dictation.note === '' ? null : h('div', { className: 'bt-wg-compose-note', role: 'status', 'data-wg-dictate-note': 'true' }, dictation.note),
    failed ? h('div', { className: 'bt-wg-message-failed', 'data-wg-draft': 'undelivered' }, t('Your message is still in the box. Send it again when the Hub is reachable.')) : null)
}

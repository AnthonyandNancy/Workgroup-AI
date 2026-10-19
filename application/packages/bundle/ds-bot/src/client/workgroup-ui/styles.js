// Styling for the copied workgroup surface.
//
// The base classes are the product's own: a workgroup message is a `bt-group-msg`, a viewer's own
// message is a `bt-umsg`, a settings card is a `bt-set-card`. This module adds only the rules those
// classes do not already have — the overlay's column split between conversation and details, the
// activity card, the composer's card shell, and the workgroup's status marks — and every rule uses
// the existing design tokens rather than a colour of its own. That is what keeps the workgroup from
// becoming a second visual system.
//
// Installed once by the client entry (`installCompiledStyles`), not rendered by a component.

import { SPRING_SHAPE } from '../motion.js'

export const WORKGROUP_UI_CSS = `
.bt-wg{flex:1;min-height:0;display:flex;flex-direction:column;font-size:14px;color:var(--bt-ink)}
.bt-wg-surface{flex:1;min-height:0;display:flex;flex-direction:column;transition:margin-right ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing}}
.bt-wg-surface[data-resizing]{transition:none}
.bt-wg-panel[data-dragging]{transition:none}
@media (prefers-reduced-motion:reduce){.bt-wg-surface{transition:none}}
.bt-wg-body{flex:1;min-height:0;display:flex}
.bt-wg-main{flex:1;min-width:0;display:flex;flex-direction:column}
.bt-wg-head{position:relative;height:56px;flex:none;display:flex;justify-content:center;align-items:center;gap:8px;padding:0 16px;border-bottom:.5px solid var(--bt-line)}
.bt-wg-pill{max-width:70%}
.bt-wg-invite-input{flex:0 1 200px;min-width:140px}
.bt-wg-hub-dot{flex:none;width:7px;height:7px;border-radius:999px;background:var(--bt-ink-3)}
.bt-wg-hub-dot-live{background:var(--bt-green)}
.bt-wg-hub-dot-offline,.bt-wg-hub-dot-refused,.bt-wg-hub-dot-signed-out,.bt-wg-hub-dot-absent{background:var(--bt-ink-3)}
.bt-wg-hub-dot-unknown{background:var(--bt-line-2)}
.bt-wg-thread{flex:1;min-height:0;overflow-y:auto;padding:16px 18px 8px;display:flex;flex-direction:column;gap:2px}
.bt-wg-day{align-self:center;margin:12px 0 4px;font-size:11px;color:var(--bt-ink-3);padding:2px 8px;border-radius:999px;background:var(--bt-tag-bg)}
.bt-wg-line{display:flex;flex-direction:column;gap:2px}
.bt-wg-message-text{word-break:break-word}
.bt-ubody [class*="_markdown"]{color:inherit!important;font-size:inherit!important;line-height:inherit!important}
.bt-ubody p{margin:0}
.bt-ubody p+p{margin-top:6px}
.bt-uattach-image{display:inline-flex;max-width:240px;padding:0;border:0;background:transparent;cursor:pointer}
.bt-uattach-img{display:block;max-width:240px;max-height:240px;border-radius:12px;object-fit:cover}
.bt-uattach-image-name{display:inline-flex;align-items:center;min-height:40px;padding:6px 12px;border-radius:12px;border:.5px solid var(--bt-line-2);background:var(--bt-card);font-size:13px;color:var(--bt-ink-2)}
.bt-group-name .bt-human-face{margin-right:6px;vertical-align:-5px}
.bt-human-face{display:inline-flex;align-items:center;justify-content:center;flex:none;border-radius:999px;background:var(--bt-tag-bg);color:var(--bt-tag-ink);font-weight:600;line-height:1;user-select:none}
.bt-human-face-sm{width:22px;height:22px;font-size:11px}
.bt-stack-face{display:inline-flex;align-items:center;justify-content:center;flex:none}
.bt-stack-face+.bt-stack-face{margin-left:-4px}
.bt-wg-memory-list{display:flex;flex-direction:column;gap:8px;margin:6px 0}
.bt-wg-memory{border:.5px solid var(--bt-line-2);border-radius:10px;background:var(--bt-card);padding:8px 10px;display:flex;flex-direction:column;gap:4px}
.bt-wg-memory-body{font-size:13px;line-height:19px;white-space:pre-wrap;word-break:break-word}
.bt-wg-memory-meta{display:flex;flex-wrap:wrap;gap:6px;font-size:11px;color:var(--bt-ink-3)}
.bt-wg-inline-error{margin:0 18px}
.bt-wg-compose{position:relative;flex:none;display:flex;flex-direction:column;gap:6px;padding:8px 16px 14px;border-top:.5px solid var(--bt-line-weak)}
.bt-wg-compose>.bt-wg-attach-input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
.bt-wg-compose-card{display:flex;align-items:flex-end;gap:4px;width:100%;box-sizing:border-box;padding:5px 6px 5px 6px;border-radius:20px;border:.5px solid var(--bt-line-2);background:var(--bt-card);box-shadow:0 1px 2px rgba(0,0,0,.04)}
.bt-wg-compose-card .bt-plus{flex:none;width:32px;height:32px;border:0;border-radius:999px;background:transparent;color:var(--bt-ink-2);display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.bt-wg-compose-card .bt-plus:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-wg-compose-card .bt-wg-input{flex:1 1 auto;min-width:0;width:100%;min-height:32px;max-height:160px;resize:none;box-sizing:border-box;border:0;outline:none;background:transparent;color:var(--bt-ink);font:inherit;line-height:20px;padding:6px 4px;overflow-y:auto}
.bt-wg-compose-card .bt-wg-input::placeholder{color:var(--bt-placeholder,var(--bt-ink-3))}
.bt-wg-compose-card .bt-wg-send{flex:none;width:32px;height:32px;border-radius:999px;border:0;background:var(--bt-user);color:var(--bt-user-ink);display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.bt-wg-compose-card .bt-wg-send:disabled{opacity:.3;cursor:default}
.bt-wg-compose-note{font-size:12px;color:var(--bt-ink-3);line-height:16px}
.bt-wg-scheduled{display:flex;flex-direction:column;gap:4px}
.bt-wg-scheduled-item{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:3px 8px;border-radius:999px;background:var(--bt-tag-bg);font-size:12px;color:var(--bt-ink-2)}
.bt-wg-scheduled-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:280px}
.bt-wg-scheduled-at{color:var(--bt-ink-3)}
.bt-wg-scheduled-drop{border:0;background:none;color:var(--bt-ink-3);cursor:pointer;padding:0;display:inline-flex}
.bt-wg-schedule-form{display:flex;flex-direction:column;gap:6px;padding:10px;border:.5px solid var(--bt-line-2);border-radius:12px;background:var(--bt-card)}
.bt-wg-schedule-copy{font-size:12px;color:var(--bt-ink-2);line-height:17px}
.bt-activity{display:flex;flex-direction:column;gap:6px;width:min(100%,600px);margin:14px auto;padding:10px 12px;border:.5px solid var(--bt-line-2);border-radius:14px;background:var(--bt-card);box-shadow:0 1px 2px rgba(0,0,0,.04);box-sizing:border-box}
.bt-activity-head{display:flex;align-items:center;gap:8px}
.bt-activity-mark{flex:none;display:inline-flex}
.bt-activity-title{font-weight:600;font-size:13px}
.bt-activity-who{margin-left:auto;font-size:12px;color:var(--bt-ink-3)}
.bt-activity-body{display:flex;flex-direction:column;gap:2px}
.bt-activity-events{display:flex;flex-direction:column;gap:2px;margin-top:4px;padding-left:2px}
.bt-activity-event{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--bt-ink-2)}
.bt-activity-event-at{margin-left:auto;color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.bt-wg-visibility{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--bt-ink-2);cursor:pointer}
.bt-wg-visibility input{accent-color:var(--bt-accent);margin:0}
.bt-wg-bot-row .bt-gs-who{width:100%}
.bt-wg-bot-row .bt-tag{max-width:52%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-wg-bot-controls{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}
.bt-wg-pane{box-sizing:border-box}
.bt-wg-name{font-weight:600;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-wg-empty{flex:1;display:flex;align-items:center;justify-content:center;padding:24px 32px;text-align:center;color:var(--bt-ink-2);font-size:13px;line-height:20px}
.bt-wg-offline .bt-wg-empty{color:var(--bt-ink-2)}
.bt-wg-offline .bt-wg-name{color:var(--bt-ink-2)}
.bt-wg-members{flex:none;display:flex;flex-wrap:wrap;gap:6px;padding:0 16px 8px;max-height:88px;overflow-y:auto}
.bt-wg-member{display:inline-flex;align-items:center;gap:6px;height:24px;border-radius:999px;background:var(--bt-tag-bg);color:var(--bt-tag-ink);font-size:12px;padding:0 10px}
.bt-wg-member-name{border:0;background:none;color:inherit;font:inherit;padding:0;cursor:inherit}
.bt-wg-member-bot{cursor:pointer}
.bt-wg-member-dot{flex:none;width:6px;height:6px;border-radius:999px;background:var(--bt-ink-3)}
.bt-wg-member-online .bt-wg-member-dot{background:var(--bt-green)}
.bt-wg-member-offline .bt-wg-member-dot{background:var(--bt-line-2)}
.bt-wg-member-owner{color:var(--bt-ink-3)}
.bt-wg-tasks{flex:none;display:flex;flex-direction:column;gap:8px;padding:0 16px}
/* The approval form and the review controls are the owner's private surface. They reuse the same
   task strip, so the card does not jump between "approve" and "review"; only the fields change. */
.bt-wg-approval,.bt-wg-review{display:flex;flex-direction:column;gap:6px;margin-top:6px}
.bt-wg-approval-note{font-size:12px;color:var(--bt-ink-3);line-height:16px}
.bt-wg-approval-error{font-size:12px}
.bt-wg-approval-recipients{display:flex;flex-wrap:wrap;gap:6px 12px}
.bt-wg-approval-recipient{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--bt-ink-2)}
.bt-wg-task-actions{display:flex;gap:8px;margin-top:6px}
.bt-wg-approve,.bt-wg-reject{height:28px;border-radius:999px;border:0;font-size:12px;padding:0 12px;cursor:pointer}
.bt-wg-approve{background:var(--bt-accent);color:var(--bt-accent-ink,#fff)}
.bt-wg-reject{background:var(--bt-hover);color:var(--bt-ink)}
.bt-wg-approve:hover{opacity:.88}
.bt-wg-reject:hover{background:var(--bt-active)}
.bt-wg-quote{display:flex;flex-direction:column;gap:1px;max-width:min(80%,560px);padding:4px 8px;border-left:2px solid var(--bt-line-2);color:var(--bt-ink-2);font-size:12px;line-height:16px;box-sizing:border-box}
.bt-wg-quote-who{color:var(--bt-ink-3)}
.bt-wg-quote-body{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-wg-replying{flex:none;display:flex;align-items:flex-start;gap:8px;margin:0 16px 8px;padding:8px 10px;border-left:2px solid var(--bt-accent);background:var(--bt-tag-bg);border-radius:6px}
.bt-wg-replying-text{flex:1;min-width:0}
.bt-wg-replying-who{font-size:12px;color:var(--bt-ink-2)}
.bt-wg-replying-body{font-size:13px;color:var(--bt-ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-wg-replying-drop{flex:none;border:0;background:none;color:var(--bt-ink-2);font-size:12px;padding:0;cursor:pointer}
.bt-wg-message-failed{font-size:12px;color:#e02135}
/* The failure text uses the shell's own danger class rather than a colour of its own: this layer is
   built on top of the team's styles, and introducing a second red would make the same kind of message
   look different depending on which surface showed it. */
.bt-wg-pending{flex:none;display:flex;flex-wrap:wrap;gap:6px;padding:8px 16px 0}
.bt-wg-pending-item{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:4px 10px;border-radius:999px;background:var(--bt-hover,rgba(0,0,0,.05));font-size:12px;color:var(--bt-ink-2)}
.bt-wg-pending-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-wg-pending-drop{border:0;background:transparent;color:var(--bt-ink-3);cursor:pointer;font-size:12px;padding:0}
.bt-wg-mentions{position:absolute;left:16px;right:16px;bottom:100%;margin-bottom:6px;max-height:220px;overflow-y:auto;background:var(--bt-panel,#fff);border:.5px solid var(--bt-line-weak);border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.12);padding:4px}
.bt-wg-mention{display:flex;align-items:baseline;gap:8px;width:100%;border:0;background:transparent;text-align:left;padding:7px 10px;border-radius:7px;cursor:pointer;font-size:13px;color:inherit}
.bt-wg-mention:hover{background:var(--bt-hover,rgba(0,0,0,.05))}
.bt-wg-mention-name{font-weight:500}
.bt-wg-mention-kind{margin-left:auto;font-size:11px;color:var(--bt-ink-3)}
.bt-wg-mention-empty{padding:8px 10px;font-size:12px;color:var(--bt-ink-3)}
.bt-wg-earlier{display:flex;justify-content:center;padding:10px 0 4px}
.bt-wg-earlier-failed{display:flex;justify-content:center;padding:10px 0 4px;font-size:12px;color:var(--bt-ink-3)}
.bt-react-add{position:relative;display:inline-flex}
.bt-react-strip{position:absolute;bottom:100%;right:0;margin-bottom:4px;display:flex;gap:2px;padding:4px;border-radius:10px;background:var(--bt-panel,#fff);border:.5px solid var(--bt-line-weak);box-shadow:0 6px 24px rgba(0,0,0,.12);z-index:4}
.bt-react-pick{border:0;background:transparent;cursor:pointer;font-size:15px;line-height:1;padding:5px 6px;border-radius:7px}
.bt-react-pick:hover{background:var(--bt-hover,rgba(0,0,0,.05))}
.bt-react[data-mine=true]{border-color:var(--bt-line-2);background:var(--bt-active)}
.bt-react-count{margin-left:3px;font-size:11px;color:var(--bt-ink-3)}
`

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
.bt-wg-memory-list{display:flex;flex-direction:column;gap:8px;margin:6px 0}
.bt-wg-memory{border:.5px solid var(--bt-line-2);border-radius:10px;background:var(--bt-card);padding:8px 10px;display:flex;flex-direction:column;gap:4px}
.bt-wg-memory-body{font-size:13px;line-height:19px;white-space:pre-wrap;word-break:break-word}
.bt-wg-memory-meta{display:flex;flex-wrap:wrap;gap:6px;font-size:11px;color:var(--bt-ink-3)}
.bt-wg-inline-error{margin:0 18px}
.bt-wg-compose{position:relative;flex:none;display:flex;flex-direction:column;gap:6px;padding:8px 16px 14px;border-top:.5px solid var(--bt-line-weak)}
.bt-wg-compose>.bt-wg-attach-input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
.bt-wg-compose-card{display:flex;align-items:flex-end;gap:4px;padding:5px 6px 5px 6px;border-radius:20px;border:.5px solid var(--bt-line-2);background:var(--bt-card);box-shadow:0 1px 2px rgba(0,0,0,.04)}
.bt-wg-compose-card .bt-plus{flex:none;width:32px;height:32px;border:0;border-radius:999px;background:transparent;color:var(--bt-ink-2);display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.bt-wg-compose-card .bt-plus:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-wg-compose-card .bt-wg-input{flex:1;min-height:32px;max-height:160px;resize:none;box-sizing:border-box;border:0;background:transparent;color:var(--bt-ink);font:inherit;line-height:20px;padding:6px 4px}
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
`

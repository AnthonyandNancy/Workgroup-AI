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

export const WORKGROUP_UI_CSS = `
.bt-wg{flex:1;min-height:0;display:flex;flex-direction:column;font-size:14px;color:var(--bt-ink)}
.bt-wg-body{flex:1;min-height:0;display:flex}
.bt-wg-main{flex:1;min-width:0;display:flex;flex-direction:column}
.bt-wg-head{position:relative;height:56px;flex:none;display:flex;justify-content:center;align-items:center;gap:8px;padding:0 16px;border-bottom:.5px solid var(--bt-line)}
.bt-wg-pill{max-width:70%}
.bt-wg-unread{flex:none;min-width:18px;height:18px;border-radius:999px;background:var(--bt-accent);color:var(--bt-accent-ink,#fff);font-size:11px;line-height:18px;text-align:center;padding:0 5px;box-sizing:border-box}
.bt-wg-gear{position:absolute;right:14px;top:50%;transform:translateY(-50%);flex:none}
.bt-wg-hub-dot{flex:none;width:7px;height:7px;border-radius:999px;background:var(--bt-ink-3)}
.bt-wg-hub-dot-live{background:var(--bt-green)}
.bt-wg-hub-dot-offline,.bt-wg-hub-dot-refused,.bt-wg-hub-dot-signed-out,.bt-wg-hub-dot-absent{background:var(--bt-ink-3)}
.bt-wg-hub-dot-unknown{background:var(--bt-line-2)}
.bt-wg-notice-bar{flex:none;margin:8px 16px 0;padding:8px 12px;border-radius:10px;background:var(--bt-tag-bg);color:var(--bt-ink-2);font-size:12px;line-height:18px;white-space:pre-wrap;max-height:96px;overflow:auto}
.bt-wg-thread{flex:1;min-height:0;overflow-y:auto;padding:16px 18px 8px;display:flex;flex-direction:column;gap:2px}
.bt-wg-day{align-self:center;margin:12px 0 4px;font-size:11px;color:var(--bt-ink-3);padding:2px 8px;border-radius:999px;background:var(--bt-tag-bg)}
.bt-wg-line{display:flex;flex-direction:column;gap:2px}
.bt-wg-message-text{white-space:pre-wrap;word-break:break-word}
.bt-uattach-image{display:inline-flex;max-width:240px;padding:0;border:0;background:transparent;cursor:pointer}
.bt-uattach-img{display:block;max-width:240px;max-height:240px;border-radius:12px;object-fit:cover}
.bt-uattach-image-name{display:inline-flex;align-items:center;min-height:40px;padding:6px 12px;border-radius:12px;border:.5px solid var(--bt-line-2);background:var(--bt-card);font-size:13px;color:var(--bt-ink-2)}
.bt-group-name .bt-human-face{margin-right:6px;vertical-align:-5px}
.bt-human-face{display:inline-flex;align-items:center;justify-content:center;flex:none;border-radius:999px;background:var(--bt-tag-bg);color:var(--bt-tag-ink);font-weight:600;line-height:1;user-select:none}
.bt-human-face-sm{width:22px;height:22px;font-size:11px}
.bt-wg-drawer{flex:none;width:min(360px,42%);min-width:280px;display:flex;flex-direction:column;border-left:.5px solid var(--bt-line);background:var(--bt-main);overflow:hidden}
.bt-wg-drawer>.bt-drawer-body{flex:1;min-height:0;overflow-y:auto;padding:12px 14px 20px}
.bt-wg-details{gap:6px}
.bt-wg-memory-list{display:flex;flex-direction:column;gap:8px;margin:6px 0}
.bt-wg-memory{border:.5px solid var(--bt-line-2);border-radius:10px;background:var(--bt-card);padding:8px 10px;display:flex;flex-direction:column;gap:4px}
.bt-wg-memory-body{font-size:13px;line-height:19px;white-space:pre-wrap;word-break:break-word}
.bt-wg-memory-meta{display:flex;flex-wrap:wrap;gap:6px;font-size:11px;color:var(--bt-ink-3)}
.bt-wg-inline-error{margin:0 18px}
.bt-wg-compose{position:relative;flex:none;display:flex;flex-direction:column;gap:6px;padding:8px 16px 14px;border-top:.5px solid var(--bt-line-weak)}
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
.bt-wg-create-pane{display:flex;align-items:flex-start;justify-content:center;padding:48px 16px}
.bt-wg-create{width:min(560px,100%);display:flex;flex-direction:column;gap:12px;padding:18px 18px 14px;border-radius:18px;border:.5px solid var(--bt-line-2);background:var(--bt-main);box-shadow:0 12px 40px rgba(0,0,0,.14)}
.bt-wg-create-head{display:flex;align-items:center;gap:8px}
.bt-wg-create-title{font-weight:600;font-size:15px}
.bt-wg-create-head .bt-x{margin-left:auto}
.bt-wg-create-row{display:flex;flex-direction:column;gap:6px}
.bt-wg-create-invites{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.bt-wg-create-invites .bt-bs-input{flex:1;min-width:160px}
.bt-wg-create-foot{justify-content:flex-end;gap:8px}
.bt-wg-visibility{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--bt-ink-2);cursor:pointer}
.bt-wg-visibility input{accent-color:var(--bt-accent);margin:0}
.bt-wg-settings .bt-drawer-body{padding:12px 16px 20px}
@media (prefers-reduced-motion:reduce){.bt-wg-create{animation:none}}
`

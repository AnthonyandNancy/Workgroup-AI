// Styling for the workgroup view.
//
// Kept apart from the view so the rules can be read and checked without a DOM: the view imports
// React, this module imports nothing. A class the view renders with no rule here is invisible, so
// the two halves are matched by `test/workgroup-css.test.js`.
//
// The view reuses the original room chrome, so it reuses that chrome's class convention
// and its design tokens rather than restating either: a workgroup then follows the theme, the
// zoom, and the reduced-motion setting without this file carrying a second copy of any of them.
// Only `.bt-wg-pane`'s horizontal placement is inline, because it is the measured width of the
// overlay the pane stands in for.
export const WORKGROUP_CSS = `
.bt-wg-pane{box-sizing:border-box}
.bt-wg{flex:1;min-height:0;display:flex;flex-direction:column;font-size:14px;color:var(--bt-ink)}
.bt-wg-head{height:62px;flex:none;display:flex;align-items:center;gap:10px;padding:0 16px;border-bottom:.5px solid var(--bt-line)}
.bt-wg-name{font-weight:600;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-wg-unread{flex:none;min-width:18px;height:18px;border-radius:999px;background:var(--bt-accent);color:var(--bt-accent-ink,#fff);font-size:11px;line-height:18px;text-align:center;padding:0 5px;box-sizing:border-box}
.bt-wg-gear{margin-left:auto;flex:none;height:32px;border-radius:999px;border:0;background:var(--bt-hover);color:var(--bt-ink);font-size:13px;padding:0 12px;cursor:pointer}
.bt-wg-gear:hover{background:var(--bt-active)}
.bt-wg-thread{flex:1;min-height:0;overflow-y:auto;padding:12px 16px;display:flex;flex-direction:column;gap:10px}
.bt-wg-empty{flex:1;display:flex;align-items:center;justify-content:center;padding:24px 32px;text-align:center;color:var(--bt-ink-2);font-size:13px;line-height:20px}
.bt-wg-message{display:flex;flex-direction:column;gap:4px;align-items:flex-start;max-width:100%}
.bt-wg-message-who{font-size:12px;color:var(--bt-ink-2)}
.bt-wg-message-body{max-width:min(80%,560px);background:var(--bt-bubble);border-radius:18px;padding:7px 12px;line-height:22px;overflow-wrap:anywhere}
.bt-wg-message-own{align-items:flex-end}
.bt-wg-message-own .bt-wg-message-body{background:var(--bt-user);color:var(--bt-user-ink)}
.bt-wg-message-failed{font-size:12px;color:#e02135}
.bt-wg-reply{align-self:flex-start;border:0;background:none;color:var(--bt-ink-3);font-size:12px;padding:0;cursor:pointer}
.bt-wg-message:hover .bt-wg-reply{color:var(--bt-ink-2);text-decoration:underline}
.bt-wg-quote{display:flex;flex-direction:column;gap:1px;max-width:min(80%,560px);padding:4px 8px;border-left:2px solid var(--bt-line-2);color:var(--bt-ink-2);font-size:12px;line-height:16px;box-sizing:border-box}
.bt-wg-quote-who{color:var(--bt-ink-3)}
.bt-wg-quote-body{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-wg-replying{flex:none;display:flex;align-items:flex-start;gap:8px;margin:0 16px 8px;padding:8px 10px;border-left:2px solid var(--bt-accent);background:var(--bt-tag-bg);border-radius:6px}
.bt-wg-replying-text{flex:1;min-width:0}
.bt-wg-replying-who{font-size:12px;color:var(--bt-ink-2)}
.bt-wg-replying-body{font-size:13px;color:var(--bt-ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-wg-replying-drop{flex:none;border:0;background:none;color:var(--bt-ink-2);font-size:12px;padding:0;cursor:pointer}
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
.bt-wg-compose{flex:none;display:flex;align-items:flex-end;gap:8px;padding:10px 16px 16px;border-top:.5px solid var(--bt-line-weak)}
.bt-wg-input{flex:1;min-height:40px;max-height:160px;resize:none;box-sizing:border-box;border-radius:12px;border:.5px solid var(--bt-line-2);background:var(--bt-card);color:var(--bt-ink);font:inherit;line-height:20px;padding:10px 12px}
.bt-wg-input::placeholder{color:var(--bt-placeholder,var(--bt-ink-3))}
.bt-wg-send{height:40px;flex:none;border-radius:999px;border:0;background:var(--bt-accent);color:var(--bt-accent-ink,#fff);font-size:14px;padding:0 20px;cursor:pointer;white-space:nowrap}
.bt-wg-send:disabled{opacity:.35;cursor:default}
/* The mention picker sits above the composer and takes no space until it opens, so the message the
   employee is typing does not shift when the trigger is pressed. */
/* What the next send will carry: a file the sender attached, or the reason attaching failed. */
.bt-wg-pending{flex:none;display:flex;flex-wrap:wrap;gap:6px;padding:8px 16px 0}
.bt-wg-pending-item{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:4px 10px;border-radius:999px;background:var(--bt-hover,rgba(0,0,0,.05));font-size:12px;color:var(--bt-ink-2)}
.bt-wg-pending-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-wg-pending-drop{border:0;background:transparent;color:var(--bt-ink-3);cursor:pointer;font-size:12px;padding:0}
/* The failure text uses the shell's own danger class rather than a colour of its own: this layer is
   built on top of the team's styles, and introducing a second red would make the same kind of message
   look different depending on which surface showed it. */
.bt-wg-pending-error{font-size:12px}
.bt-wg-mentions{position:absolute;left:16px;right:16px;bottom:100%;margin-bottom:6px;max-height:220px;overflow-y:auto;background:var(--bt-panel,#fff);border:.5px solid var(--bt-line-weak);border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.12);padding:4px}
.bt-wg-mention{display:flex;align-items:baseline;gap:8px;width:100%;border:0;background:transparent;text-align:left;padding:7px 10px;border-radius:7px;cursor:pointer;font-size:13px;color:inherit}
.bt-wg-mention:hover{background:var(--bt-hover,rgba(0,0,0,.05))}
.bt-wg-mention-name{font-weight:500}
.bt-wg-mention-kind{margin-left:auto;font-size:11px;color:var(--bt-ink-3)}
.bt-wg-mention-empty{padding:8px 10px;font-size:12px;color:var(--bt-ink-3)}
/* The attach control is a label over a hidden file input: the browser's own picker decides what may be
   read, and the employee never types a path. */
.bt-wg-attach{position:relative;flex:none;height:40px;display:inline-flex;align-items:center;padding:0 12px;border-radius:999px;border:.5px solid var(--bt-line-weak);font-size:13px;color:var(--bt-ink-2);cursor:pointer}
.bt-wg-attach:hover{background:var(--bt-hover,rgba(0,0,0,.05))}
.bt-wg-attach-input{position:absolute;inset:0;opacity:0;cursor:pointer}
.bt-wg-offline .bt-wg-empty{color:var(--bt-ink-2)}
.bt-wg-offline .bt-wg-name{color:var(--bt-ink-2)}
.bt-wg-settings{flex:1;min-height:0;overflow-y:auto}
.bt-wg-identity{flex:none;margin:12px 16px 0;padding:12px;border:.5px solid var(--bt-line-2);border-radius:10px;background:var(--bt-card)}
.bt-wg-identity-note{font-size:12px;color:var(--bt-ink-2);margin-bottom:8px}
.bt-wg-identity-row{display:flex;align-items:center;gap:8px;padding:3px 0}
.bt-wg-identity-label{flex:none;width:110px;font-size:12px;color:var(--bt-ink-3)}
.bt-wg-identity-value{flex:1;min-width:0;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;user-select:all}
.bt-wg-identity-copy{margin-top:8px;height:28px;border-radius:999px;border:0;background:var(--bt-hover);color:var(--bt-ink);font-size:12px;padding:0 12px;cursor:pointer}
.bt-wg-identity-copy:hover{background:var(--bt-active)}
`

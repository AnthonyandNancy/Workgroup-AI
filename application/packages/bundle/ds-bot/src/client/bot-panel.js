// The fork's first-level `Bot` navigation entry.
//
// Only the entry's glyph lives here, because the entry has no panel component of its own. Its
// id is the shell's reserved `conversation` main key, and that is what makes a click select the
// real Conversation — the real chat, with the real Session binding — instead of a private column
// that `ui-layout` would render without a Session. DS Bot's own replacements then land on that
// Conversation while the entry is active, and on nothing else.
//
// The sidebar owns the button, the label, and the selected state around this glyph, exactly as
// it does for every other first-level entry, so the fork adds no navigation chrome.

import { createElement as h } from 'react'

/** A whale mark, echoing the team's own brand mark so the entry reads as part of the product. */
export function BotPanelIcon(props) {
  const size = props?.size ?? 18
  return h('svg', {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
    'aria-hidden': true,
  },
    h('path', { d: 'M3 14c0-4.4 3.6-8 8-8h3.5a2.5 2.5 0 0 1 0 5H9' }),
    h('path', { d: 'M3 14c1.8 3.6 5.2 6 9 6 4.4 0 8-3.6 8-8' }),
    h('circle', { cx: 10.5, cy: 10, r: 0.9, fill: 'currentColor', stroke: 'none' }),
  )
}

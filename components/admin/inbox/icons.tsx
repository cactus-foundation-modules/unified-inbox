// Same stroke family as the rest of the admin (see ICON_PROPS in
// components/admin/AdminNav.tsx), so the inbox does not arrive wearing its own
// icon set. Every one is decorative: the words beside them carry the meaning,
// which is why they are all aria-hidden.

const ICON = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}

export const InboundIcon = <svg {...ICON}><path d="M12 5v11" /><path d="m6.5 10.5 5.5 5.5 5.5-5.5" /><path d="M4 19h16" /></svg>
export const OutboundIcon = <svg {...ICON}><path d="M12 19V8" /><path d="m6.5 13.5 5.5-5.5 5.5 5.5" /><path d="M4 5h16" /></svg>
export const NoteIcon = <svg {...ICON}><path d="M5 4h14v12l-4 4H5z" /><path d="M15 20v-4h4" /></svg>
export const PaperclipIcon = <svg {...ICON}><path d="M17 7.5 9.5 15a2.5 2.5 0 0 0 3.5 3.5l7-7a4.5 4.5 0 0 0-6.4-6.3L6 12.8a6.5 6.5 0 0 0 9.2 9.2" /></svg>
export const ClockIcon = <svg {...ICON}><circle cx="12" cy="12" r="8" /><path d="M12 7.5V12l3 2" /></svg>
export const TickIcon = <svg {...ICON}><path d="m5 12.5 4.5 4.5L19 7" /></svg>
export const SearchIcon = <svg {...ICON}><circle cx="11" cy="11" r="6" /><path d="m20 20-4.5-4.5" /></svg>
export const BackIcon = <svg {...ICON}><path d="M15 5 8 12l7 7" /></svg>

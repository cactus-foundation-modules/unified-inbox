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
export const PenIcon = <svg {...ICON}><path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></svg>
export const MailIcon = <svg {...ICON}><path d="M3 6.5h18v11H3z" /><path d="m3 7 9 6 9-6" /></svg>
export const ChatIcon = <svg {...ICON}><path d="M4 5h16v11H9l-5 3z" /></svg>
export const PhoneIcon = <svg {...ICON}><path d="M6 4h3l1.5 4-2 1.5a11 11 0 0 0 5 5L15 12l4 1.5V17a2 2 0 0 1-2.2 2A15 15 0 0 1 4 6.2 2 2 0 0 1 6 4" /></svg>
export const FormIcon = <svg {...ICON}><path d="M5 4h14v16H5z" /><path d="M8.5 9h7" /><path d="M8.5 13h7" /><path d="M8.5 17h3.5" /></svg>
export const InboxIcon = <svg {...ICON}><path d="M4 13 6 5h12l2 8v6H4z" /><path d="M4 13h4l1 2.5h6L16 13h4" /></svg>
export const RefreshIcon = <svg {...ICON}><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" /><path d="M19.5 3.5V9H14" /></svg>
export const CloseIcon = <svg {...ICON}><path d="m6 6 12 12" /><path d="m18 6-12 12" /></svg>

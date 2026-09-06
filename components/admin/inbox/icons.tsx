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
export const PeopleIcon = <svg {...ICON}><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" /><path d="M16 5.5a3 3 0 0 1 0 5.6" /><path d="M17.5 13.5A5.5 5.5 0 0 1 20.5 19" /></svg>
export const SendIcon = <svg {...ICON}><path d="M20 4 3.5 10.5l6.5 2.5 2.5 6.5z" /><path d="m10 13 10-9" /></svg>
export const FileIcon = <svg {...ICON}><path d="M6 3h7l5 5v13H6z" /><path d="M13 3v5h5" /></svg>
export const MegaphoneIcon = <svg {...ICON}><path d="M4 10v4h3l7 4V6l-7 4z" /><path d="M17 9.5a3.5 3.5 0 0 1 0 5" /><path d="M7 14v4h3" /></svg>
export const FolderIcon = <svg {...ICON}><path d="M3 6h6l2 2.5h10V19H3z" /></svg>
export const ReplyIcon = <svg {...ICON}><path d="M9 7 4 12l5 5" /><path d="M4 12h9a6 6 0 0 1 6 6v1" /></svg>
export const FilterIcon = <svg {...ICON}><path d="M4 7h13" /><path d="M4 12h9" /><path d="M4 17h5" /></svg>
export const SortIcon = <svg {...ICON}><path d="M7 20V4" /><path d="m3.5 7.5 3.5-3.5 3.5 3.5" /><path d="M17 4v16" /><path d="m13.5 16.5 3.5 3.5 3.5-3.5" /></svg>
export const ChevronDownIcon = <svg {...ICON}><path d="m6 9.5 6 6 6-6" /></svg>
export const SmsIcon = <svg {...ICON}><path d="M4 5h16v10H9l-5 3z" /><path d="M8.5 10h.01" /><path d="M12 10h.01" /><path d="M15.5 10h.01" /></svg>
export const AssignedIcon = <svg {...ICON}><circle cx="12" cy="8" r="3.2" /><path d="M5.5 19a6.5 6.5 0 0 1 13 0" /></svg>
export const MoreIcon = <svg {...ICON}><circle cx="12" cy="5.5" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="18.5" r="1.4" fill="currentColor" stroke="none" /></svg>
export const AlarmIcon = <svg {...ICON}><circle cx="12" cy="13" r="7" /><path d="M12 9.5V13l2.5 1.5" /><path d="m4 6 3-2.5" /><path d="m20 6-3-2.5" /></svg>
export const ChevronRightIcon = <svg {...ICON}><path d="m9.5 6 6 6-6 6" /></svg>
export const ChevronLeftIcon = <svg {...ICON}><path d="m14.5 6-6 6 6 6" /></svg>
export const AtIcon = <svg {...ICON}><circle cx="12" cy="12" r="3.4" /><path d="M15.4 8.6v4.7a2.6 2.6 0 0 0 5.1 0V12a8.5 8.5 0 1 0-3.3 6.7" /></svg>
/** Take the box out of the page and put it in front of everything, and put it
 *  back again. The same diagonal, pointing the other way. */
export const ExpandIcon = <svg {...ICON}><path d="M14 5h5v5" /><path d="M19 5l-7 7" /><path d="M10 19H5v-5" /><path d="m5 19 7-7" /></svg>
export const CollapseIcon = <svg {...ICON}><path d="M19 10h-5V5" /><path d="m14 10 5-5" /><path d="M5 14h5v5" /><path d="m10 14-5 5" /></svg>
/** The six things the writing box can do to a selection. B and I are drawn as
 *  letters rather than as icons - every mail program in the world draws them
 *  that way, and a glyph for "bold" is a glyph nobody recognises. */
export const LinkIcon = <svg {...ICON}><path d="M10.5 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1.5 1.5" /><path d="M13.5 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1.5-1.5" /></svg>
export const ListIcon = <svg {...ICON}><path d="M9 6.5h11" /><path d="M9 12h11" /><path d="M9 17.5h11" /><circle cx="4.75" cy="6.5" r="1.1" fill="currentColor" stroke="none" /><circle cx="4.75" cy="12" r="1.1" fill="currentColor" stroke="none" /><circle cx="4.75" cy="17.5" r="1.1" fill="currentColor" stroke="none" /></svg>
export const NumberedListIcon = <svg {...ICON}><path d="M9.5 6.5h10.5" /><path d="M9.5 12h10.5" /><path d="M9.5 17.5h10.5" /><path d="M3.6 4.6h1.1v3.6" /><path d="M3.4 10.6a1.1 1.1 0 0 1 1.9.8c0 .8-1.9 1.6-1.9 2.4h2.1" /><path d="M3.5 16.1h1.9l-1.1 1.4a1.1 1.1 0 1 1-.8 1.9" /></svg>
export const PaletteIcon = <svg {...ICON}><path d="M12 4a8 8 0 1 0 0 16 2 2 0 0 0 1.6-3.2 2 2 0 0 1 1.6-3.2H18a3 3 0 0 0 3-3A7.8 7.8 0 0 0 12 4" /><circle cx="8" cy="11" r="1" fill="currentColor" stroke="none" /><circle cx="11.5" cy="8" r="1" fill="currentColor" stroke="none" /><circle cx="15.5" cy="9.5" r="1" fill="currentColor" stroke="none" /></svg>

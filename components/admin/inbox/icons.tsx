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
// A price tag: what the site sells, for putting one on a message.
export const TagIcon = <svg {...ICON}><path d="M11 3H4v7l10 10 7-7L11 3Z" /><circle cx="7.5" cy="7.5" r="1.2" /></svg>
export const ClockIcon = <svg {...ICON}><circle cx="12" cy="12" r="8" /><path d="M12 7.5V12l3 2" /></svg>
export const TickIcon = <svg {...ICON}><path d="m5 12.5 4.5 4.5L19 7" /></svg>
export const SearchIcon = <svg {...ICON}><circle cx="11" cy="11" r="6" /><path d="m20 20-4.5-4.5" /></svg>
// Three lines: the places to go, folded away behind one button on a phone.
export const MenuIcon = <svg {...ICON}><path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h16" /></svg>
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
/** Junk. A "no entry" sign: a ring with a bar through it. It was a waste
 *  basket, on the reasoning that every mail program draws one - but a basket in
 *  a row of controls is read as Delete by everybody who has ever used a
 *  computer, and a control nobody dares press is the same as no control at all.
 *  The sign says refused rather than destroyed, which is what the press does.
 *
 *  It is therefore close to BlockIcon below, and the two must never appear
 *  beside one another without words: give the block its own drawing first if
 *  that day comes.
 *
 *  LATER: the basket now sits immediately to the left of this sign, as BinIcon,
 *  and the split above turned out to be exactly right. There are two acts on
 *  that row and they are different acts - refuse it, or throw it away - so the
 *  basket means the second one and nothing else, and this sign is free to keep
 *  meaning the first. */
export const SpamIcon = <svg {...ICON}><circle cx="12" cy="12" r="8" /><path d="m6.7 17.3 10.6-10.6" /></svg>
/** The bin. A waste basket, which is what every program in the world draws for
 *  "delete" - and here it genuinely means it: what goes in can be emptied out
 *  for good, which is the one thing on this screen that is not undoable. It
 *  reads as Delete to everybody who has ever used a computer, and this is the
 *  one control on the row where that reading is the correct one. */
export const BinIcon = <svg {...ICON}><path d="M4.5 7h15" /><path d="M9.5 7V4.5h5V7" /><path d="M6.6 7l.9 12.5h9L17.4 7" /><path d="M10.2 10.5v6" /><path d="M13.8 10.5v6" /></svg>
/** Emptying it: the same basket with its lid off and nothing inside. The lid is
 *  what carries the meaning at 16px - a basket with a straight lid is the
 *  button that fills it, and a basket with a tilted one is the button that
 *  empties it - so the two are told apart at a glance rather than by hovering
 *  and reading. */
export const EmptyBinIcon = <svg {...ICON}><path d="m4.4 8.6 15.2-2.7" /><path d="m9.7 7.7-.4-2.4 4.9-.9.4 2.4" /><path d="M6.9 9.4h10.2l-.9 10.6H7.8z" /></svg>
/** Turning somebody away at the door - the block, as opposed to the junk sign
 *  above. Not currently drawn anywhere; see the warning on SpamIcon before
 *  putting it on a screen that also carries one. */
export const BlockIcon = <svg {...ICON}><circle cx="12" cy="12" r="8" /><path d="m6.5 6.5 11 11" /></svg>
/** The list of addresses the site turns away. An @ with a bar through it: the
 *  @ says these are addresses rather than conversations, and the bar says what
 *  is being done to them. Deliberately NOT the sign above or BlockIcon below -
 *  the Spam folder draws the junk sign on every conversation in it, and a
 *  second ring-with-a-line in the toolbar over that list is two different
 *  buttons wearing one drawing. */
export const BlockedAddressesIcon = <svg {...ICON}><circle cx="12" cy="12" r="3.2" /><path d="M15.2 8.8v4.6a2.5 2.5 0 0 0 4.9 0V12a8.1 8.1 0 1 0-3.2 6.5" /><path d="m5 19 14-14" /></svg>
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
/** A nudge from the browser when post arrives, and the same bell with a line
 *  through it for the press that turns them off. A bell is what every program
 *  in the world draws for this, which makes it the one drawing nobody has to
 *  learn - and the struck-through pair reads as one switch rather than two
 *  buttons. */
export const BellIcon = <svg {...ICON}><path d="M6 9a6 6 0 0 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 13 6 9Z" /><path d="M10 18a2 2 0 0 0 4 0" /></svg>
export const BellOffIcon = <svg {...ICON}><path d="M6 9a6 6 0 0 1 8.4-5.5" /><path d="M18 9c0 4 1.5 5.5 1.5 5.5h-12" /><path d="M10 18a2 2 0 0 0 4 0" /><path d="m4 4 16 16" /></svg>
/** The two halves of read and unread, for the bar over a picked pile. A sealed
 *  envelope has meant "not read yet" for as long as there have been mail
 *  programs, so the open one is the press that marks a pile read and the sealed
 *  one with the dot is the press that puts them back. Drawn as a pair on
 *  purpose: side by side in a bar, the difference has to be legible at 16px,
 *  and a flap up against a flap down is the only difference small enough to
 *  read at a glance. */
export const MailOpenIcon = <svg {...ICON}><path d="M3 10.5 12 4l9 6.5v9H3z" /><path d="m3 10.5 9 6 9-6" /></svg>
export const MailSealedIcon = <svg {...ICON}><path d="M3 6.5h18v11H3z" /><path d="m3 7 9 6 9-6" /><circle cx="18.5" cy="6" r="2.5" fill="currentColor" stroke="none" /></svg>
/** Out of the bin again, for the one bulk press the Bin folder offers. An arrow
 *  coming back out of the basket rather than a plain undo curl: the curl is
 *  what the toast already uses for "take that press back", and these are two
 *  different acts - one is regret, this one is a decision. */
export const RestoreIcon = <svg {...ICON}><path d="M4.5 7h15" /><path d="M6.6 7l.9 12.5h9L17.4 7" /><path d="M12 17V9.5" /><path d="m8.8 12.7 3.2-3.2 3.2 3.2" /></svg>
/** Several conversations folded into one. Two lines running into a third,
 *  which is what a merge does and what every version-control program in the
 *  world draws for it. */
export const MergeIcon = <svg {...ICON}><path d="M6 4v4.5c0 2 1.6 3.5 3.5 3.5H18" /><path d="M6 20v-4.5c0-2 1.6-3.5 3.5-3.5" /><path d="m14.5 8.5 3.5 3.5-3.5 3.5" /></svg>
/** A handset with a screen, for the channels that live on somebody's phone
 *  rather than on the telephone network - WhatsApp and its like. Deliberately
 *  not a brand mark: the rail draws whatever channels a site has installed, and
 *  a green speech bubble in one row and a plain stroke in the next reads as two
 *  different kinds of thing. */
export const SmartphoneIcon = <svg {...ICON}><rect x="7" y="3" width="10" height="18" rx="2" /><path d="M10.5 6.2h3" /><path d="M11 18h2" /></svg>

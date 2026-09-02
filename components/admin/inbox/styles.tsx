// The reading screen's stylesheet, carried with the module.
//
// It is a real stylesheet rather than inline styles for two reasons: the screen
// has to fold down to one column on a phone, and the conversation list changes
// shape according to how much room it has been given rather than how wide the
// window is - and neither a media query nor a container query can be written as
// a style attribute. Everything in it is a semantic token, so the whole screen
// follows the admin into dark mode with no second palette and nothing to keep in
// step. No hex values: a colour written here is a colour that is wrong in one of
// the two themes.
//
// Every class is prefixed `uin-`, because this stylesheet is loaded into a page
// core owns and shares with whatever else is installed.
//
// ONE TRAP, AND IT HAS CAUGHT EVERY PASS OVER THIS FILE SO FAR. In dark mode
// core defines --color-bg-subtle and --color-surface as the SAME colour,
// #1c1a17 (app/globals.css:225-226). A tint painted in --color-bg-subtle on
// anything whose ground is --color-surface is therefore completely invisible on
// every site running dark - the hover does nothing, the tint does nothing, and
// it all looks perfectly fine in light mode while you are writing it. Light mode
// has the mirror of it: --color-bg and --color-surface-raised are both sand-50,
// so those two cannot be laid on each other either.
// The pairs that genuinely differ in BOTH themes, and are therefore the only
// ones worth painting one on the other:
//     surface / surface-raised      surface / bg
//     bg      / bg-subtle           surface-raised / bg-subtle
// So: a tint on a card is --color-surface-raised, and a tint on THAT is
// --color-bg-subtle. Before adding any background here, find the ground it
// lands on and check it against that list. Grep this file for
// --color-surface-raised to see the pattern already in use.

const CSS = `
/* ---- the tabs along the top -------------------------------------------- */
/* The label inside core's tab. It is stretched back over the tab's own padding
   with negative margins, so taking hold anywhere on an address picks up the
   address rather than picking up its link. */
.uin-tab {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  margin: -0.625rem -1rem;
  padding: 0.625rem 1rem;
  min-width: 0;
}
.uin-tab-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* A tinted chip rather than a solid primary pill: white on the primary green
   measures 3.61:1, which is under AA for text this small, and a count nobody can
   read is not a count. */
.uin-tab-count {
  flex: none;
  font-size: 0.6875rem;
  font-weight: 700;
  line-height: 1.4;
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  background: var(--color-primary-subtle);
  border: 1px solid var(--color-primary-border);
  color: var(--color-text);
}
/* The status tabs count everything under them rather than only what is new, so
   their numbers are furniture beside the addresses' unread counts and are
   dressed down to say so. */
.uin-tab-count-quiet {
  background: var(--color-bg-subtle);
  border-color: var(--color-border);
  color: var(--color-text-secondary);
  font-weight: 600;
}
/* Rearranging the addresses. The grab cursor is the only thing that says so
   until somebody takes hold of one - a row of handles would put furniture beside
   every address to serve a job done once a year. While one is in the air it
   fades, and the address it would land on carries a line down its leading edge,
   so the answer to "where does this go" is on the screen rather than in the
   wrist. */
.uin-tab[data-uin-drag] { cursor: grab; }
.uin-tab[data-uin-drag]:active { cursor: grabbing; }
.uin-tab[data-uin-dragging] { opacity: 0.45; }
.uin-tab[data-uin-over] { box-shadow: inset 2px 0 0 0 var(--color-primary); }
@media (prefers-reduced-motion: reduce) {
  .uin-tab[data-uin-dragging] { opacity: 0.7; }
}

/* Write a message rides at the end of the tab row rather than among the tabs,
   because it is the one thing up there that is not a place to go. Its own
   colours are spelled out rather than borrowed from .btn-primary: white on the
   primary green measures 3.61:1, which is under AA, and this button carries
   words. */
.uin-compose {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  padding: 0.4rem 0.75rem;
  border-radius: 0.375rem;
  border: 1px solid var(--color-primary-border);
  background: var(--color-primary-subtle);
  color: var(--color-text);
  font-size: 0.875rem;
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
}
.uin-compose:hover {
  border-color: var(--color-primary);
  background: var(--color-surface-raised);
  color: var(--color-text);
  text-decoration: none;
}
/* On a narrow window the words go and the pen stands for them. The button keeps
   its name either way - it is on the link itself, not in the text. */
@media (max-width: 599px) {
  .uin-compose-words { display: none; }
}

/* ---- fetching new mail, at the head of the addresses -------------------- */
/* The button sits beside core's tab strip rather than inside it, because the
   strip takes tabs and one trailing slot and this is neither. It carries the
   strip's own bottom border and bottom margin, so the line under the addresses
   runs unbroken across it - which is the whole of what makes it read as part of
   the row rather than as something parked in front of it. */
.uin-tabrow { display: flex; align-items: stretch; }
.uin-tabrow-strip { flex: 1; min-width: 0; }
.uin-refresh {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 0.6rem;
  margin-bottom: 0.5rem;
  border: 0;
  border-bottom: 1px solid var(--color-border);
  background: none;
  color: var(--color-text-muted);
  font-family: inherit;
  cursor: pointer;
}
.uin-refresh:hover:not(:disabled) { color: var(--color-primary); }
.uin-refresh:disabled { cursor: default; opacity: 0.55; }
.uin-refresh svg { display: block; }
.uin-refresh[data-busy="1"] svg { animation: uin-spin 0.9s linear infinite; }
@keyframes uin-spin { to { transform: rotate(360deg); } }
/* A spinner is decoration, and decoration that moves is a problem for some
   readers. The button still says it is busy, in words, to a screen reader. */
@media (prefers-reduced-motion: reduce) {
  .uin-refresh[data-busy="1"] svg { animation: none; }
}

/* ---- somebody else's draft, open for reading --------------------------- */
/* Label beside value rather than above it: there are three of them at most and
   a stack of six lines for To, Cc and Subject reads as a form somebody forgot
   to make editable. */
.uin-draft-read {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.25rem 0.75rem;
  margin: 0 0 0.75rem;
  font-size: 0.875rem;
}
.uin-draft-read dt { color: var(--color-text-muted); }
.uin-draft-read dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }

/* ---- the search box, at the end of the status tabs ---------------------- */
.uin-search { display: flex; gap: 0.375rem; align-items: center; }
.uin-search input { min-width: 0; width: 9rem; }
@media (min-width: 700px) {
  .uin-search input { width: 15rem; }
}

/* ---- the narrower cuts ------------------------------------------------- */
.uin-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
  margin-bottom: 0.875rem;
}
.uin-toolbar-form { display: flex; gap: 0.375rem; align-items: center; }
.uin-toolbar-form select { min-width: 0; }
/* Pushed to the far end so the count reads as an answer to the row rather than
   as one more thing to press. */
.uin-toolbar-count {
  margin-left: auto;
  font-size: 0.8125rem;
  color: var(--color-text-muted);
  white-space: nowrap;
}
.uin-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.25rem 0.6rem;
  border-radius: 999px;
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-size: 0.8125rem;
  text-decoration: none;
}
.uin-chip:hover { border-color: var(--color-border-strong); color: var(--color-text); text-decoration: none; }
.uin-chip[aria-pressed="true"],
.uin-chip[aria-current="true"] {
  background: var(--color-primary-subtle);
  border-color: var(--color-primary-border);
  color: var(--color-text);
  font-weight: 600;
}
/* The chip that says what was searched for and takes the search off again. The
   two halves are told apart on purpose: the term is allowed to run out of room
   and end in an ellipsis, the cross beside it is not, because a search nobody
   can clear is a search somebody is stuck with. */
.uin-chip-clear { max-width: 22rem; overflow: hidden; white-space: nowrap; }
.uin-chip-clear-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uin-chip-clear-x { flex: none; font-size: 1rem; line-height: 1; }

/* ---- the workspace ------------------------------------------------------ */
/* Nothing open: the list has the whole width, which is what a list of everything
   waiting is for. Open one and the screen splits, and splits again on a wide
   window to put what the rest of the site knows about them beside it. */
.uin {
  display: grid;
  gap: 1rem;
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
}
/* From a tablet up, with something open, the workspace stops being a stack of
   blocks on a page that scrolls and becomes a frame the height of the screen
   with each pane scrolling inside it.
   That is not decoration. The old arrangement stuck the list to the page and
   let the context panel run the full width underneath it, so the two shared
   ground: a stuck pane is a positioned pane, it paints over whatever it lands
   on, and the panel below came out sliced down the list's right edge. Nothing
   in here is stuck to the page any more - the frame is, and only until the tabs
   above it have scrolled away - so no pane can be painted over another. */
@media (min-width: 900px) {
  .uin[data-thread="open"] {
    position: sticky;
    top: 0.75rem;
    height: calc(100vh - 1.5rem);
    height: calc(100svh - 1.5rem);
    min-height: 24rem;
    align-items: stretch;
    grid-template-columns: minmax(16rem, min(22rem, 34%)) minmax(0, 1.7fr);
    grid-template-rows: minmax(0, 1fr);
  }
  /* A grid item will not scroll its own overflow unless it is allowed to be
     shorter than its contents, which is what the two minimums are for. */
  .uin[data-thread="open"] > * {
    min-width: 0;
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
  }
  /* Below the wide breakpoint the context panel goes under the conversation
     rather than beside it, and stays in the conversation's column. Squeezing a
     third column into 900px leaves the conversation too narrow to read, and the
     conversation is what somebody came here for. Full width would put it under
     the list, which is where it used to end up half hidden behind it. */
  .uin[data-thread="open"][data-context="on"] {
    grid-template-rows: minmax(0, 1fr) fit-content(40%);
  }
  .uin[data-thread="open"][data-context="on"] > .uin-listpane {
    grid-column: 1;
    grid-row: 1 / -1;
  }
  .uin[data-thread="open"][data-context="on"] > .uin-thread,
  .uin[data-thread="open"][data-context="on"] > .uin-empty {
    grid-column: 2;
    grid-row: 1;
  }
  .uin[data-thread="open"][data-context="on"] > .uin-ctx {
    grid-column: 2;
    grid-row: 2;
  }
}
/* Room for all three side by side, each scrolling its own contents. */
@media (min-width: 1400px) {
  .uin[data-thread="open"][data-context="on"] {
    grid-template-columns:
      minmax(15rem, min(20rem, 22%))
      minmax(0, 1.7fr)
      minmax(15rem, min(20rem, 22%));
    grid-template-rows: minmax(0, 1fr);
  }
  .uin[data-thread="open"][data-context="on"] > .uin-listpane {
    grid-column: 1;
    grid-row: 1;
  }
  .uin[data-thread="open"][data-context="on"] > .uin-ctx {
    grid-column: 3;
    grid-row: 1;
  }
}

/* ---- the list ----------------------------------------------------------- */
/* One card with lines between the rows rather than a stack of little cards: a
   list of forty is read down, and forty separate outlines is forty things to
   look at instead of one. */
.uin-listpane {
  min-width: 0;
  border: 1px solid var(--color-border);
  border-radius: 0.625rem;
  background: var(--color-surface);
  overflow: hidden;
  /* A row lays itself out by how much room the list has been given, not by how
     wide the window is - the same list is the whole screen with nothing open and
     a column beside a conversation once something is. The container is named so
     that a query written for the list cannot be answered by some other box that
     happens to sit in between. */
  container: uin-list / inline-size;
}
.uin-list { display: block; list-style: none; margin: 0; padding: 0; }
/* Three tracks: who it is beside, what it says, and the trimmings. The last one
   is capped rather than left to size itself, because "auto" means "as wide as
   the widest badge in it" and a badge would happily take three hundred pixels
   off the subject line and leave fourteen characters of it. A name on a badge
   is worth less than the subject of the message. */
.uin-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) minmax(0, 7rem);
  gap: 0.1rem 0.625rem;
  align-items: start;
  padding: 0.4rem 0.75rem;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
  text-decoration: none;
  color: var(--color-text);
}
.uin-list > li:last-child .uin-row { border-bottom: 0; }
.uin-row:hover { background: var(--color-surface-raised); text-decoration: none; }
.uin-row[aria-current="true"] {
  background: var(--color-primary-subtle);
  box-shadow: inset 3px 0 0 0 var(--color-primary);
}
/* Muted grey clears AA on the ordinary surface but not on the tinted ones the
   open row and the hovered row sit on - it measures 4.28:1 on raised in dark,
   under AA - so their secondary text steps up a tier. */
.uin-row[aria-current="true"] .uin-row-preview,
.uin-row[aria-current="true"] .uin-row-meta,
.uin-row:hover .uin-row-preview,
.uin-row:hover .uin-row-meta { color: var(--color-text-secondary); }

.uin-avatar-wrap { position: relative; flex: none; }
.uin-avatar {
  width: 2rem; height: 2rem; border-radius: 999px;
  display: grid; place-items: center;
  background: var(--color-surface-raised);
  border: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  font-size: 0.6875rem; font-weight: 700;
}
/* Which channel a conversation arrived by, on the corner of the circle. The
   badge carries its name for a screen reader; it is never the only thing saying
   what this is, since the conversation itself says so at the top. */
.uin-avatar-badge {
  position: absolute;
  right: -0.15rem;
  bottom: -0.15rem;
  width: 0.95rem;
  height: 0.95rem;
  border-radius: 999px;
  display: grid;
  place-items: center;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  color: var(--color-text-secondary);
}
.uin-avatar-badge svg { width: 0.7rem; height: 0.7rem; }

/* Three lines with the air taken out of them. A list is read down forty at a
   time, and every spare pixel of leading is a conversation somebody has to
   scroll for. The row still stands well over the 44px a thumb needs. */
.uin-row-main { min-width: 0; display: grid; gap: 0.05rem; }
.uin-row-who { display: flex; gap: 0.4rem; align-items: center; min-width: 0; }
.uin-row-name {
  font-size: 0.875rem;
  line-height: 1.3;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.uin-row-name-unread { font-weight: 700; }
/* Unread is said three ways over - a dot, the weight of the name, and a word for
   a screen reader - because a single tinted pixel is not a state anybody should
   have to notice. */
.uin-row-dot {
  flex: none;
  width: 0.45rem; height: 0.45rem;
  border-radius: 999px;
  background: var(--color-primary);
}
.uin-row-subject {
  font-size: 0.875rem;
  line-height: 1.3;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.uin-row-unread .uin-row-subject { font-weight: 600; }
.uin-row-preview {
  font-size: 0.8125rem;
  line-height: 1.3;
  color: var(--color-text-muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.uin-row-meta {
  display: grid;
  justify-items: end;
  gap: 0.2rem;
  min-width: 0;
  font-size: 0.75rem;
  line-height: 1.3;
  color: var(--color-text-muted);
  white-space: nowrap;
}
/* One line of badges, never two, and the ones that say what happened to the
   message come before the ones that say whose desk it is on - so when there is
   not room for all of them it is a name that goes short rather than "It did not
   send". */
.uin-row-tags {
  display: flex;
  gap: 0.25rem;
  flex-wrap: nowrap;
  justify-content: flex-start;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
}
.uin-row-tags > * { flex: none; max-width: 100%; overflow: hidden; }

/* Given room, a row reads across in one line the way a mail program does: who,
   what it is about, how it began, when. Stacked when the list is a column beside
   an open conversation. Every
   track is a share of what there is rather than a fixed measure, so the four of
   them grow and shrink together: at no width does one of them hold its ground
   while the one beside it is cut to fourteen characters. */
@container uin-list (min-width: 46rem) {
  .uin-row {
    grid-template-columns:
      auto
      minmax(0, 1.1fr)
      minmax(0, 1.5fr)
      minmax(0, 1.4fr)
      minmax(0, 1.2fr);
    align-items: center;
    gap: 0.625rem;
  }
  .uin-row-main { display: contents; }
  .uin-row-meta {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.5rem;
    overflow: hidden;
  }
  /* The date is the one thing in here that never goes: it is how a list is
     read. The badges give way to it. */
  .uin-row-meta > :last-child { flex: none; }
  .uin-row-tags { flex: 0 1 auto; }
}

.uin-tag {
  display: inline-flex; align-items: center; gap: 0.25rem;
  min-width: 0;
  font-size: 0.6875rem;
  padding: 0.05rem 0.4rem;
  border-radius: 0.25rem;
  border: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  background: var(--color-surface-raised);
  white-space: nowrap;
}
/* The two places a plain badge or a plain circle lands on a raised ground
   instead of a card: a hovered row, and an outbound message. One step further
   down, which is the only other tint that differs from raised in both themes.
   The status badges are left alone - they carry their own ground. */
.uin-row:hover .uin-avatar,
.uin-row:hover .uin-tag:not(.uin-tag-done):not(.uin-tag-snoozed):not(.uin-tag-failed),
.uin-msg-out .uin-tag:not(.uin-tag-done):not(.uin-tag-snoozed):not(.uin-tag-failed) {
  background: var(--color-bg-subtle);
}
/* A badge sitting where there is not room for it ends in an ellipsis rather than
   mid-letter, which is the whole reason its words are wrapped in a span of their
   own: text-overflow is a property of a block box, and the badge itself is a
   flex box, which has none. Made a flex item, the span blockifies and can do it.
   The minimum of zero is what lets it shrink at all - a flex item will not go
   below its own longest word without being told it may. */
.uin-tag-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
/* Whatever room is short comes out of the words, never out of the icon: half a
   paperclip says nothing. */
.uin-tag > svg { flex: none; }
.uin-tag-done { border-color: var(--color-success-border); background: var(--color-success-bg); color: var(--color-success); }
.uin-tag-snoozed { border-color: var(--color-warning-border); background: var(--color-warning-bg); color: var(--color-warning); }
/* The failed-send tag needs the darker end of the destructive ramp: the plain
   --color-danger on a subtle background measured 4.38:1 in light mode, which is
   under AA for text this small. */
.uin-tag-failed {
  border-color: var(--color-destructive-border);
  background: var(--color-error-bg);
  color: var(--color-destructive-hover);
}

/* ---- pagination --------------------------------------------------------- */
.uin-pager {
  display: flex; gap: 0.5rem; align-items: center; justify-content: space-between;
  padding: 0.625rem 0.875rem;
  border-top: 1px solid var(--color-border);
  background: var(--color-surface-raised);
}
.uin-pager span { font-size: 0.8125rem; color: var(--color-text-secondary); }

/* ---- one conversation --------------------------------------------------- */
.uin-thread {
  display: grid;
  gap: 0;
  align-content: start;
  min-width: 0;
  border: 1px solid var(--color-border);
  border-radius: 0.625rem;
  background: var(--color-surface);
}
/* The subject, the meta line and the row of actions. It used to be stuck to the
   top of whatever was scrolling, on the reasoning that "who is this and what do
   I do with it" is worth keeping on the screen. It cost more than it was worth.
   An HTML message can be four thousand pixels tall, and a tall opaque band
   pinned over the top of a scrolled conversation puts the subject, the meta line
   and the actions immediately above the composer with the message itself out of
   sight above them - which reads as a conversation with no message in it, and is
   what was photographed. It scrolls with the conversation now. The pane is one
   screen tall and scrolls its own contents, so the header is one flick away
   rather than the several thousand pixels it was when the page did the
   scrolling, and that is what the stickiness was really compensating for. */
.uin-thread-head {
  display: grid;
  gap: 0.5rem;
  padding: 0.875rem 1rem;
  border-bottom: 1px solid var(--color-border);
  border-radius: 0.625rem 0.625rem 0 0;
  background: var(--color-surface);
}
.uin-thread-subject { font-size: 1.0625rem; font-weight: 650; margin: 0; }
.uin-thread-actions { display: flex; flex-wrap: wrap; gap: 0.375rem; align-items: center; }
.uin-thread-meta {
  display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center;
  color: var(--color-text-muted);
  font-size: 0.8125rem;
}
/* Named as a container so that what is inside a conversation can lay itself out
   by how wide the conversation is. A person's page is the one that needs it: it
   is the middle pane, so on a 1200px window it is about 700px however wide the
   window says it is. */
.uin-thread-body {
  display: grid;
  gap: 0.875rem;
  padding: 1rem;
  min-width: 0;
  container: uin-body / inline-size;
}
/* Back to the list is for the phone, where the list is not on the screen at all.
   Beside an open list it would be a button that says "look left". */
@media (min-width: 900px) {
  .uin-back { display: none; }
}

.uin-messages { display: grid; gap: 0.75rem; }
.uin-msg {
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  background: var(--color-surface);
  overflow: hidden;
}
/* Inbound and outbound are told apart by four things, not by colour alone: the
   words in the header, the arrow before them, the style of the left edge, and
   the tint. Any one of those on its own would fail somebody. */
.uin-msg-in { border-left: 4px solid var(--color-primary); }
.uin-msg-out { border-left: 4px dashed var(--color-border-strong); background: var(--color-surface-raised); }
.uin-msg-note { border-left: 4px dotted var(--color-warning); background: var(--color-warning-bg); }
.uin-msg-head {
  display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: baseline;
  padding: 0.625rem 0.75rem;
  border-bottom: 1px solid var(--color-border);
}
.uin-msg-who { font-size: 0.875rem; font-weight: 600; }
.uin-msg-dir { display: inline-flex; align-items: center; gap: 0.25rem; font-size: 0.75rem; color: var(--color-text-secondary); }
.uin-msg-when { margin-left: auto; font-size: 0.75rem; color: var(--color-text-muted); }
/* Same again on the note's amber ground and on the outbound tint, both of which
   are darker than the surfaces the muted tier was measured against. */
.uin-msg-note .uin-msg-when,
.uin-msg-out .uin-msg-when { color: var(--color-text-secondary); }
.uin-msg-body { padding: 0.75rem; }
.uin-msg-text { margin: 0; white-space: pre-wrap; font: inherit; font-size: 0.9375rem; line-height: 1.55; color: var(--color-text); }
.uin-frame { width: 100%; border: 0; display: block; background: var(--color-surface); }
.uin-msg-foot {
  display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center;
  padding: 0.5rem 0.75rem;
  border-top: 1px solid var(--color-border);
  font-size: 0.8125rem;
}
.uin-attachment {
  display: inline-flex; align-items: center; gap: 0.375rem;
  padding: 0.25rem 0.6rem;
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  background: var(--color-surface);
  color: var(--color-text-secondary);
  text-decoration: none;
  font-size: 0.8125rem;
}
/* The same strip turned the other way up: used above a message to say how it
   came to be sent rather than below it to say what came with it. */
.uin-msg-flag { border-top: 0; border-bottom: 1px solid var(--color-border); }
/* Anything that acts on the message rather than describing it, pushed to the
   trailing end of the foot. margin-left:auto rather than a float: the foot is
   already a flex row, so this stays inside it and out of the message body. */
.uin-msg-actions { display: flex; gap: 0.5rem; align-items: center; margin-left: auto; }
.uin-attachment:hover { border-color: var(--color-border-strong); color: var(--color-text); text-decoration: none; }

/* ---- small blocks the whole screen shares ------------------------------- */
/* Four of these had grown a private copy in four components, which is four
   places to change and three of them to forget. */

/* A stack of controls with one gap between them. */
.uin-actions { display: grid; gap: 0.5rem; }

/* A <summary> wearing a chip. The chip is a link everywhere else on the screen,
   so the fact that this one opens something has to be said out loud. */
.uin-summary { cursor: pointer; }

/* What has been done to a conversation, or to a person: a record rather than
   something to act on, and dressed to say so. */
.uin-log {
  list-style: none;
  margin: 0.5rem 0 0;
  padding: 0;
  display: grid;
  gap: 0.25rem;
  font-size: 0.8125rem;
  color: var(--color-text-muted);
}

/* ---- composer ----------------------------------------------------------- */
.uin-composer {
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  background: var(--color-surface-raised);
  padding: 0.75rem;
  display: grid;
  gap: 0.625rem;
}
.uin-composer textarea { width: 100%; min-height: 8rem; resize: vertical; }
.uin-composer-modes { display: flex; flex-wrap: wrap; gap: 0.375rem; }
.uin-composer-row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
.uin-recipients { font-size: 0.8125rem; color: var(--color-text-secondary); }

/* ---- writing a new message, over the top -------------------------------- */
/* A new message is started while looking at the list, so it opens over the list
   rather than taking its place: nothing is lost from behind it, and closing it
   puts somebody back exactly where they were. A reply is the other case and
   stays under the conversation it answers. */
/* Above everything core puts on an admin page. The notification bell's dropdown
   sits at 9999 and the consent banner at 9990; a dialog that something else can
   be drawn on top of is not a dialog. */
.uin-modal {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: var(--color-overlay);
}
.uin-modal-card {
  width: min(44rem, 100%);
  max-height: min(90vh, 52rem);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-border);
  border-radius: 0.75rem;
  background: var(--color-surface);
  box-shadow: var(--shadow-xl);
  overflow: hidden;
}
.uin-modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.875rem 1rem;
  border-bottom: 1px solid var(--color-border);
}
.uin-modal-title { margin: 0; font-size: 1.0625rem; font-weight: 650; }
.uin-modal-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border-radius: 0.375rem;
  border: 1px solid transparent;
  color: var(--color-text-secondary);
  text-decoration: none;
}
.uin-modal-close:hover {
  background: var(--color-surface-raised);
  border-color: var(--color-border);
  color: var(--color-text);
  text-decoration: none;
}
.uin-modal-body {
  flex: 1 1 auto;
  padding: 1rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
  min-height: 0;
}
/* The writing box is already inside a box. One outline is enough. */
.uin-modal .uin-composer {
  border: 0;
  background: none;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
  flex: 1 1 auto;
  min-height: 0;
}
/* A new message gets a definite height so the box you write in can take up
   whatever the four lines above it do not, rather than sitting at a polite
   eight rows with a stripe of nothing under it. */
.uin-modal-card-compose { height: min(88vh, 50rem); }

/* ---- asking twice ------------------------------------------------------- */
/* One question, two answers, and no more room than that needs. The answers sit
   on their own strip at the bottom so the question above them is never mistaken
   for one of them. */
.uin-modal-card-confirm { width: min(28rem, 100%); }
.uin-confirm-body {
  margin: 0;
  font-size: 0.9375rem;
  line-height: 1.5;
  color: var(--color-text-secondary);
}
.uin-modal-foot {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
  justify-content: flex-end;
  padding: 0.75rem 1rem;
  border-top: 1px solid var(--color-border);
  background: var(--color-surface-raised);
}

/* The four short answers at the top: label beside the box, one hairline between
   each, and as little air as the rows can be given without touching. */
.uin-fields {
  display: grid;
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  background: var(--color-surface);
  flex: none;
}
.uin-field-row {
  display: grid;
  grid-template-columns: 4.25rem minmax(0, 1fr);
  align-items: center;
  gap: 0.5rem;
  padding: 0.15rem 0.625rem;
  border-bottom: 1px solid var(--color-border);
}
.uin-field-row:last-child { border-bottom: 0; }
.uin-field-row:focus-within { background: var(--color-surface-raised); }
/* The hint beside it is muted, which does not clear AA on raised in dark. */
.uin-field-row:focus-within .uin-field-hint { color: var(--color-text-secondary); }
.uin-field-row > label {
  margin: 0;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--color-text-secondary);
}
.uin-field-control { display: flex; align-items: center; gap: 0.5rem; min-width: 0; }
/* Borderless inside a bordered block: a box drawn round every line would be
   four boxes inside a box, and the row itself already says where to type. */
.uin-field-control input,
.uin-field-control select {
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  background: none;
  padding: 0.35rem 0;
  border-radius: 0;
  font-size: 0.875rem;
  color: var(--color-text);
}
.uin-field-control select { max-width: 22rem; }
.uin-field-hint {
  flex: none;
  font-size: 0.75rem;
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.uin-field-add {
  flex: none;
  border: 0;
  background: none;
  padding: 0.15rem 0.25rem;
  font: inherit;
  font-size: 0.8125rem;
  color: var(--color-text-secondary);
  cursor: pointer;
  text-decoration: underline;
}
.uin-field-add:hover { color: var(--color-text); }

/* Everything the four lines above do not take. */
.uin-compose-message { flex: 1 1 auto; display: flex; min-height: 6rem; }
.uin-modal .uin-composer textarea {
  flex: 1 1 auto;
  width: 100%;
  min-height: 6rem;
  resize: none;
}
@media (max-width: 599px) {
  .uin-field-row { padding-inline: 0.5rem; }
  .uin-field-hint { display: none; }
}

/* ---- empty and error states -------------------------------------------- */
.uin-empty {
  border: 1px dashed var(--color-border-strong);
  border-radius: 0.625rem;
  padding: 2rem 1.5rem;
  text-align: center;
  color: var(--color-text-muted);
  background: var(--color-surface);
}
.uin-empty strong { display: block; color: var(--color-text); margin-bottom: 0.25rem; }
/* Inside the list card the outline is already there, so the empty state drops
   its own rather than drawing a box inside a box. */
.uin-listpane > .uin-empty { border: 0; border-radius: 0; }

/* Every interactive thing on this screen shows where the keyboard is. */
.uin a:focus-visible,
.uin button:focus-visible,
.uin input:focus-visible,
.uin select:focus-visible,
.uin textarea:focus-visible,
.uin-modal a:focus-visible,
.uin-modal button:focus-visible,
.uin-modal input:focus-visible,
.uin-modal select:focus-visible,
.uin-modal textarea:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: 2px;
}

/* Only one pane at a time on a phone: the list, or the conversation. */
@media (max-width: 899px) {
  .uin[data-thread="open"] .uin-listpane { display: none; }
}

/* ---- the context panel -------------------------------------------------- */
.uin-ctx { display: grid; gap: 0.75rem; align-content: start; min-width: 0; }
.uin-ctx-block {
  border: 1px solid var(--color-border);
  border-radius: 0.625rem;
  background: var(--color-surface);
  padding: 0.875rem;
  display: grid;
  gap: 0.5rem;
  min-width: 0;
}
.uin-ctx-heading {
  margin: 0;
  font-size: 0.6875rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-text-muted);
  font-weight: 700;
}
.uin-ctx-name { margin: 0; font-size: 1rem; font-weight: 600; }
.uin-ctx-name a { color: var(--color-text); }
/* Secondary rather than muted: this carries real information - an address, a
   total, a date - and muted measures under AA against the card in dark mode. */
.uin-ctx-sub { margin: 0; font-size: 0.8125rem; color: var(--color-text-secondary); word-break: break-word; }
.uin-ctx-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
.uin-ctx-row {
  display: grid;
  gap: 0.2rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--color-border);
  min-width: 0;
}
.uin-ctx-row:last-child { border-bottom: 0; padding-bottom: 0; }
.uin-ctx-main {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.875rem;
  min-width: 0;
}
.uin-ctx-main a { font-weight: 600; }
.uin-ctx-remove {
  justify-self: start;
  background: none;
  border: 0;
  padding: 0;
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  text-decoration: underline;
  cursor: pointer;
}
.uin-ctx-remove:hover { color: var(--color-danger); }
.uin-ctx-remove:disabled { cursor: default; opacity: 0.6; }
.uin-ctx-add { display: grid; gap: 0.5rem; margin-top: 0.25rem; }
/* The same block under a person, where it carries one field per line rather
   than a row of them. It has to come after .uin-ctx-add and not with the other
   shared blocks: the two are the same weight, so whichever is written last is
   the one that counts, and this one has to be able to answer back. */
.uin-ctx-add-stacked { grid-template-columns: minmax(0, 1fr); }
/* The collapsed "attach something" chip is a button, not a field: in a grid
   card it would otherwise stretch the full width and read as an input box. */
.uin-ctx-block > .uin-chip { justify-self: start; }
.uin-ctx-add input, .uin-ctx-add select, .uin-ctx-add textarea { min-width: 0; width: 100%; }
.uin-ctx-add-actions { display: flex; flex-wrap: wrap; gap: 0.35rem; align-items: center; }
/* The list of records to choose from. Capped and scrolled rather than allowed
   to push the conversation off the screen: eight rows is what the server sends
   and about four is what a narrow rail can show without the card growing taller
   than the message beside it. */
.uin-ctx-picker {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.15rem;
  max-height: 15rem;
  overflow-y: auto;
  border: 1px solid var(--color-border-strong);
  border-radius: 0.5rem;
  background: var(--color-bg-subtle);
}
.uin-ctx-picker button {
  display: grid;
  gap: 0.15rem;
  width: 100%;
  text-align: left;
  background: none;
  border: 0;
  border-radius: 0.375rem;
  padding: 0.4rem 0.5rem;
  color: var(--color-text);
  cursor: pointer;
  font: inherit;
}
/* The one place in this file that keeps --color-bg-subtle on a card, and it is
   deliberate: see the trap at the top. Its fill IS flat against the card in dark
   mode, which is why the outline is the strong border rather than the ordinary
   one - the box is drawn by its edge, in both themes. It has to stay bg-subtle
   because the hover below is the thing that actually has to be seen, raised is
   the only tint that differs from bg-subtle in both themes, and the badges
   inside the rows are raised as well. Painting the list raised would cost the
   hover and the badges to buy a fill nobody needs. The label underlines too,
   because a 1.1:1 lift is a hint rather than an answer. */
.uin-ctx-picker button:hover, .uin-ctx-picker button:focus-visible {
  background: var(--color-surface-raised);
}
/* The name only. The status beside it is a tag, and an underlined tag reads as
   a second link to somewhere else. */
.uin-ctx-picker button:hover .uin-ctx-main > span:first-child,
.uin-ctx-picker button:focus-visible .uin-ctx-main > span:first-child {
  text-decoration: underline;
}
.uin-ctx-picker button:disabled { cursor: default; opacity: 0.6; }
.uin-ctx-picker .uin-ctx-main { font-weight: 600; }

/* ---- one person --------------------------------------------------------- */
.uin-person { display: grid; gap: 1rem; align-items: start; min-width: 0; }
/* Two columns once the page itself is wide enough for two, which is not the
   same question as whether the window is. This pane sits beside the list, so a
   window query fired at 1100px on a pane that was 700px wide and split it into
   two columns that did not fit. */
@container uin-body (min-width: 62rem) {
  .uin-person { grid-template-columns: minmax(0, 1fr) minmax(14rem, 17rem); }
}
.uin-person-main { display: grid; gap: 0.75rem; min-width: 0; }
.uin-timeline { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.6rem; }
.uin-timeline-row {
  display: grid;
  grid-template-columns: 1.25rem minmax(0, 1fr);
  grid-template-areas: "icon main" ". sub";
  gap: 0.2rem 0.5rem;
  padding-bottom: 0.6rem;
  border-bottom: 1px solid var(--color-border);
}
.uin-timeline-row:last-child { border-bottom: 0; padding-bottom: 0; }
.uin-timeline-icon { grid-area: icon; color: var(--color-text-muted); line-height: 1; padding-top: 0.15rem; }
.uin-timeline-row .uin-ctx-main { grid-area: main; }
.uin-timeline-row .uin-ctx-sub { grid-area: sub; }
`

export function InboxStyles() {
  return <style dangerouslySetInnerHTML={{ __html: CSS }} />
}

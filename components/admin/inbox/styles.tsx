// The inbox screen's stylesheet, carried with the module.
//
// The screen is a mail program rather than a page with a list on it: one framed
// box, the height of the window, divided by hairlines into a rail of places to
// go, the list of what is in the one chosen, the conversation that is open, and
// what the rest of the site knows about whoever sent it. Each pane scrolls its
// own contents. That shape cannot be written as a style attribute - it takes
// media queries to fold down to one column on a phone - which is why this is a
// real stylesheet rather than inline styles.
//
// Everything in it is a semantic token, so the whole screen follows the admin
// into dark mode with no second palette and nothing to keep in step. No hex
// values: a colour written here is a colour that is wrong in one of the two
// themes.
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
// This is why the rail and the context panel are --color-bg while the list and
// the conversation are --color-surface: it is the one pairing that reads as two
// grounds in both themes. Before adding any background here, find the ground it
// lands on and check it against that list.
const CSS = `
/* ---- the page this module is given ------------------------------------- */
/* ONE BOX, NEVER WIDER THAN THE PAGE.
   Core's admin content column is a stretched flex item, so anything inside it
   that is too wide does not get clipped or scrolled - it makes the WHOLE admin
   page scroll sideways, and what a reader then finds out there is a screenful
   of background. Every region in this stylesheet already deals with its own
   overflow (the rail scrolls, the rows end in an ellipsis, the message body is
   an iframe, wide tables sit in .uin-camp-scroll), so a box round the lot of it
   clips bleed rather than content.
   Clip rather than hidden, and it matters: hidden would make this a scroll
   container, and the frame inside is position:sticky, which sticks to the
   nearest scroll container. Clip does not create one. */
.uin-page {
  max-width: 100%;
  overflow-x: clip;
}

/* ---- the frame the whole screen lives in -------------------------------- */
/* One box divided by hairlines rather than four cards floating on a page: a
   rail of places to go, the list of what is in the one chosen, what is open,
   and what the rest of the site knows about whoever sent it. Every pane scrolls
   its own contents inside a frame the height of the screen, which is what makes
   this read as a mail program rather than as a web page with a list on it.
   That is not decoration. A page that scrolls as one puts the row somebody is
   reading and the message they opened at two different heights, and no amount
   of tidying inside the panes fixes it.
   THE GROUNDS ARE PICKED OFF THE PAIR LIST AT THE TOP OF THIS FILE. The rail
   and the context panel sit on --color-bg and the two middle panes on
   --color-surface, because bg and surface are the one pairing that genuinely
   differs in BOTH themes - the more obvious --color-bg-subtle is the identical
   colour to surface in dark mode, so a rail painted in it would be a rail
   nobody could see the edge of on half the sites running this. */
.uin-app {
  display: grid;
  grid-template-areas: "rail" "list" "read" "ctx";
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
  /* The drag handles are laid over the hairlines between the columns, so the
     frame has to be what they are positioned against. From 900px up it is
     sticky, which is positioned too, so this only does any work on a phone -
     where the handles are not drawn at all. */
  position: relative;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg, 0.75rem);
  background: var(--color-bg);
  overflow: hidden;
}
/* From a tablet up the frame stops being a stack of blocks on a page that
   scrolls and becomes the height of the screen, stuck to the top of it until
   whatever core has put above has scrolled away. Nothing inside is stuck to the
   page itself, so no pane can be painted over another.

   THE HEIGHT IS THE SCREEN MINUS THE PADDING CORE PUTS ROUND IT, NOT THE SCREEN.
   Core's admin content column is padded --space-8 (32px) top and bottom, so a
   frame a whole screen tall makes the page 64px taller than the window and the
   whole admin scrolls by an inch - enough to bounce the mail program under a
   trackpad flick, not enough to reveal anything, which is the worst of both.
   Take the padding off the height and the document is exactly one screen: the
   frame rests where it is drawn, nothing scrolls, and the sticky below only
   comes into play on a site where core has put a tab strip above us.
   The sticky offset matches the same padding for the same reason - stuck at a
   different inset to where it rests would make the frame jump on the first
   scroll. Below 900px core is on --space-4 instead, but so is this rule: it
   never applies there. */
@media (min-width: 900px) {
  .uin-app {
    position: sticky;
    top: var(--space-8, 2rem);
    height: calc(100vh - var(--space-8, 2rem) * 2);
    height: calc(100svh - var(--space-8, 2rem) * 2);
    min-height: 30rem;
    grid-template-areas: "rail rail" "list read" "list ctx";
    grid-template-columns: minmax(17rem, 26rem) minmax(0, 1.7fr);
    /* The context panel's row collapses to nothing when there is no panel in
       it, so the same template serves both states. */
    grid-template-rows: auto minmax(0, 1fr) fit-content(40%);
  }
  /* A grid item will not scroll its own overflow unless it is allowed to be
     shorter than its contents, which is what the two minimums are for. */
  .uin-app > * { min-width: 0; min-height: 0; }
}
/* Room for the rail to stand up as a column of its own. Below this it is a
   strip along the top: fifteen rems taken off a 1100px window leaves the
   conversation too narrow to read, and the conversation is what somebody came
   here for. */
@media (min-width: 1200px) {
  .uin-app {
    /* THE TWO WIDTHS SOMEBODY CAN DRAG. Both are read through a fallback, so a
       reader who has never touched a handle gets exactly the layout this file
       shipped with - 15rem of rail, and a list at the 24rem it always settled
       at once the conversation's 1fr had taken the rest. ColumnResizer writes
       --uin-w-rail / --uin-w-list onto the document and nothing else, which is
       why the frame itself can go on being server-rendered - and why the
       campaigns screen further down can share the same rail width.
       The handles' own offsets are calc()ed off these, so a fallback that is
       not a plain length would break them: keep both fallbacks single values,
       not minmax(). */
    --uin-rail: var(--uin-w-rail, 15rem);
    --uin-list: var(--uin-w-list, 24rem);
    grid-template-areas: "rail list read" "rail list ctx";
    grid-template-columns: var(--uin-rail) var(--uin-list) minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) fit-content(40%);
  }
}
/* Room for all four side by side - but only when there is a fourth to put
   there. Without the guard, a conversation with nothing attached to anybody
   left a twenty-rem column of empty ground at the end of the frame. */
@media (min-width: 1500px) {
  .uin-app[data-context="on"] {
    grid-template-areas: "rail list read ctx";
    grid-template-columns: var(--uin-rail) var(--uin-list) minmax(0, 1fr) minmax(16rem, 20rem);
    grid-template-rows: minmax(0, 1fr);
  }
}
/* Only one pane at a time on a phone: the list, or the thing that was opened
   from it. Both on one column is a list nobody can get past. */
@media (max-width: 899px) {
  .uin-app[data-open="1"] > .uin-col { display: none; }
  .uin-app[data-open="0"] > .uin-read,
  .uin-app[data-open="0"] > .uin-ctx { display: none; }
}

/* ---- the handles between the columns ------------------------------------ */
/* How wide the list wants to be is a question about the person reading it, not
   about the screen, so the two hairlines between the three columns can be
   dragged. The handle is a strip of nothing sitting over the hairline: it
   paints only when somebody is on it, because a mail program with two visible
   grab bars down it looks like a page that came apart.
   Nine pixels wide and centred on the edge - four each side. A one-pixel target
   is one nobody can hit, and anything fatter starts eating the clicks of the
   rows either side of it.
   ONLY FROM 1200px UP: below that the rail lies across the top of the frame
   instead of standing beside it, so a full-height handle at the list's edge
   would sit over the rail's own links. There are two columns there, not three.
   The offsets are calc()ed off the same --uin-rail / --uin-list the grid uses,
   so the handle cannot drift away from the edge it moves. */
.uin-resize { display: none; }

@media (min-width: 1200px) {
  .uin-resize {
    display: block;
    position: absolute;
    top: 0;
    bottom: 0;
    width: 9px;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: col-resize;
    z-index: 4;
    /* Or the browser takes the drag for a scroll on a touchscreen and the edge
       never moves. */
    touch-action: none;
  }
  .uin-resize[data-edge="rail"] { left: calc(var(--uin-rail) - 4px); }
  .uin-resize[data-edge="list"] { left: calc(var(--uin-rail) + var(--uin-list) - 4px); }

  /* The line itself, inside the target rather than being it: the thing somebody
     can hit is nine pixels wide and the thing they can see is two. */
  .uin-resize-line {
    display: block;
    position: absolute;
    inset: 0 3px;
    border-radius: 999px;
    background: var(--color-primary);
    opacity: 0;
    transition: opacity 0.12s ease-out;
  }
  .uin-resize:hover .uin-resize-line,
  .uin-resize[data-dragging="on"] .uin-resize-line { opacity: 1; }
  /* Focus is shown the same way as hover rather than with a ring: the target is
     a nine-pixel strip and an outline round it reads as a scratch on the
     screen. Keyboard users get the same line, and it stays while they arrow. */
  .uin-resize:focus-visible { outline: none; }
  .uin-resize:focus-visible .uin-resize-line { opacity: 1; }

  /* A drag anywhere in the frame keeps the resize cursor and stops the pointer
     selecting the text it passes over. */
  .uin-app:has(.uin-resize[data-dragging="on"]) { cursor: col-resize; user-select: none; }
}

@media (prefers-reduced-motion: reduce) {
  .uin-resize-line { transition: none; }
}

/* The campaigns screen, which is not a list beside a conversation and has a
   save bar of its own pinned to the bottom of it. It keeps the rail and drops
   everything else: a fixed-height scroller round a long form is a second
   scrollbar inside the page's own. */
.uin-app-wide {
  position: static;
  height: auto;
  min-height: 0;
  grid-template-areas: "rail" "read";
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  /* Nothing in here may be a scroll container. The campaign form's save bar is
     stuck to the bottom of the page, and a sticky thing sticks to the nearest
     scroller - put one round it and the bar sits at the bottom of the form
     instead, which is exactly where it would be if it were not stuck at all.
     Clip on one axis with visible on the other is the one combination that
     trims bleed without making a scroller. */
  overflow-x: clip;
  overflow-y: visible;
}
.uin-app-wide > .uin-read { overflow: visible; }
@media (min-width: 1200px) {
  .uin-app-wide {
    grid-template-areas: "rail read";
    /* The same rail width the inbox has, so it does not change size on the way
       between the two screens. There is no handle on this one to change it
       with; ColumnResizer is mounted here only to apply what was stored. */
    grid-template-columns: var(--uin-rail) minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
  }
  /* The rail's cell is as tall as a long form, so the links inside it stick
     rather than the rail itself - which keeps the hairline down its edge
     running the whole height instead of stopping a third of the way. */
  .uin-app-wide .uin-rail-scroll {
    position: sticky;
    top: 0.75rem;
    max-height: calc(100vh - 1.5rem);
    max-height: calc(100svh - 1.5rem);
  }
}

/* ---- the rail of places to go ------------------------------------------- */
/* Every address, every channel, and the four places that are not a list of
   post - Sent, Drafts, Contacts, Campaigns - down one side, with what is new in
   each beside it. It was a strip of tabs across the top, which is where a
   browser puts three of something; there are a dozen here on a site with a
   handful of addresses, and a dozen tabs is a horizontal scrollbar hiding half
   of them.
   The addresses can still be dragged into the order somebody wants. Dropping
   saves straight away and the rail moves first: the gesture is over in half a
   second and a list that snaps back while a request finishes reads as a bug. A
   refused save puts the order back and says so. */
.uin-rail {
  grid-area: rail;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--color-bg);
  border-bottom: 1px solid var(--color-border);
}
/* The places to go. Everything that scrolls is in here, so an answer to a press
   - a refused rearrangement, what the mail check found - can sit outside it and
   stay on screen rather than being parked off the end of a strip. */
.uin-rail-scroll {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  min-width: 0;
  min-height: 0;
  padding: 0.625rem;
  overflow-y: auto;
}
@media (min-width: 1200px) {
  .uin-rail {
    border-bottom: 0;
    border-right: 1px solid var(--color-border);
  }
}
/* Below the width where it can stand up, the rail lies down: one scrolling
   strip with the group headings taken out and a hairline between the groups
   instead. Same markup, same order, a quarter of the height. */
@media (max-width: 1199px) {
  .uin-rail-scroll {
    flex-direction: row;
    align-items: center;
    gap: 0.4rem;
    padding: 0.45rem 0.5rem;
    overflow-x: auto;
    overflow-y: hidden;
  }
  .uin-rail-heading { display: none; }
  .uin-rail-group { flex: none; display: flex; align-items: center; }
  .uin-rail-group + .uin-rail-group {
    border-left: 1px solid var(--color-border);
    padding-left: 0.4rem;
    margin-left: 0.1rem;
  }
  .uin-rail-list { flex-direction: row; gap: 0.15rem; }
  .uin-rail-foot {
    margin: 0;
    padding: 0 0 0 0.4rem;
    border-top: 0;
    border-left: 1px solid var(--color-border);
  }
  .uin-rail-item { padding-block: 0.3rem; }
  .uin-rail-notice { padding: 0 0.5rem 0.45rem; }
  /* Lying down there is no room for a tree, so a colleague's folders run along
     after their name with the same hairline turned on its side. */
  .uin-rail-sub {
    margin-left: 0;
    padding-left: 0.35rem;
    border-left: 1px solid var(--color-border);
  }
  .uin-rail-branch { gap: 0; }
}
.uin-rail-group { display: grid; gap: 0.2rem; min-width: 0; }
.uin-rail-heading {
  margin: 0.2rem 0 0.1rem 0.5rem;
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}
.uin-rail-list { display: flex; flex-direction: column; gap: 0.1rem; list-style: none; margin: 0; padding: 0; min-width: 0; }
.uin-rail-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  padding: 0.34rem 0.5rem;
  border-radius: var(--radius, 0.375rem);
  color: var(--color-text-secondary);
  font-size: 0.8125rem;
  line-height: 1.4;
  text-decoration: none;
  white-space: nowrap;
}
.uin-rail-item:hover {
  background: var(--color-surface);
  color: var(--color-text);
  text-decoration: none;
}
/* Where you are, said by a filled block rather than by an underline: an
   underline under one of fourteen stacked rows is a line nobody finds. Two
   things move, the fill and the weight, because a single tint is not a state
   anybody should have to notice. */
.uin-rail-item[aria-current="page"] {
  background: var(--color-primary-subtle);
  box-shadow: inset 0 0 0 1px var(--color-primary-border);
  color: var(--color-text);
  font-weight: 600;
}
.uin-rail-icon { flex: none; display: grid; place-items: center; color: var(--color-text-muted); }
.uin-rail-item[aria-current="page"] .uin-rail-icon { color: var(--color-primary); }
.uin-rail-icon svg { display: block; width: 15px; height: 15px; }
.uin-rail-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
/* A tinted chip rather than a solid primary pill: white on the primary green
   measures 3.61:1, which is under AA for text this small, and a count nobody
   can read is not a count. */
.uin-rail-count {
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
/* On the row that is already painted in the tint, the chip takes the pane's own
   surface instead - the one other ground that differs from it in both themes. */
.uin-rail-item[aria-current="page"] .uin-rail-count {
  background: var(--color-surface);
  border-color: var(--color-border);
}
/* Counts that are not "something new is waiting" - how many contacts, how many
   drafts - are furniture beside the unread ones and are dressed down to say so. */
.uin-rail-count-quiet {
  background: var(--color-bg-subtle);
  border-color: var(--color-border);
  color: var(--color-text-secondary);
  font-weight: 600;
}
.uin-rail-item[aria-current="page"] .uin-rail-count-quiet {
  background: var(--color-surface);
}
/* A colleague's own post, and the folders of it that open out underneath.
   The twist is its own control beside the link rather than inside it: a button
   inside a link is one nobody can press without going where the link goes. It
   is 18px because that is the width of the sub-list's own indent, so the
   folders line up under the name rather than under the arrow. */
.uin-rail-branch { display: flex; align-items: center; gap: 0.1rem; min-width: 0; }
.uin-rail-branch > .uin-rail-item { flex: 1 1 auto; }
.uin-rail-twist {
  flex: none;
  display: grid;
  place-items: center;
  width: 1.125rem;
  height: 1.5rem;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm, 0.25rem);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
}
.uin-rail-twist:hover { background: var(--color-surface); color: var(--color-text); }
.uin-rail-twist-icon { display: grid; place-items: center; transition: transform 0.12s ease; }
.uin-rail-twist-icon svg { display: block; width: 13px; height: 13px; }
.uin-rail-twist[aria-expanded="true"] .uin-rail-twist-icon { transform: rotate(90deg); }
@media (prefers-reduced-motion: reduce) {
  .uin-rail-twist-icon { transition: none; }
}
/* A hairline down the left rather than an indent alone: three folders floating
   under a name read as three more names. */
.uin-rail-sub {
  margin-left: 1.4rem;
  padding-left: 0.35rem;
  border-left: 1px solid var(--color-border);
}
/* The group's own display rule would otherwise beat the hidden attribute. */
.uin-rail-sub[hidden] { display: none; }
.uin-rail-sub .uin-rail-item { font-size: 0.78125rem; }

/* Rearranging the addresses. The grab cursor is the only thing that says so
   until somebody takes hold of one - a column of handles would put furniture
   beside every address to serve a job done once a year. While one is in the air
   it fades, and the address it would land on carries a line along its top edge,
   so the answer to "where does this go" is on the screen rather than in the
   wrist. */
.uin-rail-item[data-uin-drag] { cursor: grab; }
.uin-rail-item[data-uin-drag]:active { cursor: grabbing; }
.uin-rail-item[data-uin-dragging] { opacity: 0.45; }
.uin-rail-item[data-uin-over] { box-shadow: inset 0 2px 0 0 var(--color-primary); }
@media (prefers-reduced-motion: reduce) {
  .uin-rail-item[data-uin-dragging] { opacity: 0.7; }
}

/* Who is reading, and the one button up here that is not a place to go, on one
   line - which is where every mail program puts the pair of them. */
.uin-rail-me {
  flex: none;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  padding: 0.1rem 0.15rem 0.35rem;
}
.uin-rail-me-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Lying down, the rail is a strip of places and the name is the one thing in it
   that is not one. The picture and the pen stay. */
@media (max-width: 1199px) {
  .uin-rail-me { padding: 0; }
  .uin-rail-me-name { display: none; }
}

/* Which colour an address wears, beside its name. Five, and every one of them a
   semantic token that is already right in both themes - a sixth would have to be
   a hex value, and a hex value is a colour that is wrong in one of the two.
   Never the only thing saying which address a row is: the name is right beside
   it, and the dot is hidden from a screen reader entirely. */
.uin-rail-dot {
  flex: none;
  width: 0.5rem;
  height: 0.5rem;
  margin: 0 0.25rem;
  border-radius: 999px;
  background: var(--color-text-muted);
}
.uin-rail-dot[data-tone="1"] { background: var(--color-primary); }
.uin-rail-dot[data-tone="2"] { background: var(--color-info); }
.uin-rail-dot[data-tone="3"] { background: var(--color-warning); }
.uin-rail-dot[data-tone="4"] { background: var(--color-destructive); }
.uin-rail-dot[data-tone="5"] { background: var(--color-text-secondary); }

/* Write a message, at the head of the rail rather than among the addresses,
   because it is the one thing up there that is not a place to go. Its own
   colours are spelled out rather than borrowed from .btn-primary: white on the
   primary green measures 3.61:1, which is under AA, and this button carries
   words. */
.uin-rail-compose,
.uin-compose {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  padding: 0.45rem 0.75rem;
  border-radius: var(--radius, 0.375rem);
  border: 1px solid var(--color-primary-border);
  background: var(--color-primary-subtle);
  color: var(--color-text);
  font-size: 0.8125rem;
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
}
.uin-rail-compose:hover,
.uin-compose:hover {
  border-color: var(--color-primary);
  background: var(--color-surface);
  color: var(--color-text);
  text-decoration: none;
}
/* The rail's own is a square with a pen in it, beside whoever is reading. It
   carries its name for a screen reader, on the link itself rather than in the
   text. */
.uin-rail-compose {
  width: 1.85rem;
  height: 1.85rem;
  padding: 0;
}
/* Elsewhere - the address book's New contact - the words go on a narrow window
   and the pen stands for them. */
@media (max-width: 599px) {
  .uin-compose-words { display: none; }
}

/* The pen, and the arrow beside it for the three things that are not an email.
   One button split in two rather than two buttons: writing an email is what
   this is pressed for nearly every time, and the seam says the arrow belongs to
   it rather than being another thing in the row. */
.uin-compose-split { flex: none; display: inline-flex; }
.uin-rail-compose-main {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}
.uin-rail-compose-more {
  width: 1.15rem;
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
  border-left-color: var(--color-primary);
  cursor: pointer;
}
/* Fixed, and positioned from the button by ComposeMenu: the rail scrolls, and a
   menu drawn inside it is a menu with its bottom half cut off on a phone.
   Above everything core puts on an admin page, for the same reason the dialogs
   are - the bell's dropdown sits at 9999. */
.uin-compose-menu {
  position: fixed;
  z-index: 10000;
  width: 15rem;
  padding: 0.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md, 0.5rem);
  background: var(--color-surface);
  box-shadow: var(--shadow-xl);
}
.uin-compose-menu-item {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.45rem 0.5rem;
  border-radius: var(--radius, 0.375rem);
  color: var(--color-text);
  text-decoration: none;
}
.uin-compose-menu-item:hover {
  background: var(--color-surface-raised);
  color: var(--color-text);
  text-decoration: none;
}
.uin-compose-menu-icon {
  flex: none;
  display: inline-flex;
  margin-top: 0.05rem;
  color: var(--color-text-secondary);
}
.uin-compose-menu-words { display: flex; flex-direction: column; gap: 0.05rem; min-width: 0; }
.uin-compose-menu-label { font-size: 0.8125rem; font-weight: 600; }
/* Secondary rather than muted: this line carries the whole meaning of the entry,
   and muted does not clear AA on the raised ground it lands on when hovered. */
.uin-compose-menu-hint { font-size: 0.6875rem; color: var(--color-text-secondary); }

/* ---- fetching new mail, at the foot of the rail ------------------------- */
.uin-rail-foot {
  margin-top: auto;
  padding-top: 0.5rem;
  border-top: 1px solid var(--color-border);
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex: none;
}
.uin-refresh {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  padding: 0.3rem 0.45rem;
  border: 0;
  border-radius: var(--radius, 0.375rem);
  background: none;
  color: var(--color-text-muted);
  font: inherit;
  font-size: 0.8125rem;
  cursor: pointer;
}
.uin-refresh:hover:not(:disabled) { background: var(--color-surface); color: var(--color-text); }
.uin-refresh:disabled { cursor: default; opacity: 0.55; }
.uin-refresh svg { display: block; }
.uin-refresh[data-busy="1"] svg { animation: uin-spin 0.9s linear infinite; }
@keyframes uin-spin { to { transform: rotate(360deg); } }
/* A spinner is decoration, and decoration that moves is a problem for some
   readers. The button still says it is busy, in words, to a screen reader. */
@media (prefers-reduced-motion: reduce) {
  .uin-refresh[data-busy="1"] svg { animation: none; }
}
/* Whatever the check came back with. Inside the rail on a narrow window it
   would be a paragraph in a strip of links, so it is only ever drawn under the
   rail where the rail is a column. */
.uin-rail-notice { flex: none; font-size: 0.75rem; padding: 0 0.625rem 0.625rem; }
.uin-rail-notice .alert { margin: 0; padding: 0.4rem 0.5rem; font-size: 0.75rem; }

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

/* ---- the column the list lives in --------------------------------------- */
/* Its own head, then the list under it scrolling on its own. The head holds
   everything that decides WHAT the list is a list of - where a conversation
   stands, a search, the narrower cuts - so all of it stays put while forty
   conversations go past underneath. It used to sit above the whole workspace,
   which meant scrolling the list scrolled the controls off the top of the
   screen. */
.uin-col {
  grid-area: list;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--color-surface);
}
@media (min-width: 900px) {
  .uin-col { border-right: 1px solid var(--color-border); }
}
@media (max-width: 899px) {
  .uin-col { border-bottom: 1px solid var(--color-border); }
}
.uin-col-head {
  flex: none;
  display: grid;
  gap: 0.5rem;
  padding: 0.6rem 0.75rem;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
}
.uin-col-title { display: flex; align-items: baseline; gap: 0.5rem; min-width: 0; }
.uin-col-title h2 {
  margin: 0;
  font-size: 0.9375rem;
  font-weight: 650;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.uin-col-total {
  margin-left: auto;
  flex: none;
  font-size: 0.75rem;
  color: var(--color-text-muted);
  white-space: nowrap;
}
.uin-col-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; }

/* Where a conversation stands: waiting, set aside, dealt with, or the lot -
   and, on the address book, which half of it is being listed. Plain words with
   a line under the one that is on. A pill or a segmented control puts four
   boxes in a column twenty-odd rems wide and leaves two letters showing in
   each; words take the room they need and no more, which is why every mail
   program has drawn this row the same way for thirty years.
   The rule under the row is the row's own bottom border, so the underline on
   the chosen tab lands ON it rather than above it. */
.uin-tabs {
  display: flex;
  align-items: center;
  gap: 0.15rem;
  overflow-x: auto;
  scrollbar-width: none;
}
.uin-tabs::-webkit-scrollbar { display: none; }
/* A filled pill on the one that is on, not an underline. An underline was the
   wrong read of the thing this was copied from, and it is the weaker signal in
   a row this small - a fill is seen before the word is. */
.uin-tab {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  flex: none;
  padding: 0.25rem 0.6rem;
  border-radius: 999px;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--color-text-muted);
  text-decoration: none;
  white-space: nowrap;
}
/* Hover moves the colour and not the fill. The pane behind this is
   --color-surface, and the only two grounds that differ from it in BOTH themes
   are surface-raised and bg - and in light mode those two are the same colour,
   so there is exactly one fill available here. It goes to the tab that is on,
   which is the state that has to be seen. */
.uin-tab:hover { color: var(--color-text); text-decoration: none; }
.uin-tab[aria-current="true"] {
  background: var(--color-surface-raised);
  color: var(--color-text);
  font-weight: 650;
}
.uin-tab[aria-current="true"]:hover { background: var(--color-surface-raised); }
.uin-tab-count { font-size: 0.6875rem; font-weight: 600; color: var(--color-text-muted); }
.uin-tab[aria-current="true"] .uin-tab-count { color: var(--color-text-secondary); }
/* How much is in the list altogether, at the far end. It is an answer to the
   row rather than one more thing to press, so it is the quietest thing in it. */
.uin-tabs-total {
  margin-left: auto;
  flex: none;
  padding-left: 0.5rem;
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  white-space: nowrap;
}

/* ---- the search box and the narrower cuts ------------------------------- */
.uin-search-row { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; min-width: 0; }
/* The magnifier inside the box rather than a button beside it, which is where
   every search box on the internet has kept it for fifteen years and what makes
   this read as a search box at a glance rather than as one more text field.
   The form is still a form and still submits on Enter; the button that does
   that is there for a screen reader and takes no room. */
.uin-search {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
  flex: 1 1 10rem;
  padding: 0 0.5rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius, 0.375rem);
  background: var(--color-bg);
}
.uin-search:focus-within {
  border-color: var(--color-border-focus);
  box-shadow: 0 0 0 3px var(--color-primary-glow);
}
.uin-search-icon { flex: none; display: grid; place-items: center; color: var(--color-text-muted); }
.uin-search-icon svg { display: block; width: 14px; height: 14px; }
.uin-search input {
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  background: none;
  padding: 0.35rem 0;
  font-size: 0.8125rem;
  color: var(--color-text);
}
.uin-search input:focus { outline: none; box-shadow: none; }
/* An icon on its own, for the one control up here that changes the order rather
   than the contents. */
.uin-icon-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.85rem;
  height: 1.85rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius, 0.375rem);
  background: var(--color-surface);
  color: var(--color-text-muted);
  text-decoration: none;
}
.uin-icon-btn:hover { color: var(--color-text); border-color: var(--color-border-strong); text-decoration: none; }
.uin-icon-btn[aria-pressed="true"] {
  background: var(--color-primary-subtle);
  border-color: var(--color-primary-border);
  color: var(--color-text);
}
.uin-icon-btn svg { display: block; }
.uin-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  align-items: center;
}
/* Pushed to the far end so the count reads as an answer to the row rather than
   as one more thing to press. */
.uin-toolbar-count {
  margin-left: auto;
  font-size: 0.75rem;
  color: var(--color-text-muted);
  white-space: nowrap;
}
.uin-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.2rem 0.5rem;
  border-radius: 999px;
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-size: 0.75rem;
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
.uin-chip-clear { max-width: 100%; overflow: hidden; white-space: nowrap; }
.uin-chip-clear-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uin-chip-clear-x { flex: none; font-size: 1rem; line-height: 1; }

/* ---- the list ----------------------------------------------------------- */
/* Rows separated by hairlines rather than a stack of little cards: a list of
   forty is read down, and forty separate outlines is forty things to look at
   instead of one. Three lines to a row - who, what it is about, how it began -
   with the date at the top right where a mail program has kept it for thirty
   years. The row is the same shape at every width: this column is never the
   whole screen any more, so the old across-in-one-line variant had nowhere left
   to happen. */
.uin-list { display: block; list-style: none; margin: 0; padding: 0; }
/* A row is the whole line. There was a tick box beside it once, in a column of
   its own on every row on every screen, for something done twice a week - see
   ThreadListView for what picks rows now. */
.uin-list-item { display: flex; align-items: stretch; }
.uin-list-item > .uin-row { flex: 1 1 auto; min-width: 0; }
.uin-list-item[data-selected="true"] > .uin-row { background: var(--color-primary-subtle); }
/* What is ticked, and what can be done with the lot of them. Sits above the
   list rather than floating over it: a bar that covers the first row hides the
   thing somebody is deciding about. */
.uin-bulk {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  align-items: center;
  padding: 0.45rem 0.65rem;
  border-bottom: 1px solid var(--color-border);
  /* --color-bg, not --color-bg-subtle: the pane behind this is --color-surface,
     and subtle is the identical colour to surface in dark mode. */
  background: var(--color-bg);
}
.uin-bulk-count { font-size: 0.75rem; font-weight: 600; }

/* What a merged conversation is made of, under the controls in its header.
   Deliberately quiet: it is a note about how the conversation came to be, not
   a thing that has just happened, and it sits on every merged conversation for
   ever. Tokens throughout - this is chrome, and chrome that hard-codes a colour
   is chrome that is wrong in one of the two themes. */
.uin-merged-from {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  margin-top: 0.5rem;
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm, 0.35rem);
  background: var(--color-bg);
  font-size: 0.75rem;
  color: var(--color-text-muted);
}
.uin-merged-from-title { font-weight: 600; color: var(--color-text); }
.uin-merged-from-list {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.uin-merged-from-list li {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  align-items: center;
}
/* Takes what room there is and gives it back when the row has to wrap, so a
   long subject never pushes the way out off the end of the line. */
.uin-merged-from-what {
  flex: 1 1 8rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text);
}
.uin-merged-from-when { color: var(--color-text-muted); }
.uin-bulk-all { padding: 0.35rem 0.65rem; }
/* The how-to beside the select-all box. Quieter than the words it follows, and
   left to wrap onto a line of its own where the column is too narrow to hold
   both - the bar wraps already, and a hint cut off mid-word helps nobody. */
.uin-bulk-hint { font-size: 0.75rem; color: var(--color-text-muted); }
.uin-pick-all {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.75rem;
  color: var(--color-text-muted);
  cursor: pointer;
}
/* The row that picks a time of your own choosing, under the three ready-made
   ones. Kept on its own line: a date box is not a chip and lining it up with
   them makes both look wrong. */
.uin-snooze-custom {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
  width: 100%;
}
.uin-snooze-custom input {
  height: 32px;
  padding: 0 0.5rem;
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  background: var(--color-surface);
  color: var(--color-text);
  font-family: inherit;
  font-size: 0.8125rem;
}
.uin-snooze-custom input:focus {
  outline: none;
  border-color: var(--color-border-focus);
  box-shadow: 0 0 0 3px var(--color-primary-glow);
}
/* Three tracks: who it is beside, what it says, and the date with whatever
   badges the row has earned under it. The last one is capped rather than left
   to size itself, because "auto" means "as wide as the widest badge in it" and
   a badge would happily take three hundred pixels off the subject line. A name
   on a badge is worth less than the subject of the message. */
.uin-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) minmax(0, auto);
  gap: 0 0.6rem;
  align-items: start;
  padding: 0.55rem 0.75rem 0.6rem;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
  text-decoration: none;
  color: var(--color-text);
}
.uin-list > li:last-child .uin-row { border-bottom: 0; }
.uin-row:hover { background: var(--color-surface-raised); text-decoration: none; }
.uin-row[aria-current="true"] {
  background: var(--color-primary-subtle);
  box-shadow: inset 2px 0 0 0 var(--color-primary);
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
  position: relative;
  overflow: hidden;
  width: 1.875rem; height: 1.875rem; border-radius: 999px;
  display: grid; place-items: center;
  background: var(--color-surface-raised);
  border: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  font-size: 0.625rem; font-weight: 700;
}
/* A picked row, wearing a tick in place of whoever wrote in. Filled rather than
   outlined: this is the one thing on the row that is about what the reader has
   done rather than about the message. */
.uin-avatar-ticked {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: var(--color-on-primary);
}
/* Somebody's own picture, laid over their initials rather than instead of them.
   Absolute, so the row does not move when one arrives and there is no gap while
   one is on its way; and if it never arrives - which is the common case, since
   most people have never published one - the initials underneath were the whole
   answer all along and nobody sees a broken image. */
.uin-avatar-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: inherit;
}
/* Which channel a conversation arrived by, on the corner of the circle. The
   badge carries its name for a screen reader; it is never the only thing saying
   what this is, since the conversation itself says so at the top. */
.uin-avatar-badge {
  position: absolute;
  right: -0.15rem;
  bottom: -0.15rem;
  width: 0.9rem;
  height: 0.9rem;
  border-radius: 999px;
  display: grid;
  place-items: center;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  color: var(--color-text-secondary);
}
.uin-avatar-badge svg { width: 0.65rem; height: 0.65rem; }

/* Three lines with the air taken out of them. A list is read down forty at a
   time, and every spare pixel of leading is a conversation somebody has to
   scroll for. The row still stands well over the 44px a thumb needs. */
.uin-row-main { min-width: 0; display: grid; gap: 0.05rem; }
.uin-row-who { display: flex; gap: 0.35rem; align-items: center; min-width: 0; }
.uin-row-name {
  font-size: 0.8125rem;
  line-height: 1.35;
  font-weight: 500;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.uin-row-name-unread { font-weight: 700; }
/* Who it is with at this end. Dimmer than the name and allowed to disappear
   first: on a narrow column the person who wrote is worth more than the
   colleague it is sitting with. */
.uin-row-arrow { flex: none; color: var(--color-text-muted); font-size: 0.75rem; }
.uin-row-to {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 0.8125rem;
  line-height: 1.35;
  color: var(--color-text-muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.uin-row[aria-current="true"] .uin-row-to,
.uin-row:hover .uin-row-to { color: var(--color-text-secondary); }
/* Unread is said three ways over - a dot, the weight of the name, and a word for
   a screen reader - because a single tinted pixel is not a state anybody should
   have to notice. */
.uin-row-dot {
  flex: none;
  width: 0.4rem; height: 0.4rem;
  border-radius: 999px;
  background: var(--color-primary);
}
.uin-row-subject {
  font-size: 0.8125rem;
  line-height: 1.35;
  color: var(--color-text-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.uin-row-unread .uin-row-subject { font-weight: 600; color: var(--color-text); }
.uin-row-preview {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.75rem;
  line-height: 1.35;
  color: var(--color-text-muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* The turned arrow against a conversation whose last word was ours. It answers
   "am I waiting on them, or are they waiting on me" without opening anything,
   which is the one thing a list of forty cannot otherwise say. */
.uin-row-replied { flex: none; display: grid; place-items: center; color: var(--color-text-muted); }
.uin-row-replied svg { display: block; width: 12px; height: 12px; }
/* Whatever room is short comes out of the words rather than out of the arrow. */
.uin-row-preview > :last-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
/* The date at the top of the stack and the badges under it, which is why this
   is turned upside down: the date is written last in the markup because it is
   the last thing a screen reader should hear about a row, and the first thing
   an eye should find. */
.uin-row-meta {
  display: flex;
  flex-direction: column-reverse;
  align-items: flex-end;
  gap: 0.25rem;
  min-width: 0;
  max-width: 8rem;
  font-size: 0.6875rem;
  line-height: 1.35;
  color: var(--color-text-muted);
  white-space: nowrap;
}
/* The ones that say what happened to the message come before the ones that say
   whose desk it is on - so when there is not room for all of them it is a name
   that goes short rather than "It did not send". */
.uin-row-tags {
  display: flex;
  gap: 0.2rem;
  flex-wrap: wrap;
  justify-content: flex-end;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
}
.uin-row-tags > * { flex: none; max-width: 100%; overflow: hidden; }

.uin-tag {
  display: inline-flex; align-items: center; gap: 0.25rem;
  min-width: 0;
  font-size: 0.6875rem;
  padding: 0.05rem 0.35rem;
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
/* How many messages are in a conversation. A circle rather than a badge,
   because it is a number rather than a word, and quiet: it is the least of the
   four things on a row. */
.uin-count {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.05rem;
  padding: 0 0.25rem;
  border-radius: 999px;
  background: var(--color-bg-subtle);
  color: var(--color-text-secondary);
  font-size: 0.625rem;
  font-weight: 700;
  line-height: 1.6;
}
.uin-row:hover .uin-count { background: var(--color-surface); }
.uin-row[aria-current="true"] .uin-count { background: var(--color-surface); }
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
/* Hairline above it rather than a tinted bar: it is the end of the list, not a
   different kind of thing. */
.uin-pager {
  display: flex; gap: 0.5rem; align-items: center; justify-content: space-between;
  padding: 0.6rem 0.75rem;
  border-top: 1px solid var(--color-border);
  background: var(--color-surface);
}
.uin-pager span { font-size: 0.75rem; color: var(--color-text-muted); }

/* ---- the pane whatever was opened lands in ------------------------------ */
/* One pane, whatever is in it: a conversation, a person's page, a contact card,
   the importer, or - nine times out of ten on the way in - nothing yet. Always
   drawn, even empty, because a screen whose right-hand half appears and
   disappears is a screen that jumps every time somebody opens a row. */
.uin-read {
  grid-area: read;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  background: var(--color-surface);
}
.uin-read > * { min-width: 0; }
.uin-read > .uin-thread { flex: 1 1 auto; }
/* Everything that is not a conversation brings no padding of its own. */
.uin-read-pad { padding: 1rem; }
/* A bare notice in this pane - "that person is not here", "you cannot import
   contacts" - is a box of its own rather than a page, so it takes its air as a
   margin and stays the height of what it says. */
.uin-read > .uin-empty { margin: 1rem; align-self: start; }
/* Nothing open. Said in the middle of the pane rather than at the top of it:
   it is the state of the whole half, not a note about the first inch of it. */
.uin-nothing {
  margin: auto;
  display: grid;
  gap: 0.3rem;
  place-items: center;
  padding: 2rem 1.5rem;
  max-width: 26rem;
  text-align: center;
  font-size: 0.8125rem;
  color: var(--color-text-muted);
}
.uin-nothing strong { font-size: 0.9375rem; color: var(--color-text); }
.uin-nothing svg { width: 1.75rem; height: 1.75rem; color: var(--color-text-disabled); margin-bottom: 0.35rem; }

/* ---- one conversation --------------------------------------------------- */
.uin-thread {
  display: grid;
  gap: 0;
  align-content: start;
  min-width: 0;
  background: var(--color-surface);
}
/* The subject, the meta line and the two rows of actions, pinned to the top of
   the conversation as it scrolls. Reply, Forward and Internal note live in
   there, and a button you have to scroll four thousand pixels of quoted email
   to reach is not a button.

   It was unpinned once before, for a good reason: back then the writing box was
   always open directly beneath it, so a scrolled conversation showed a tall
   opaque band with the composer under it and the message itself out of sight -
   which read as a conversation with nothing in it. The box opens on request
   now, so what is pinned is the conversation's own header and what you can do
   with it, and the message is what fills the rest. */
.uin-thread-head {
  display: grid;
  gap: 0.45rem;
  padding: 0.7rem 1rem 0.75rem;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
}
/* Pinned only where the conversation scrolls its own contents. Below that
   breakpoint the whole page scrolls, and a band this tall pinned to a phone's
   viewport would take a third of the screen away from the thing being read.
   Opaque on purpose either way: messages passing behind a translucent header
   are unreadable twice over. */
@media (min-width: 900px) {
  .uin-thread-head {
    position: sticky;
    top: 0;
    /* Over the messages, and over anything inside the writing box that has a
       stacking context of its own. */
    z-index: 3;
  }
}
/* The subject and the way out of it on one line, the way every mail program
   has put them: the thing you are reading on the left, the cross that shuts it
   hard against the far edge. It was a chip stacked above the subject, which put
   a button where the title should be and pushed the title down a line. */
.uin-thread-top { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 0.4rem 0.75rem; min-width: 0; }
/* On a phone the way out is a sentence rather than a cross, and a sentence does
   not belong on the end of a subject line - so it takes the line above it. */
@media (max-width: 899px) {
  .uin-thread-close { order: -1; flex: 1 1 100%; justify-content: flex-start; padding-left: 0; }
}
/* On a narrow window the three controls take their own line under the subject.
   They are about thirteen ems wide together, which on a phone leaves the
   subject four - and four ems of subject is not a subject. */
@media (max-width: 639px) {
  .uin-thread-actions { flex: 1 1 100%; margin-left: 0; }
}
/* Two lines of it, then an ellipsis. The three controls and the way out share
   this line now, so a subject that used to run the width of the pane gives up
   whatever they need - but a supplier's "Sales Order 0000966554 - PO-00012" is
   two lines rather than one truncated at "Sales Order 00009...", which is a
   subject you cannot tell from the next one. */
.uin-thread-subject {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  font-size: 1rem;
  font-weight: 650;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  /* A reference with no spaces in it is one word as far as wrapping goes, and
     one word wider than the column pushes the buttons off the end. */
  overflow-wrap: anywhere;
}
.uin-thread-close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.3rem;
  width: auto;
  min-height: 1.75rem;
  padding: 0.2rem 0.4rem;
  border: 1px solid transparent;
  border-radius: var(--radius, 0.375rem);
  background: none;
  color: var(--color-text-secondary);
  font-size: 0.8125rem;
  text-decoration: none;
}
.uin-thread-close:hover {
  background: var(--color-surface-raised);
  border-color: var(--color-border);
  color: var(--color-text);
  text-decoration: none;
}
/* Answering, one row above the things done TO the conversation. The one that is
   open reads as pressed - without it, opening the box and scrolling down leaves
   no sign of which of the three you are writing. */
.uin-reply-actions .btn[data-open="1"] {
  background: var(--color-primary-subtle);
  border-color: var(--color-primary-border);
  color: var(--color-text);
  font-weight: 600;
}
/* The three controls, on the subject's own line. They keep their own width and
   the subject gives up its own; the whole group wraps to a line of its own only
   when there is genuinely no room beside a two-line subject. */
.uin-thread-actions {
  display: flex;
  flex: none;
  gap: 0.35rem;
  align-items: center;
  margin-left: auto;
}
/* Whatever went wrong takes the line under the row rather than a slot in it. */
.uin-thread-actions-error { flex: 1 1 100%; margin: 0; }
/* ---- the five seconds after marking something done ---------------------- */
/* Bottom centre of the WINDOW, not of the pane: this screen is a box of panes
   that each scroll their own contents, and a receipt that scrolled away with
   the conversation would be a receipt nobody read in time. Above the panels
   for the same reason they are - core's own chrome sits high - and out of the
   way of the pointer, so it never sits on top of what it is offering to undo.
   It fades once, on its way out; there is nothing to announce on the way in
   that the words do not already say. */
.uin-toast {
  position: fixed;
  z-index: 10001;
  left: 50%;
  bottom: 1.25rem;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 0.75rem;
  max-width: calc(100vw - 2rem);
  padding: 0.55rem 0.6rem 0.55rem 0.9rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md, 0.5rem);
  background: var(--color-surface);
  box-shadow: var(--shadow-xl);
  font-size: 0.8125rem;
  color: var(--color-text);
  opacity: 1;
  transition: opacity 300ms ease;
}
.uin-toast[data-going="1"] { opacity: 0; }
.uin-toast-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* The only thing on it worth pressing, so it looks like the link it is rather
   than competing with the buttons on the conversation behind it. */
.uin-toast-undo {
  flex: none;
  padding: 0.25rem 0.5rem;
  border: 0;
  border-radius: var(--radius, 0.375rem);
  background: none;
  color: var(--color-primary);
  font: inherit;
  font-size: 0.8125rem;
  font-weight: 650;
  cursor: pointer;
}
.uin-toast-undo:hover { background: var(--color-surface-raised); }
.uin-toast-undo:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: 1px;
}
/* Asked for less movement: it still goes after its five seconds, it just goes
   rather than fades. */
@media (prefers-reduced-motion: reduce) {
  .uin-toast { transition: none; }
}
.uin-thread-meta {
  display: flex; flex-wrap: wrap; gap: 0.35rem; align-items: center;
  color: var(--color-text-muted);
  font-size: 0.75rem;
}
/* ---- what this conversation is about ------------------------------------ */
/* The last thing in the pinned header, under everything that can be pressed.
   One line, clipped rather than wrapped: this band is over the messages on
   every window wide enough to pin it, so a conversation with nine orders on it
   must not be allowed to push the message itself down the screen. Whatever will
   not fit ends in an ellipsis and lives behind the arrow. */
.uin-thread-ctx {
  display: grid;
  gap: 0.1rem;
  min-width: 0;
  padding-top: 0.4rem;
  border-top: 1px solid var(--color-border);
}
.uin-attached {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  min-width: 0;
}
/* Secondary rather than muted: these are the site's own record numbers, which
   is real information, and muted measures under AA in dark mode. */
.uin-attached-line {
  flex: 1 1 auto;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 0.75rem;
  color: var(--color-text-secondary);
}
.uin-attached-more {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.5rem;
  height: 1.5rem;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius, 0.375rem);
  background: none;
  color: var(--color-text-secondary);
  cursor: pointer;
}
.uin-attached-more:hover {
  background: var(--color-surface-raised);
  border-color: var(--color-border);
  color: var(--color-text);
}
.uin-attached-more svg { width: 14px; height: 14px; }
.uin-attached-more[aria-expanded="true"] svg { transform: rotate(180deg); }
/* Fixed, and drawn at the very top of the stack, for the same reason as the
   compose menu: the header it hangs off is pinned inside a pane that scrolls
   its own contents, so a menu positioned inside that pane is a menu clipped by
   it. Its width is repeated in MENU_WIDTH in AttachedRecords.tsx - keep the two
   in step or the menu stops lining up with the arrow it opened from. */
.uin-attached-menu {
  position: fixed;
  z-index: 10000;
  width: 300px;
  max-width: calc(100vw - 1rem);
  max-height: min(60vh, 26rem);
  overflow-y: auto;
  display: grid;
  gap: 0.6rem;
  padding: 0.625rem 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md, 0.5rem);
  background: var(--color-surface);
  box-shadow: var(--shadow-xl);
}
/* Named as a container so that what is inside a conversation can lay itself out
   by how wide the conversation is. A person's page is the one that needs it: it
   is the middle pane, so on a 1200px window it is about 700px however wide the
   window says it is. */
/* A conversation, unlike the other things drawn in this pane, has something
   pinned under it - so its middle row takes whatever is left over and the bar
   is at the foot of the pane even on a thread with one line in it. */
.uin-thread-conv { grid-template-rows: auto 1fr auto; }
.uin-thread-body {
  display: grid;
  gap: 0.75rem;
  padding: 0.875rem 1rem 1.25rem;
  min-width: 0;
  container: uin-body / inline-size;
}
/* Two words for one link. On a phone the list is not on the screen at all, so
   this is "Back to the list". Beside an open list that would be a button saying
   "look left" - but it still has a job there, because the list is a column
   while a conversation is open and there was no way at all to shut one and have
   the list back whole. So it becomes a cross. */
.uin-back-wide { display: none; }
@media (min-width: 900px) {
  .uin-back-phone { display: none; }
  .uin-back-wide { display: inline-flex; align-items: center; gap: 0.35rem; }
}

/* One message. Flatter than it was - no rule between the header and the words,
   no rule above the attachments - so a conversation reads as a run of messages
   rather than as a stack of forms. What is left of the outline is a hairline
   and the coloured edge, which is doing real work: see below. */
.uin-messages { display: grid; gap: 0.55rem; }
.uin-msg {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md, 0.5rem);
  background: var(--color-surface);
  overflow: hidden;
}
/* Inbound and outbound are told apart by four things, not by colour alone: the
   words in the header, the arrow before them, the style of the left edge, and
   the tint. Any one of those on its own would fail somebody. */
.uin-msg-in { border-left: 3px solid var(--color-primary); }
.uin-msg-out { border-left: 3px dashed var(--color-border-strong); background: var(--color-surface-raised); }
.uin-msg-note { border-left: 3px dotted var(--color-warning); background: var(--color-warning-bg); }
/* The picture, the two lines of addresses, then the time and the tools hard
   against the far edge - and never wrapping. It used to be one wrapping row,
   and the first thing to drop onto a second line of its own was that tail,
   which put the arrow for answering a message a row away from the message.
   Nothing wraps now: the address gives way instead (see .uin-msg-address). */
.uin-msg-head {
  display: flex; flex-wrap: nowrap; gap: 0 0.5rem; align-items: center;
  padding: 0.5rem 0.75rem 0.35rem;
}
/* Tall enough to stand beside both lines rather than beside the first one. */
.uin-msg-head .uin-avatar { width: 2rem; height: 2rem; font-size: 0.6875rem; flex: 0 0 auto; }
/* The two lines: who it is from, then who it went to. Everything the header has
   to give is given from in here, which is why this is the item that flexes and
   the time and the tools beside it are the ones that do not. */
.uin-msg-head-lines {
  flex: 1 1 auto; min-width: 0;
  display: flex; flex-direction: column; gap: 0.05rem;
}
.uin-msg-head-line {
  display: flex; align-items: baseline; gap: 0.3rem;
  min-width: 0; overflow: hidden; white-space: nowrap;
  font-size: 0.8125rem; color: var(--color-text-secondary);
}
/* Quieter again, and smaller: who it went to is the answer to a question
   nobody asked until they went looking for it. */
.uin-msg-head-to { font-size: 0.6875rem; }
/* The name holds its full width until it would take up most of the line, which
   is the point at which it is the greedy one rather than the address. */
.uin-msg-who {
  font-size: 0.8125rem; font-weight: 600; color: var(--color-text);
  flex: 0 1 auto; max-width: 60%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* Everything the header has to give is taken from here. min-width: 0 is what
   lets it shrink below the width of its own text at all - a flex item will not,
   by default, and without it the header would simply overflow. */
.uin-msg-dir {
  display: inline-flex; align-items: center; gap: 0.25rem;
  flex: 1 1 auto; min-width: 0; overflow: hidden; white-space: nowrap;
  font-size: 0.6875rem; color: var(--color-text-secondary);
}
/* The words keep their full width - it is the address that gives way, not
   "Received from" turning into "Receiv". */
.uin-msg-dir-label { flex: 0 0 auto; }
/* The address itself, cut off with an ellipsis when the column is too narrow.
   AdminTooltip is the anchor and carries the first class; the span inside it
   is what actually clips, and what AddressLine measures to decide whether
   there is anything hidden worth a tooltip. */
.uin-msg-address { min-width: 0; overflow: hidden; }
.uin-msg-address-text {
  display: block; max-width: 100%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.uin-msg-when { margin-left: auto; flex: 0 0 auto; font-size: 0.6875rem; color: var(--color-text-muted); }
/* Same again on the note's amber ground and on the outbound tint, both of which
   are darker than the surfaces the muted tier was measured against. */
.uin-msg-note .uin-msg-when,
.uin-msg-out .uin-msg-when { color: var(--color-text-secondary); }
.uin-msg-body { padding: 0.35rem 0.75rem 0.75rem; }
/* pre-wrap keeps the sender's own line breaks and wraps at spaces - but a
   three-hundred character tracking link has no spaces in it, and without
   somewhere to break it the message is wider than the screen. */
.uin-msg-text {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
  font-size: 0.9375rem;
  line-height: 1.55;
  color: var(--color-text);
}
.uin-frame { width: 100%; border: 0; display: block; background: var(--color-surface); }
/* The remote-picture notice, kept deliberately quiet. It sits above every
   marketing email there is, and at the standard alert size it read as a warning
   about the message rather than as a footnote on how it was loaded. The button
   beside it keeps its own size - it is still something to press. */
.uin-remote-note { font-size: 10px; line-height: 1.5; }
.uin-msg-foot {
  display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center;
  padding: 0.4rem 0.75rem 0.55rem;
  font-size: 0.75rem;
}
.uin-attachment {
  display: inline-flex; align-items: center; gap: 0.35rem;
  padding: 0.2rem 0.5rem;
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  background: var(--color-surface);
  color: var(--color-text-secondary);
  text-decoration: none;
  font-size: 0.75rem;
}
/* The same strip turned the other way up: used above a message to say how it
   came to be sent rather than below it to say what came with it. It keeps its
   rule, because it is a warning about what follows rather than a footnote on
   what came before. */
.uin-msg-flag { border-bottom: 1px solid var(--color-border); padding-top: 0.5rem; }
/* Anything that acts on the message rather than describing it, pushed to the
   trailing end of the foot. margin-left:auto rather than a float: the foot is
   already a flex row, so this stays inside it and out of the message body. */
.uin-msg-actions { display: flex; gap: 0.5rem; align-items: center; margin-left: auto; }
.uin-attachment:hover { border-color: var(--color-border-strong); color: var(--color-text); text-decoration: none; }
/* ---- where a link actually goes ----------------------------------------- */
/* The address is the whole point of the panel, so it is the biggest thing in
   it, it wraps at any character - a tracking link is four hundred characters of
   no spaces - and it can be selected, because copying it into something that
   checks addresses is a perfectly sensible next move. */
.uin-peek .uin-modal-body { display: grid; gap: 0.6rem; }
.uin-peek-host { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.4rem; }
.uin-peek-host b { font-size: 1rem; font-weight: 650; word-break: break-all; }
.uin-peek-said { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.4rem; font-size: 0.8125rem; color: var(--color-text-secondary); }
.uin-peek-url {
  display: block;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.75rem;
  line-height: 1.55;
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius, 0.375rem);
  background: var(--color-surface-raised);
  color: var(--color-text);
  overflow-wrap: anywhere;
  word-break: break-all;
  user-select: all;
  max-height: 9rem;
  overflow-y: auto;
}

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
  font-size: 0.75rem;
  color: var(--color-text-muted);
}

/* ---- composer ----------------------------------------------------------- */
/* The box you write a reply in, under the conversation it answers. One outline
   and a quiet ground: it is a part of the thread, not a form that has landed on
   top of it. The toolbar strip underneath is what tells it apart from the
   messages above, in the way a mail program does. */
.uin-composer {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md, 0.5rem);
  background: var(--color-surface);
  box-shadow: var(--shadow-sm);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.uin-composer textarea {
  width: 100%;
  min-height: 8rem;
  resize: vertical;
  border: 0;
  border-radius: 0;
  background: none;
  padding: 0.7rem 0.75rem;
  font: inherit;
  font-size: 0.9375rem;
  line-height: 1.55;
  color: var(--color-text);
}
.uin-composer textarea:focus { outline: none; box-shadow: none; }
/* Which of the three is being written. A row of small chips at the very top,
   above the words, because it changes who the message is addressed to. */
.uin-composer-modes {
  display: flex; flex-wrap: wrap; gap: 0.3rem;
  padding: 0.5rem 0.625rem;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface-raised);
}
/* Everything you can do to the message, on one strip along the bottom - the
   place every mail program has kept it. */
.uin-composer-row {
  display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center;
  padding: 0.5rem 0.625rem;
  border-top: 1px solid var(--color-border);
  background: var(--color-surface-raised);
}
.uin-composer-row:first-child { border-top: 0; }

/* ---- dragging a file onto a message ------------------------------------- */
/* The target is whatever box the composer hangs this on, so it only has to
   provide the corner the overlay is measured from. */
.uin-droppable { position: relative; }
/* The tint drawn over that box while a file is over it. Deaf to the pointer, or
   it becomes the thing being dragged over.
   TWO grounds, so two tints - see this file's opening note. The reply composer
   is --color-surface, and the tint that differs from THAT in both themes is
   --color-surface-raised; the new-message card is --color-surface as well, so
   the same one serves. */
.uin-drop-overlay {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  border: 2px dashed var(--color-primary);
  border-radius: var(--radius-md, 0.5rem);
  background: var(--color-surface-raised);
  /* Enough to say "here", not so much that the message underneath disappears
     and somebody wonders what they are dropping onto. */
  opacity: 0.94;
}
.uin-modal-card .uin-drop-overlay { border-radius: var(--radius-lg, 0.75rem); }
.uin-drop-overlay-label {
  font-size: 0.875rem;
  font-weight: 650;
  color: var(--color-text);
}
.uin-drop-errors { list-style: none; margin: 0 0 0.5rem; padding: 0; display: grid; gap: 0.25rem; }
.uin-recipients { font-size: 0.75rem; color: var(--color-text-secondary); }

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
  border-radius: var(--radius-lg, 0.75rem);
  background: var(--color-surface);
  box-shadow: var(--shadow-xl);
  overflow: hidden;
}
.uin-modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.7rem 0.875rem;
  border-bottom: 1px solid var(--color-border);
}
.uin-modal-title { margin: 0; font-size: 0.9375rem; font-weight: 650; }
.uin-modal-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.85rem;
  height: 1.85rem;
  border-radius: var(--radius, 0.375rem);
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
  padding: 0.875rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
  min-height: 0;
}
/* The writing box is already inside a box. One outline is enough, and inside a
   dialog the toolbar strips lose their tint too - the card is the surface the
   whole thing sits on. */
.uin-modal .uin-composer {
  border: 0;
  border-radius: 0;
  background: none;
  box-shadow: none;
  display: flex;
  flex-direction: column;
  gap: 0;
  flex: 1 1 auto;
  min-height: 0;
  overflow: visible;
}
.uin-modal .uin-composer-row {
  padding-inline: 0;
  background: none;
}
.uin-modal .uin-composer-modes {
  padding-inline: 0;
  background: none;
}
.uin-modal .uin-composer textarea { padding-inline: 0; }
/* A new message gets a definite height so the box you write in can take up
   whatever the four lines above it do not, rather than sitting at a polite
   eight rows with a stripe of nothing under it. */
.uin-modal-card-compose { height: min(88vh, 50rem); }
/* A discussion, a text and a call are one short form apiece rather than a
   screenful, so the card is as tall as what is in it instead of reserving half
   the window for a box nobody is going to fill. */
.uin-modal-card-short { width: min(32rem, 100%); }

/* ---- asking twice ------------------------------------------------------- */
/* One question, two answers, and no more room than that needs. The answers sit
   on their own strip at the bottom so the question above them is never mistaken
   for one of them. */
.uin-modal-card-confirm { width: min(28rem, 100%); }
.uin-confirm-body {
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.55;
  color: var(--color-text-secondary);
}
.uin-modal-foot {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
  justify-content: flex-end;
  padding: 0.7rem 0.875rem;
  border-top: 1px solid var(--color-border);
  background: var(--color-surface-raised);
}

/* The four short answers at the top: label beside the box, one hairline between
   each, and as little air as the rows can be given without touching. No outline
   round the block - the hairlines between the rows are the whole of what a
   header block needs, and a box round four boxes is three boxes too many. */
.uin-fields {
  display: grid;
  border-bottom: 1px solid var(--color-border);
  flex: none;
}
.uin-field-row {
  display: grid;
  grid-template-columns: 4.25rem minmax(0, 1fr);
  align-items: center;
  gap: 0.5rem;
  padding: 0.1rem 0;
  border-bottom: 1px solid var(--color-border);
}
.uin-field-row:last-child { border-bottom: 0; }
.uin-field-row:focus-within .uin-field-label { color: var(--color-text); }
/* The hint beside it is muted, which does not clear AA on raised in dark. */
.uin-field-row:focus-within .uin-field-hint { color: var(--color-text-secondary); }
.uin-field-row > label {
  margin: 0;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-text-muted);
}
/* A row whose control is a group of tick boxes has no single field to point a
   <label> at, so it names the group with a span instead. Same look either way. */
.uin-field-row > .uin-field-label {
  margin: 0;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-text-muted);
}
.uin-field-control { display: flex; align-items: center; gap: 0.5rem; min-width: 0; }
/* Choosing which of the site's own addresses something is for. A short list of
   tick boxes rather than a box to type in, because the answers are known and
   typing one that is not on the list would be a message somebody thought they
   were sending. */
.uin-pick-list {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.05rem;
  max-height: 9rem;
  overflow-y: auto;
  padding: 0.25rem 0;
}
/* One address a line, and the whole line the thing you click. Baseline sat the
   tick box on the text's baseline, which left it hanging low beside a name;
   beside a name it belongs in the middle. */
.uin-pick {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  padding: 0.3rem 0.4rem;
  border-radius: 0.375rem;
  font-size: 0.8125rem;
  color: var(--color-text);
  cursor: pointer;
}
.uin-pick:hover { background: var(--color-surface-raised); }
.uin-pick input { flex: none; margin: 0; accent-color: var(--color-primary); }
/* The name takes what it needs, the address takes the rest, and both stop at an
   ellipsis rather than wrapping. Three stacked lines of "Emma (Marketing
   Manager)" is not a tidier answer than one line you can hover to read in full,
   and an address broken mid-word reads as a fault. */
.uin-pick-name {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.uin-pick:has(input:checked) .uin-pick-name { font-weight: 600; }
.uin-pick .uin-recipients {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
}
/* Borderless inside a ruled block: a box drawn round every line would be four
   boxes inside a box, and the row itself already says where to type. */
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
.uin-field-control input:focus,
.uin-field-control select:focus { outline: none; box-shadow: none; }
.uin-field-control select { max-width: 22rem; }
.uin-field-hint {
  flex: none;
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* A row whose note is a sentence rather than three words. Beside the field, a
   nowrap sentence takes the whole row and leaves the box a centimetre wide -
   which is precisely what "Call me at" looked like. Under it, the field gets
   the full width and the sentence gets to wrap. */
.uin-field-row--stack { align-items: start; }
.uin-field-row--stack > label,
.uin-field-row--stack > .uin-field-label { padding-top: 0.5rem; }
.uin-field-row--stack .uin-field-control {
  flex-direction: column;
  align-items: stretch;
  gap: 0;
  padding-bottom: 0.35rem;
}
.uin-field-row--stack .uin-field-hint {
  white-space: normal;
  overflow: visible;
  line-height: 1.45;
}
.uin-field-add {
  flex: none;
  border: 0;
  background: none;
  padding: 0.15rem 0.25rem;
  font: inherit;
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  cursor: pointer;
  text-decoration: underline;
}
.uin-field-add:hover { color: var(--color-text); }

/* The suggestion menu under To and Cc.
   The field itself keeps the borderless look of every other line, so the menu
   is the only thing that draws a box - anchored to the field rather than to the
   row, or a Cc line appearing underneath would shove it sideways. */
.uin-recipient-field { position: relative; flex: 1 1 auto; min-width: 0; display: flex; }
.uin-recipient-field input { flex: 1 1 auto; min-width: 0; }
.uin-suggestions {
  position: absolute;
  z-index: 3;
  top: calc(100% + 0.3rem);
  left: -0.5rem;
  right: -0.5rem;
  margin: 0;
  padding: 0.25rem;
  list-style: none;
  max-height: 17rem;
  overflow-y: auto;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md, 0.5rem);
  box-shadow: var(--shadow-lg);
}
.uin-suggestions-head,
.uin-suggestions-foot {
  padding: 0.35rem 0.5rem 0.3rem;
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}
.uin-suggestion {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.35rem 0.5rem;
  border-radius: var(--radius, 0.375rem);
  cursor: pointer;
  min-width: 0;
}
.uin-suggestion[data-active='1'] { background: var(--color-primary-subtle); }
.uin-suggestion-avatar {
  flex: none;
  width: 1.75rem;
  height: 1.75rem;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--color-surface-raised);
  border: 1px solid var(--color-border);
  font-size: 0.625rem;
  font-weight: 700;
  color: var(--color-text-secondary);
}
.uin-suggestion-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.35; }
.uin-suggestion-name {
  font-size: 0.8125rem;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.uin-suggestion-meta {
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* Nothing animates for somebody who asked the browser to stop it. */
@media (prefers-reduced-motion: no-preference) {
  .uin-suggestions { animation: uin-suggestions-in 120ms ease-out; }
  @keyframes uin-suggestions-in {
    from { opacity: 0; transform: translateY(-0.15rem); }
    to { opacity: 1; transform: none; }
  }
}

/* Everything the four lines above do not take. */
.uin-compose-message { flex: 1 1 auto; display: flex; min-height: 6rem; }
.uin-modal .uin-composer textarea {
  flex: 1 1 auto;
  width: 100%;
  min-height: 6rem;
  resize: none;
}
@media (max-width: 599px) {
  .uin-field-row { grid-template-columns: 3.25rem minmax(0, 1fr); }
  .uin-field-hint { display: none; }
  /* Except where the note is the point rather than a gloss - a stacked row is
     stacked because somebody needs to read it. */
  .uin-field-row--stack .uin-field-hint { display: block; }
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
/* Inside the list column the outline is already there, so the empty state drops
   its own rather than drawing a box inside a box. */
.uin-col-scroll > .uin-empty { border: 0; border-radius: 0; font-size: 0.8125rem; }

/* Every interactive thing on this screen shows where the keyboard is. */
.uin-app a:focus-visible,
.uin-app button:focus-visible,
.uin-app input:focus-visible,
.uin-app select:focus-visible,
.uin-app textarea:focus-visible,
.uin-modal a:focus-visible,
.uin-modal button:focus-visible,
.uin-modal input:focus-visible,
.uin-modal select:focus-visible,
.uin-modal textarea:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: 2px;
}
/* Except in a field row, where the box has no box of its own. A ring offset two
   pixels from a borderless full-width input lands on the hairlines above and
   below it and reads as something having gone wrong. The rule under the field
   goes solid instead: same "the keyboard is here", drawn where the field is. */
.uin-field-control input:focus-visible,
.uin-field-control select:focus-visible,
.uin-field-control textarea:focus-visible {
  outline: none;
  box-shadow: inset 0 -2px 0 0 var(--color-border-focus);
}

/* ---- the context panel -------------------------------------------------- */
/* What the rest of the site knows about whoever is on the other end. Flat
   sections ruled off from one another rather than a stack of cards: it is one
   panel about one person, and four outlines inside a bordered pane is three
   boxes too many. */
.uin-ctx {
  grid-area: ctx;
  display: block;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  background: var(--color-bg);
  border-top: 1px solid var(--color-border);
}
@media (min-width: 1500px) {
  .uin-ctx { border-top: 0; border-left: 1px solid var(--color-border); }
}
.uin-ctx-block {
  border: 0;
  border-bottom: 1px solid var(--color-border);
  border-radius: 0;
  background: none;
  padding: 0.75rem 0.875rem;
  display: grid;
  gap: 0.4rem;
  min-width: 0;
}
.uin-ctx-block:last-child { border-bottom: 0; }
/* A plain badge's own ground is --color-surface-raised, which is the identical
   colour to the panel behind it in light mode. On this one panel it takes the
   surface instead, which differs from --color-bg in both themes. */
.uin-ctx .uin-tag { background: var(--color-surface); }
.uin-ctx-heading {
  margin: 0;
  font-size: 0.6875rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-text-muted);
  font-weight: 700;
}
.uin-ctx-name { margin: 0; font-size: 0.9375rem; font-weight: 600; }
.uin-ctx-name a { color: var(--color-text); }
/* Secondary rather than muted: this carries real information - an address, a
   total, a date - and muted measures under AA against the panel in dark mode. */
.uin-ctx-sub { margin: 0; font-size: 0.8125rem; color: var(--color-text-secondary); word-break: break-word; }
.uin-ctx-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.45rem; }
.uin-ctx-row {
  display: grid;
  gap: 0.2rem;
  padding-bottom: 0.45rem;
  border-bottom: 1px solid var(--color-border);
  min-width: 0;
}
.uin-ctx-row:last-child { border-bottom: 0; padding-bottom: 0; }
.uin-ctx-main {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.8125rem;
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
   and about four is what a narrow panel can show without the block growing
   taller than the message beside it.
   Its fill is --color-bg-subtle, which differs from the panel's --color-bg in
   both themes; the hover is one step up to --color-surface-raised, which
   differs from bg-subtle in both. The label underlines too, because a 1.1:1
   lift is a hint rather than an answer. */
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
/* ---- a contact's card ---------------------------------------------------
   The form behind New contact, Edit their details and the importer. It reuses
   the composer's field rows (.uin-fields above) so an address book line and a
   Cc line are the same object, and adds only what a card needs on top: the
   headings between runs of rows, the one box that is a paragraph, and the tick
   the importer needs. Every colour is a token - a card is chrome. */
.uin-card { display: grid; gap: 1rem; min-width: 0; max-width: 46rem; }
.uin-card-section { display: grid; gap: 0.4rem; min-width: 0; }
/* The heading over each run of rows is .uin-ctx-heading - the same small-capital
   object the context panel uses - so a card and the panel beside it read as one
   screen and there is one rule for it rather than two that drift. */
.uin-card-notes { display: grid; gap: 0.3rem; min-width: 0; }
.uin-card-notes > label {
  margin: 0;
  font-size: 0.6875rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  font-weight: 700;
  color: var(--color-text-muted);
}
.uin-card-notes textarea {
  width: 100%;
  border: 1px solid var(--color-border);
  border-radius: var(--radius, 0.375rem);
  background: var(--color-surface);
  color: var(--color-text);
  padding: 0.5rem 0.625rem;
  font: inherit;
  font-size: 0.875rem;
  line-height: 1.55;
  resize: vertical;
}
.uin-card-notes textarea:focus {
  outline: none;
  border-color: var(--color-border-focus);
  box-shadow: 0 0 0 3px var(--color-primary-glow);
}
/* The one control on this screen with a sentence attached rather than a word,
   so the tick sits at the top of it rather than halfway down a paragraph. */
.uin-card-check {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.5rem;
  align-items: start;
  font-size: 0.8125rem;
  color: var(--color-text-secondary);
  margin: 0;
}
.uin-card-check input { margin-top: 0.2rem; }
/* A postal address on the lines it is posted on. The address element is italic
   by default in every browser, which a delivery address is not. */
.uin-postal { display: grid; font-style: normal; }

/* ---- category chips on a card -------------------------------------------
   Ticks in the shape of chips, so what a contact is filed under reads as the
   same object on the card as it does on the row and in the filter above the
   list. Pressed is said two ways over - the fill and the border both move -
   because a single tint is not a state anybody should have to notice, and
   aria-pressed carries it to a screen reader either way. */
.uin-categories { flex-wrap: wrap; align-items: center; gap: 0.35rem; padding: 0.25rem 0; }
.uin-category-chips { display: flex; flex-wrap: wrap; gap: 0.3rem; min-width: 0; }
.uin-category-chip {
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  border-radius: 999px;
  padding: 0.15rem 0.55rem;
  font: inherit;
  font-size: 0.75rem;
  line-height: 1.5;
  cursor: pointer;
}
.uin-category-chip:hover:not(:disabled) { color: var(--color-text); border-color: var(--color-border-strong); }
.uin-category-chip:disabled { cursor: default; opacity: 0.6; }
.uin-category-chip[aria-pressed="true"] {
  background: var(--color-primary-subtle);
  border-color: var(--color-primary-border);
  color: var(--color-text);
  font-weight: 600;
}
.uin-category-new { display: flex; align-items: center; gap: 0.3rem; min-width: 0; }
.uin-category-new input { min-width: 8rem; font-size: 0.8125rem; }

/* ---- one person --------------------------------------------------------- */
.uin-person { display: grid; gap: 0.875rem; align-items: start; min-width: 0; }
/* Two columns once the page itself is wide enough for two, which is not the
   same question as whether the window is. This pane sits beside the list, so a
   window query fired at 1100px on a pane that was 700px wide and split it into
   two columns that did not fit. */
@container uin-body (min-width: 62rem) {
  .uin-person { grid-template-columns: minmax(0, 1fr) minmax(14rem, 17rem); }
}
.uin-person-main { display: grid; gap: 0.625rem; min-width: 0; }
/* What has happened with somebody, down one line with the icons on it. Ruled
   between entries rather than boxed: it is one record read downwards, and a
   card per entry is forty outlines on a busy contact. */
.uin-timeline { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
.uin-timeline-row {
  display: grid;
  grid-template-columns: 1.25rem minmax(0, 1fr);
  grid-template-areas: "icon main" ". sub";
  gap: 0.15rem 0.5rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--color-border);
}
.uin-timeline-row:last-child { border-bottom: 0; padding-bottom: 0; }
.uin-timeline-icon { grid-area: icon; color: var(--color-text-muted); line-height: 1; padding-top: 0.15rem; }
.uin-timeline-row .uin-ctx-main { grid-area: main; }
.uin-timeline-row .uin-ctx-sub { grid-area: sub; }

/* ---- campaigns ---------------------------------------------------------- */
/* The same email to a great many people, slowly. The screen is a list of
   campaigns, and one campaign is ONE FORM down one column - who, what, when -
   with one save bar pinned to the bottom of it.
   Sections are ruled off rather than boxed. They used to be four outlined cards
   inside an outlined pane, each holding outlined blocks holding outlined
   fields, which is the whole of what made this screen feel like paperwork. */
.uin-camp-head {
  display: flex; flex-wrap: wrap; gap: 0.75rem;
  align-items: flex-start; justify-content: space-between;
  padding-bottom: 0.75rem;
  margin-bottom: 0.75rem;
  border-bottom: 1px solid var(--color-border);
}
.uin-camp-head-main { display: grid; gap: 0.3rem; min-width: 0; flex: 1 1 16rem; }
/* The name, typed where it is read. Borderless until it is hovered or focused,
   so it reads as a title rather than as the first field of a form - and shows
   it is one the moment somebody goes near it. */
.uin-camp-name-input {
  width: 100%;
  margin: 0;
  padding: 0.15rem 0.35rem;
  border: 1px solid transparent;
  border-radius: var(--radius, 0.375rem);
  background: none;
  font: inherit;
  font-size: 1.0625rem;
  font-weight: 650;
  line-height: 1.3;
  color: var(--color-text);
}
.uin-camp-name-input:hover { border-color: var(--color-border); }
.uin-camp-name-input:focus {
  outline: none;
  background: var(--color-surface);
  border-color: var(--color-border-focus);
  box-shadow: 0 0 0 3px var(--color-primary-glow);
}
.uin-camp-name-input::placeholder { color: var(--color-text-muted); font-weight: 400; }
.uin-camp-actions { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; }

.uin-camp-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
.uin-camp-card {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md, 0.5rem);
  background: var(--color-surface);
  padding: 0.75rem 0.875rem;
  display: grid; gap: 0.5rem;
}
.uin-camp-card:hover { border-color: var(--color-border-strong); }
.uin-camp-card[data-state="running"] { border-left: 3px solid var(--color-success); }
.uin-camp-card[data-state="paused"] { border-left: 3px solid var(--color-warning); }
.uin-camp-card[data-state="draft"] { border-left: 3px solid var(--color-border-strong, var(--color-border)); }
.uin-camp-card-top { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: baseline; justify-content: space-between; }
.uin-camp-name {
  font-weight: 650; font-size: 0.9375rem; color: var(--color-text);
  background: none; border: 0; padding: 0; cursor: pointer; text-align: left;
}
.uin-camp-name:hover { text-decoration: underline; }
.uin-camp-meta {
  color: var(--color-text-muted); font-size: 0.75rem;
  display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center;
}

/* The status word. Quiet: the progress bar is what the eye should land on. */
.uin-camp-pill {
  display: inline-flex; align-items: center; gap: 0.3rem;
  font-size: 0.6875rem; font-weight: 700; letter-spacing: 0.02em;
  padding: 0.1rem 0.45rem; border-radius: 999px;
  background: var(--color-surface-raised); color: var(--color-text-secondary);
  border: 1px solid var(--color-border);
}
.uin-camp-pill[data-state="running"] { color: var(--color-success); border-color: var(--color-success-border); background: var(--color-success-bg); }
.uin-camp-pill[data-state="paused"] { color: var(--color-warning); border-color: var(--color-warning-border); background: var(--color-warning-bg); }
.uin-camp-pill[data-state="stopped"], .uin-camp-pill[data-state="done"] { color: var(--color-text-muted); }

/* How far along it is. One bar, sent against the whole list, with the settled
   states stacked in it so a fortnight of sending reads at a glance. */
.uin-camp-bar {
  display: flex; height: 0.4rem; border-radius: 999px; overflow: hidden;
  background: var(--color-surface-raised); border: 1px solid var(--color-border);
}
.uin-camp-bar span { display: block; height: 100%; }
.uin-camp-bar span[data-kind="done"] { background: var(--color-text-muted); }
.uin-camp-bar span[data-kind="replied"] { background: var(--color-success); }
.uin-camp-bar span[data-kind="bad"] { background: var(--color-danger); }
.uin-camp-bar span[data-kind="off"] { background: var(--color-warning); }
.uin-camp-legend {
  display: flex; flex-wrap: wrap; gap: 0.6rem;
  font-size: 0.75rem; color: var(--color-text-muted);
}
.uin-camp-legend b { color: var(--color-text); font-weight: 650; }

/* One section of the form: a heading and a hairline, not a card. */
.uin-camp-section {
  display: grid; gap: 0.625rem;
  padding: 0 0 1rem;
  margin-bottom: 1rem;
  border-bottom: 1px solid var(--color-border);
}
.uin-camp-section:last-of-type { border-bottom: 0; }
/* The two that are not part of the form - a warning to read, a question to
   answer - keep an outline, because they are not a section of anything. */
.uin-camp-section[data-tone] {
  padding: 0.875rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md, 0.5rem);
  background: var(--color-surface);
}
.uin-camp-section[data-tone="problem"] { border-color: var(--color-destructive-border); }
.uin-camp-section[data-tone="warning"] { border-color: var(--color-warning-border); }
.uin-camp-section > h3 {
  margin: 0; font-size: 0.9375rem; font-weight: 650;
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.5rem;
}
.uin-camp-section > h3 small { font-weight: 400; color: var(--color-text-muted); font-size: 0.75rem; }

/* A block inside a section - one of the follow-ups, the sign-off boxes, the
   test send. Ruled off rather than boxed, so a section still reads as one
   thing with one save behind it. */
.uin-camp-part { display: grid; gap: 0.625rem; padding-top: 0.75rem; border-top: 1px solid var(--color-border); }
.uin-camp-section > .uin-camp-part:first-of-type { padding-top: 0; border-top: 0; }
.uin-camp-part-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.5rem; }
.uin-camp-part-head strong { font-size: 0.8125rem; }
.uin-camp-part-head .btn { margin-left: auto; }

/* How many people this comes to. The one number on the page somebody actually
   reads, so it is not a hint. */
.uin-camp-count { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.4rem; font-size: 0.8125rem; }
.uin-camp-count b { font-size: 1.375rem; font-weight: 650; }
.uin-camp-count > span { color: var(--color-text-muted); }

/* The pace, as a sentence rather than as seven boxes. It is the ANSWER the
   boxes add up to, so it is set like an answer and not like a hint. */
.uin-camp-pace {
  display: grid; gap: 0.2rem;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md, 0.5rem);
  background: var(--color-surface-raised);
}
.uin-camp-pace-line { margin: 0; font-size: 0.875rem; font-weight: 600; color: var(--color-text); }

/* The detail somebody only wants when they want it: who was left out and why,
   how it reads, what keeps it ticking over, and every knob on the clock. */
.uin-camp-why {
  border: 1px solid var(--color-border); border-radius: var(--radius-md, 0.5rem);
  background: var(--color-surface); padding: 0.5rem 0.75rem;
  display: grid; gap: 0.5rem; font-size: 0.8125rem;
}
.uin-camp-why > summary {
  cursor: pointer; color: var(--color-text-secondary); font-size: 0.8125rem; font-weight: 600;
  list-style: none;
}
.uin-camp-why > summary::-webkit-details-marker { display: none; }
/* A turned triangle in front of it, so a closed drawer reads as one rather than
   as a line of text somebody has underlined. */
.uin-camp-why > summary::before {
  content: "";
  display: inline-block;
  width: 0; height: 0;
  margin-right: 0.45rem;
  border-left: 0.35rem solid currentColor;
  border-top: 0.25rem solid transparent;
  border-bottom: 0.25rem solid transparent;
  vertical-align: 0.05rem;
  transition: transform var(--dur-fast, 100ms) var(--ease-out, ease-out);
}
.uin-camp-why[open] > summary::before { transform: rotate(90deg); }
@media (prefers-reduced-motion: reduce) {
  .uin-camp-why > summary::before { transition: none; }
}
.uin-camp-why > summary:hover { color: var(--color-text); }
.uin-camp-why[open] > summary { margin-bottom: 0.15rem; }

/* THE ONE SAVE BAR. Pinned to the bottom of the panel, same place on every
   status and on both halves of the screen, because "where do I save this" is
   the question this whole screen was rebuilt to stop anybody asking. */
.uin-camp-bar-actions {
  position: sticky; bottom: 0; z-index: 2;
  display: flex; flex-wrap: wrap; gap: 0.75rem;
  align-items: center; justify-content: space-between;
  padding: 0.625rem 0.875rem;
  margin-top: 1rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md, 0.5rem);
  background: var(--color-surface);
  box-shadow: var(--shadow-lg);
}
.uin-camp-bar-actions > .uin-camp-hint { flex: 1 1 12rem; font-size: 0.75rem; color: var(--color-text-muted); }
.uin-camp-field { display: grid; gap: 0.25rem; }
.uin-camp-field > label { font-size: 0.75rem; font-weight: 600; color: var(--color-text-secondary); }
.uin-camp-hint { font-size: 0.75rem; color: var(--color-text-muted); }
.uin-camp-row { display: flex; flex-wrap: wrap; gap: 0.625rem; align-items: flex-end; }
.uin-camp-row > .uin-camp-field { flex: 1 1 10rem; min-width: 0; }
.uin-camp-check { display: flex; align-items: flex-start; gap: 0.5rem; font-size: 0.8125rem; }
.uin-camp-check input { margin-top: 0.2rem; }

/* The labels somebody picks the audience from. Same object as the category
   chips on a contact's card, and dressed the same. */
.uin-camp-cats { display: flex; flex-wrap: wrap; gap: 0.35rem; }
.uin-camp-cat {
  display: inline-flex; align-items: center; gap: 0.3rem;
  border: 1px solid var(--color-border); border-radius: 999px;
  padding: 0.15rem 0.55rem; font: inherit; font-size: 0.75rem; cursor: pointer;
  background: var(--color-surface); color: var(--color-text-secondary);
}
.uin-camp-cat:hover:not(:disabled) { color: var(--color-text); border-color: var(--color-border-strong); }
.uin-camp-cat:disabled { cursor: default; opacity: 0.6; }
.uin-camp-cat[data-on="1"] {
  background: var(--color-primary-subtle);
  border-color: var(--color-primary-border);
  color: var(--color-text);
  font-weight: 600;
}

/* The merge tags, as a row of buttons that type themselves into the box. */
.uin-camp-tags { display: flex; flex-wrap: wrap; gap: 0.3rem; }
.uin-camp-tag {
  font-family: var(--font-mono, ui-monospace, monospace); font-size: 0.6875rem;
  border: 1px dashed var(--color-border); border-radius: var(--radius-sm, 0.25rem);
  padding: 0.1rem 0.35rem; background: var(--color-surface-raised);
  color: var(--color-text-muted); cursor: pointer;
}
.uin-camp-tag:hover { color: var(--color-text); border-style: solid; }

/* What it will look like, for three real people off the list. */
.uin-camp-preview {
  border: 1px solid var(--color-border); border-radius: var(--radius, 0.375rem);
  background: var(--color-surface-raised); padding: 0.625rem; display: grid; gap: 0.35rem;
}
.uin-camp-preview-to { font-size: 0.6875rem; color: var(--color-text-muted); }
.uin-camp-preview-subject { font-weight: 650; font-size: 0.875rem; }
.uin-camp-preview-body { white-space: pre-wrap; font-size: 0.8125rem; line-height: 1.55; }

/* Problems stop it. Warnings can be pressed past. */
.uin-camp-checks { display: grid; gap: 0.4rem; margin: 0; padding: 0; list-style: none; }
.uin-camp-checks li {
  display: grid; grid-template-columns: 1.1rem minmax(0, 1fr); gap: 0.5rem;
  font-size: 0.8125rem; align-items: start; line-height: 1.5;
}
.uin-camp-checks li[data-level="problem"] { color: var(--color-danger); }
.uin-camp-checks li[data-level="warning"] { color: var(--color-warning); }

/* The Watch table. */
.uin-camp-table { width: 100%; border-collapse: collapse; font-size: 0.8125rem; }
.uin-camp-table th {
  text-align: left; font-size: 0.6875rem; text-transform: uppercase; letter-spacing: 0.05em;
  color: var(--color-text-muted); font-weight: 700;
  padding: 0.4rem 0.5rem; border-bottom: 1px solid var(--color-border);
}
.uin-camp-table td { padding: 0.45rem 0.5rem; border-bottom: 1px solid var(--color-border); }
.uin-camp-table tr:last-child td { border-bottom: 0; }
.uin-camp-table td[data-state] { white-space: nowrap; }
.uin-camp-table td[data-state="replied"] { color: var(--color-success); }
.uin-camp-table td[data-state="bounced"], .uin-camp-table td[data-state="failed"],
.uin-camp-table td[data-state="complained"] { color: var(--color-danger); }
.uin-camp-table td[data-state="unsubscribed"], .uin-camp-table td[data-state="skipped"] { color: var(--color-warning); }
.uin-camp-scroll { overflow-x: auto; }

/* The state filter above the table. */
.uin-camp-filters { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-bottom: 0.6rem; }

/* The line that says which clock is driving it, under the progress bar. */
.uin-camp-clock {
  font-size: 0.75rem; color: var(--color-text-muted);
  display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center;
}
.uin-camp-clock code {
  font-size: 0.6875rem; background: var(--color-surface-raised);
  border: 1px solid var(--color-border); border-radius: var(--radius-sm, 0.25rem); padding: 0.1rem 0.35rem;
  word-break: break-all;
}

/* ---- searching everything, from anywhere -------------------------------- */
/* The magnifier at the head of the rail, on the left of the pen: find
   something, or write something. Quieter than the pen on purpose - writing is
   the act this hub is for, and two buttons shouting at each other beside
   somebody's own name is one too many. */
.uin-rail-search {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.85rem;
  height: 1.85rem;
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius, 0.375rem);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  cursor: pointer;
}
.uin-rail-search:hover {
  border-color: var(--color-border-strong);
  color: var(--color-text);
}
.uin-rail-search svg { display: block; }
/* Lying down, the rail is a strip and the name goes; both buttons stay, so the
   pair keeps a gap between them rather than sitting flush. */
@media (max-width: 1199px) {
  .uin-rail-me { gap: 0.35rem; }
}

/* The dialog itself. Wider than the short composers because it is a form of two
   columns rather than one, and the head of it is one big box that reads as a
   search box at a glance. */
.uin-search-card { width: min(46rem, 100%); }
.uin-search-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.7rem 0.875rem;
  border-bottom: 1px solid var(--color-border);
}
.uin-search-head .uin-search-icon svg { width: 18px; height: 18px; }
.uin-search-head input {
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  background: none;
  padding: 0.25rem 0;
  font-size: 1rem;
  color: var(--color-text);
}
.uin-search-head input:focus { outline: none; box-shadow: none; }
.uin-search-body { gap: 0.75rem; }
.uin-search-modes { display: flex; gap: 0.35rem; align-items: center; }
.uin-search-note { margin: 0; font-size: 0.8125rem; color: var(--color-text-secondary); }
/* Two columns where there is room for two, one where there is not. The subject
   takes the width of both, because a subject line is longer than a name and a
   box half the width of the sentence it holds invites half a sentence. */
.uin-search-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 13rem), 1fr));
  gap: 0.6rem;
}
.uin-field { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
.uin-field > span {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-text-secondary);
}
.uin-field input,
.uin-field select {
  width: 100%;
  min-width: 0;
  font-size: 0.8125rem;
}
.uin-field-wide { grid-column: 1 / -1; }
.uin-search-ticks {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: center;
}
.uin-tick {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.8125rem;
  color: var(--color-text);
}
.uin-tick input { margin: 0; }
/* The hint pushes the two buttons to the far end, so the thing to press is
   where a dialog always keeps it. */
.uin-search-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  padding: 0.7rem 0.875rem;
  border-top: 1px solid var(--color-border);
}
.uin-search-hint {
  margin: 0 auto 0 0;
  font-size: 0.75rem;
  color: var(--color-text-muted);
}

/* ---- a button that opens a panel ---------------------------------------- */
/* Five of these on one conversation - the dots on a message, who it is with,
   where it stands, when it comes back, and the month inside that. They share
   one component (Dropdown.tsx) and one set of clothes. The panel is drawn fixed
   and positioned from its button, because every one of them hangs off a header
   pinned inside a pane that scrolls its own contents: a panel drawn inside that
   pane is a panel clipped by it. Above everything core puts on an admin page,
   for the same reason the dialogs are - the bell's dropdown sits at 9999. */
.uin-dropdown { display: inline-flex; }
.uin-menu {
  position: fixed;
  z-index: 10000;
  max-width: calc(100vw - 1rem);
  max-height: min(70vh, 34rem);
  overflow-y: auto;
  padding: 0.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md, 0.5rem);
  background: var(--color-surface);
  box-shadow: var(--shadow-xl);
}
/* What the panel is for, when the button it opened from is an icon and cannot
   say. Centred and ruled off, the way a phone puts a title on a sheet. */
.uin-menu-title {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.4rem 0.5rem 0.45rem;
  margin-bottom: 0.15rem;
  border-bottom: 1px solid var(--color-border);
  font-size: 0.8125rem;
  font-weight: 650;
  color: var(--color-text);
}
.uin-menu-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.45rem 0.5rem;
  border: 0;
  border-radius: var(--radius, 0.375rem);
  background: none;
  color: var(--color-text);
  font: inherit;
  font-size: 0.8125rem;
  text-align: left;
  cursor: pointer;
}
.uin-menu-item:hover:not(:disabled),
.uin-menu-item:focus-visible { background: var(--color-surface-raised); }
.uin-menu-item:disabled { color: var(--color-text-disabled); cursor: default; }
.uin-menu-item-icon { flex: none; display: inline-flex; color: var(--color-text-secondary); }
.uin-menu-item-label { flex: 1 1 auto; min-width: 0; }
/* The day a snooze actually lands on, or the name it is already with. Secondary
   rather than muted: it lands on the raised ground when hovered, which muted
   does not clear AA against. */
.uin-menu-item-hint {
  flex: none;
  font-size: 0.75rem;
  color: var(--color-text-secondary);
}
.uin-menu-item-after { flex: none; display: inline-flex; color: var(--color-text-secondary); }
.uin-menu-sep { height: 1px; margin: 0.2rem 0.25rem; background: var(--color-border); }
/* A panel with two halves to it - the filters, and the names behind them. The
   way back sits hard left so the title stays put when the panel swaps what is
   in it, rather than sliding across as the words change. */
.uin-menu-back { justify-content: center; position: relative; }
.uin-menu-back .uin-icon-btn { position: absolute; left: 0.15rem; }
/* Finding one colleague among thirty. Same box as the search over the list, at
   the width of the panel it is in. */
.uin-menu-search {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin: 0.1rem 0.25rem 0.25rem;
  padding: 0 0.5rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius, 0.375rem);
  background: var(--color-bg);
  color: var(--color-text-muted);
}
.uin-menu-search:focus-within {
  border-color: var(--color-border-focus);
  box-shadow: 0 0 0 3px var(--color-primary-glow);
}
.uin-menu-search svg { display: block; width: 14px; height: 14px; }
.uin-menu-search input {
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  background: none;
  padding: 0.35rem 0;
  font-size: 0.8125rem;
  color: var(--color-text);
}
.uin-menu-search input:focus { outline: none; box-shadow: none; }
.uin-menu-empty {
  margin: 0;
  padding: 0.45rem 0.5rem;
  font-size: 0.75rem;
  color: var(--color-text-secondary);
}

/* ---- a button that is only an icon -------------------------------------- */
/* No border until it is wanted, so a run of them beside a name reads as marks
   on the message rather than as a toolbar bolted to it. Big enough to hit on a
   phone either way: 28px of box round a 16px icon. */
.uin-icon-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius, 0.375rem);
  background: none;
  color: var(--color-text-secondary);
  cursor: pointer;
}
.uin-icon-btn:hover:not(:disabled),
.uin-icon-btn[aria-expanded="true"] {
  background: var(--color-surface-raised);
  border-color: var(--color-border);
  color: var(--color-text);
}
.uin-icon-btn:disabled { color: var(--color-text-disabled); cursor: default; }
/* The one in the row of actions keeps its outline whatever it is doing: it is
   standing beside a real button there, and an invisible control next to a
   visible one reads as something that failed to draw. */
.uin-icon-btn-framed {
  height: 1.875rem;
  border-color: var(--color-border);
  background: var(--color-surface);
}
/* Tinted while any filter is on. The chips under the tabs say which ones, but
   the button has to admit there are some before anybody thinks to look. */
.uin-icon-btn-on,
.uin-icon-btn-on:hover:not(:disabled) {
  background: var(--color-primary-subtle);
  border-color: var(--color-primary-border);
  color: var(--color-text);
}

/* ---- answering a message ------------------------------------------------ */
/* The arrow and the dots, at the trailing end of the message header. After the
   time, which already has the margin that pushes the whole tail over. */
.uin-msg-tools { display: inline-flex; align-items: center; gap: 0.1rem; margin-left: 0.15rem; flex: 0 0 auto; }
/* Why there is no arrow anywhere on this conversation. */
.uin-thread-cannot { margin: 0; font-size: 0.75rem; color: var(--color-text-secondary); }

/* ---- where the conversation stands -------------------------------------- */
/* Whose it is on the left, the clock and the state hard against the far edge -
   the two you press on the way out of a conversation, together. Both the word
   buttons carry the arrow, so a menu behind a word looks like a menu whichever
   of them you are looking at. */
.uin-status-btn { display: inline-flex; align-items: center; gap: 0.2rem; }
.uin-status-btn svg { margin-right: -0.15rem; }

/* ---- when it comes back ------------------------------------------------- */
.uin-menu-snooze { padding-bottom: 0.35rem; }
.uin-cal { display: flex; flex-direction: column; gap: 0.4rem; }
/* The way back to the ready-made times, then the word. The button is pulled
   left so the title stays where it was when the panel swapped what is in it. */
.uin-cal-title { justify-content: center; position: relative; }
.uin-cal-title .uin-icon-btn { position: absolute; left: 0.15rem; }
.uin-cal-month {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.25rem;
  padding: 0 0.35rem;
  font-size: 0.8125rem;
  font-weight: 600;
}
.uin-cal-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 0.1rem;
  padding: 0 0.25rem;
}
.uin-cal-weekday {
  text-align: center;
  padding-bottom: 0.2rem;
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--color-text-secondary);
}
.uin-cal-day {
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 1;
  min-height: 1.9rem;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius, 0.375rem);
  background: none;
  color: var(--color-text);
  font: inherit;
  font-size: 0.8125rem;
  cursor: pointer;
}
.uin-cal-day:hover:not(:disabled) { background: var(--color-surface-raised); border-color: var(--color-border); }
/* A day either side of the month being shown. Kept rather than left blank - a
   month with holes in its corners is harder to read than one with its
   neighbours in - and told apart by weight, not by colour alone. */
.uin-cal-day[data-outside="1"] { color: var(--color-text-muted); }
.uin-cal-day:disabled { color: var(--color-text-disabled); cursor: default; }
/* Today, and the day picked. Today is a ring so that picking it can still fill
   it in: two states, two different marks. */
.uin-cal-day[data-today="1"] { border-color: var(--color-primary-border); font-weight: 650; }
.uin-cal-day[aria-pressed="true"] {
  background: var(--color-primary-subtle);
  border-color: var(--color-primary);
  color: var(--color-text);
  font-weight: 650;
}
.uin-cal-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem;
  padding: 0.45rem 0.35rem 0;
  border-top: 1px solid var(--color-border);
  margin-top: 0.15rem;
}
.uin-cal-field { display: flex; flex-direction: column; gap: 0.2rem; min-width: 0; }
.uin-cal-field span { font-size: 0.6875rem; font-weight: 600; color: var(--color-text-secondary); }
.uin-cal-field input {
  width: 100%;
  min-width: 0;
  height: 2rem;
  padding: 0 0.45rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius, 0.375rem);
  background: var(--color-surface);
  color: var(--color-text);
  font-family: inherit;
  font-size: 0.8125rem;
}
.uin-cal-field input:focus {
  outline: none;
  border-color: var(--color-border-focus);
  box-shadow: 0 0 0 3px var(--color-primary-glow);
}
.uin-cal-error {
  margin: 0;
  padding: 0 0.35rem;
  font-size: 0.75rem;
  color: var(--color-destructive-hover);
}
.uin-cal-buttons { display: flex; justify-content: flex-end; gap: 0.4rem; padding: 0.2rem 0.35rem 0; }

/* ---- the note bar ------------------------------------------------------- */
/* One line for saying something to the people you work with, pinned to the
   bottom of the conversation. Amber, and it says so in words, because a note
   that reads as a reply is how something private ends up sounding like it was
   sent to the customer.
   Sticky rather than fixed: it keeps its place in the flow, so the last message
   in a thread is never hidden underneath it. */
.uin-notebar {
  position: sticky;
  bottom: 0;
  z-index: 2;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  padding: 0.5rem 1rem;
  border-top: 1px solid var(--color-warning-border);
  background: var(--color-warning-bg);
}
.uin-notebar-icon { flex: none; display: inline-flex; color: var(--color-warning); }
.uin-notebar-input {
  flex: 1 1 12rem;
  min-width: 0;
  height: 2rem;
  padding: 0 0.55rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius, 0.375rem);
  background: var(--color-surface);
  color: var(--color-text);
  font-family: inherit;
  font-size: 0.8125rem;
}
.uin-notebar-input:focus {
  outline: none;
  border-color: var(--color-border-focus);
  box-shadow: 0 0 0 3px var(--color-primary-glow);
}
.uin-notebar-send { flex: none; display: inline-flex; align-items: center; gap: 0.3rem; }
.uin-notebar-send-icon { display: inline-flex; }
.uin-notebar-error {
  flex: 1 1 100%;
  margin: 0;
  font-size: 0.75rem;
  color: var(--color-destructive-hover);
}

/* ---- being asked to look at something ----------------------------------- */
/* A colleague tagging you in an internal note. The rows in "Asked me", the
   banner at the top of a conversation somebody put your name on, and the
   controls that settle YOUR copy of it - which are not the conversation's own
   buttons, and must not read as though they were.
   Primary rather than amber: amber is this module's colour for "the customer
   never sees this", and it is already carrying the notes themselves and the bar
   they are written in. A third amber thing on the same screen says nothing. */
.uin-ask-item > .uin-ask-actions {
  display: flex;
  flex: none;
  align-items: flex-start;
  gap: 0.3rem;
  padding: 0.55rem 0.65rem 0 0.3rem;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
}
.uin-list > li:last-child > .uin-ask-actions { border-bottom: 0; }
.uin-list-item:has(.uin-row:hover) > .uin-ask-actions { background: var(--color-surface-raised); }
/* What they actually said, which is why the row is here at all. Given the
   subject line's weight, since it is doing the subject line's job. */
.uin-ask-note { font-style: italic; }
.uin-ask-about { display: inline-flex; vertical-align: -0.15em; margin-right: 0.3rem; opacity: 0.75; }
.uin-ask-channel { color: var(--color-text-muted); }

/* The banner at the top of a conversation somebody was asked about. */
.uin-asked {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 0.75rem;
  margin: 0 0 0.75rem;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--color-primary-border);
  border-radius: var(--radius, 0.375rem);
  background: var(--color-primary-subtle);
  color: var(--color-text);
  font-size: 0.8125rem;
}
.uin-asked-icon { flex: none; display: inline-flex; color: var(--color-primary); }
.uin-asked-said { flex: 1 1 14rem; min-width: 0; display: flex; flex-direction: column; gap: 0.15rem; }
.uin-asked-note { color: var(--color-text-secondary); }
.uin-asked-state { color: var(--color-text-muted); font-size: 0.75rem; }
.uin-asked .uin-ask-actions { display: flex; flex: none; align-items: center; gap: 0.3rem; }

/* ---- tagging a colleague from the note bar ------------------------------ */
/* The names sit under the line rather than in a panel over it: they are wanted
   at the same time as the sentence rather than instead of it, and a menu that
   covers the note being written is a menu you close to check what you said. */
.uin-notebar-tag { flex: none; position: relative; }
.uin-notebar-tag-count {
  position: absolute;
  top: -0.25rem;
  right: -0.25rem;
  min-width: 1rem;
  padding: 0 0.2rem;
  border-radius: 0.5rem;
  background: var(--color-primary);
  color: var(--color-surface);
  font-size: 0.625rem;
  line-height: 1rem;
  text-align: center;
}
.uin-notebar-tags {
  flex: 1 1 100%;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem;
  padding-top: 0.15rem;
}
.uin-notebar-find {
  flex: 0 1 11rem;
  min-width: 0;
  height: 1.75rem;
  padding: 0 0.5rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius, 0.375rem);
  background: var(--color-surface);
  color: var(--color-text);
  font-family: inherit;
  font-size: 0.75rem;
}
.uin-notebar-find:focus {
  outline: none;
  border-color: var(--color-border-focus);
  box-shadow: 0 0 0 3px var(--color-primary-glow);
}
/* The surprising half, said out loud: a tag hands somebody a job AND lets them
   into this one conversation, which is not what a mention means anywhere else. */
.uin-notebar-tagnote {
  flex: 1 1 100%;
  margin: 0;
  font-size: 0.75rem;
  color: var(--color-text-secondary);
}

/* ---- the reply box's own header block ----------------------------------- */
/* The reply box now opens with the same ruled lines the new-message dialog has
   had all along: who it is going to, and whichever of Cc, Bcc and Subject
   somebody has asked for. Under a conversation it needs the padding the dialog
   gets from the card around it; popped out it is inside that card and must not
   have it twice. */
.uin-composer > .uin-fields {
  padding-inline: 0.625rem;
  background: var(--color-surface-raised);
}
.uin-modal .uin-composer > .uin-fields { padding-inline: 0; background: none; }
.uin-composer-aside { margin: 0; padding: 0.5rem 0.625rem; }
.uin-modal .uin-composer-aside { padding-inline: 0; }
/* Cc, Bcc, Subject and the way out to a window of its own, at the right-hand
   end of the To line. None of them takes a line of its own until it is asked
   for, which is the point: a reply that wants none of them - nearly every
   reply - never sees them. */
.uin-field-links {
  flex: none;
  display: flex;
  align-items: center;
  gap: 0.15rem;
}
.uin-field-pop { width: 1.6rem; height: 1.6rem; }

/* ---- the strip along the bottom ----------------------------------------- */
/* Two icons on the left for what you do TO the message, the ways it can leave
   on the right, and a gap between them so the two groups do not read as one
   row of six buttons. */
.uin-composer-actions { gap: 0.35rem; }
.uin-composer-gap { flex: 1 1 auto; min-width: 0.5rem; }
/* A time picked off the alarm clock and not yet committed, on the line above
   the buttons that commit it. */
.uin-pending-send { border-top: 0; padding-top: 0; }
/* The box that narrows a long list of colleagues, on the same line as the names
   rather than above them - it is a filter, not a field. */
.uin-mention-search { flex: 0 1 14rem; min-width: 8rem; display: flex; }
.uin-mention-search input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 0.25rem 0.5rem;
  font-size: 0.8125rem;
}
@media (max-width: 599px) {
  /* Four ways to send will not sit on one phone-width line, so they wrap - and
     the gap that pushed them right would otherwise leave a whole empty row
     above them. */
  .uin-composer-gap { flex-basis: 0; min-width: 0; }
}

/* ---- the writing box, and what it can be made to say --------------------- */
/* Six buttons and seven colours: bold, italic, a colour, a link and the two
   kinds of list. Everything past that is a way to make an email look assembled
   rather than written, and half of it is rendered differently by every inbox it
   lands in. The strip sits above the words rather than below them, which is
   where every mail program has kept it. */
.uin-richtext { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.uin-richtext-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.25rem;
  padding: 0.35rem 0.625rem;
  border-bottom: 1px solid var(--color-border);
}
.uin-modal .uin-richtext-bar { padding-inline: 0; }
.uin-rt-btn { width: 1.7rem; height: 1.7rem; font-size: 0.8125rem; line-height: 1; }
/* The colours are content, not chrome: they are read in somebody else's inbox,
   where this site's tokens mean nothing. The frame round them is chrome, and is
   tokens as usual. */
.uin-rt-ink {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  padding: 0.1rem 0.3rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius, 0.375rem);
  color: var(--color-text-muted);
}
.uin-rt-ink-icon { display: inline-flex; }
.uin-rt-swatch {
  width: 0.95rem;
  height: 0.95rem;
  padding: 0;
  border: 1px solid var(--color-border-strong);
  border-radius: 50%;
  cursor: pointer;
}
.uin-rt-swatch:hover { outline: 2px solid var(--color-border-focus); outline-offset: 1px; }
.uin-rt-swatch:focus-visible { outline: 2px solid var(--color-border-focus); outline-offset: 1px; }
/* Where a link is typed. A line that appears when it is wanted rather than a
   browser dialog: a prompt() box cannot say what went wrong, and "that does not
   look like an address" is the whole of what somebody needs told. */
.uin-rt-link {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.625rem;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface-raised);
}
.uin-modal .uin-rt-link { padding-inline: 0; background: none; }
.uin-rt-link input {
  flex: 1 1 12rem;
  min-width: 0;
  padding: 0.3rem 0.5rem;
  font-size: 0.8125rem;
}
.uin-rt-link-problem { flex: 1 1 100%; font-size: 0.75rem; color: var(--color-destructive-hover); }
/* The words themselves. Same measurements the box had when it was a textarea,
   so nothing about the writing moved when the formatting arrived. */
.uin-richtext-box {
  flex: 1 1 auto;
  width: 100%;
  min-height: 8rem;
  max-height: 32rem;
  overflow-y: auto;
  padding: 0.7rem 0.75rem;
  font-size: 0.9375rem;
  line-height: 1.55;
  color: var(--color-text);
  outline: none;
  overflow-wrap: anywhere;
}
.uin-modal .uin-richtext-box { padding-inline: 0; max-height: none; }
.uin-richtext-box:empty::before {
  content: attr(data-placeholder);
  color: var(--color-text-muted);
  pointer-events: none;
}
/* What the six buttons produce, drawn as the recipient will see it rather than
   as the admin's own body text. */
.uin-richtext-box a { color: var(--color-link, var(--color-primary)); }
.uin-richtext-box ul, .uin-richtext-box ol { margin: 0.4rem 0; padding-left: 1.5rem; }
.uin-richtext-box li { margin: 0.15rem 0; }

`

export function InboxStyles() {
  return <style dangerouslySetInnerHTML={{ __html: CSS }} />
}

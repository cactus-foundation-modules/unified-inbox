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
.uin-chip-clear { max-width: 20rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

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
@media (min-width: 900px) {
  .uin[data-thread="open"] { grid-template-columns: minmax(17rem, 23rem) minmax(0, 1.7fr); }
  /* Below the wide breakpoint the context panel goes under the conversation
     rather than beside it. Squeezing a third column into 900px leaves the
     conversation too narrow to read, and the conversation is what somebody came
     here for. */
  .uin[data-context="on"] .uin-ctx { grid-column: 1 / -1; }
  /* The list keeps its place while a long conversation scrolls past it, and
     scrolls its own overflow rather than the page's. */
  .uin[data-thread="open"] .uin-listpane {
    position: sticky;
    top: 0.75rem;
    max-height: calc(100vh - 7rem);
    overflow-x: hidden;
    overflow-y: auto;
  }
}
@media (min-width: 1400px) {
  .uin[data-thread="open"][data-context="on"] {
    grid-template-columns: minmax(16rem, 21rem) minmax(0, 1.6fr) minmax(15rem, 19rem);
  }
  .uin[data-context="on"] .uin-ctx { grid-column: auto; }
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
     a column beside a conversation once something is. */
  container-type: inline-size;
}
.uin-list { display: block; list-style: none; margin: 0; padding: 0; }
.uin-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 0.25rem 0.75rem;
  align-items: start;
  padding: 0.7rem 0.875rem;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
  text-decoration: none;
  color: var(--color-text);
}
.uin-list > li:last-child .uin-row { border-bottom: 0; }
.uin-row:hover { background: var(--color-bg-subtle); text-decoration: none; }
.uin-row[aria-current="true"] {
  background: var(--color-primary-subtle);
  box-shadow: inset 3px 0 0 0 var(--color-primary);
}
/* Muted grey clears AA on the ordinary surface but not on the tinted one the
   open conversation sits on, so its secondary text steps up a tier. */
.uin-row[aria-current="true"] .uin-row-preview,
.uin-row[aria-current="true"] .uin-row-meta { color: var(--color-text-secondary); }

.uin-avatar-wrap { position: relative; flex: none; }
.uin-avatar {
  width: 2.25rem; height: 2.25rem; border-radius: 999px;
  display: grid; place-items: center;
  background: var(--color-bg-subtle);
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
  width: 1.05rem;
  height: 1.05rem;
  border-radius: 999px;
  display: grid;
  place-items: center;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  color: var(--color-text-secondary);
}
.uin-avatar-badge svg { width: 0.7rem; height: 0.7rem; }

.uin-row-main { min-width: 0; display: grid; gap: 0.1rem; }
.uin-row-who { display: flex; gap: 0.4rem; align-items: center; min-width: 0; }
.uin-row-name {
  font-size: 0.875rem;
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
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.uin-row-unread .uin-row-subject { font-weight: 600; }
.uin-row-preview {
  font-size: 0.8125rem;
  color: var(--color-text-muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.uin-row-meta {
  display: grid;
  justify-items: end;
  gap: 0.25rem;
  font-size: 0.75rem;
  color: var(--color-text-muted);
  white-space: nowrap;
}
.uin-row-tags { display: flex; gap: 0.25rem; flex-wrap: wrap; justify-content: flex-end; }

/* Given room, a row reads across in one line the way a mail program does: who,
   what it is about, how it began, when. Stacked when the list is a column beside
   an open conversation. */
@container (min-width: 46rem) {
  .uin-row {
    grid-template-columns: auto 12rem minmax(0, 18rem) minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.75rem;
  }
  .uin-row-main { display: contents; }
  .uin-row-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .uin-row-tags { flex-wrap: nowrap; }
}

.uin-tag {
  display: inline-flex; align-items: center; gap: 0.25rem;
  font-size: 0.6875rem;
  padding: 0.05rem 0.4rem;
  border-radius: 0.25rem;
  border: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  background: var(--color-bg-subtle);
  white-space: nowrap;
}
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
  background: var(--color-bg-subtle);
}
.uin-pager span { font-size: 0.8125rem; color: var(--color-text-muted); }

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
/* The subject and what can be done about it stay put while the conversation
   scrolls under them, because "who is this and what do I do with it" is the
   question somebody has open the whole time they are reading. */
.uin-thread-head {
  position: sticky;
  top: 0;
  z-index: 2;
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
.uin-thread-body { display: grid; gap: 0.875rem; padding: 1rem; min-width: 0; }
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
.uin-msg-out { border-left: 4px dashed var(--color-border-strong); background: var(--color-bg-subtle); }
.uin-msg-note { border-left: 4px dotted var(--color-warning); background: var(--color-warning-bg); }
.uin-msg-head {
  display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: baseline;
  padding: 0.625rem 0.75rem;
  border-bottom: 1px solid var(--color-border);
}
.uin-msg-who { font-size: 0.875rem; font-weight: 600; }
.uin-msg-dir { display: inline-flex; align-items: center; gap: 0.25rem; font-size: 0.75rem; color: var(--color-text-secondary); }
.uin-msg-when { margin-left: auto; font-size: 0.75rem; color: var(--color-text-muted); }
/* Same again on the note's amber ground, which is darker than the surfaces the
   muted tier was measured against. */
.uin-msg-note .uin-msg-when { color: var(--color-text-secondary); }
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
.uin-attachment:hover { border-color: var(--color-border-strong); color: var(--color-text); text-decoration: none; }

/* ---- composer ----------------------------------------------------------- */
.uin-composer {
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  background: var(--color-bg-subtle);
  padding: 0.75rem;
  display: grid;
  gap: 0.625rem;
}
.uin-composer textarea { width: 100%; min-height: 8rem; resize: vertical; }
.uin-composer-modes { display: flex; flex-wrap: wrap; gap: 0.375rem; }
.uin-composer-row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
.uin-recipients { font-size: 0.8125rem; color: var(--color-text-muted); }

/* ---- writing a new message, over the top -------------------------------- */
/* A new message is started while looking at the list, so it opens over the list
   rather than taking its place: nothing is lost from behind it, and closing it
   puts somebody back exactly where they were. A reply is the other case and
   stays under the conversation it answers. */
.uin-modal {
  position: fixed;
  inset: 0;
  z-index: 1000;
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
  background: var(--color-bg-subtle);
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
.uin-field-row:focus-within { background: var(--color-bg-subtle); }
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
/* The collapsed "attach something" chip is a button, not a field: in a grid
   card it would otherwise stretch the full width and read as an input box. */
.uin-ctx-block > .uin-chip { justify-self: start; }
.uin-ctx-add input, .uin-ctx-add select, .uin-ctx-add textarea { min-width: 0; width: 100%; }

/* ---- one person --------------------------------------------------------- */
.uin-person { display: grid; gap: 1rem; align-items: start; min-width: 0; }
@media (min-width: 1100px) {
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

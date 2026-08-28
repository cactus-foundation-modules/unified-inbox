// The reading screen's stylesheet, carried with the module.
//
// It is a real stylesheet rather than inline styles for one reason: the screen
// has to fold down to one column on a phone, and a media query cannot be
// written as a style attribute. Everything in it is a semantic token, so the
// whole screen follows the admin into dark mode with no second palette and
// nothing to keep in step. No hex values: a colour written here is a colour
// that is wrong in one of the two themes.
//
// Every class is prefixed `uin-`, because this stylesheet is loaded into a page
// core owns and shares with whatever else is installed.

const CSS = `
.uin {
  display: grid;
  gap: 1rem;
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
}
@media (min-width: 900px) {
  .uin { grid-template-columns: 13rem minmax(0, 1fr); }
  .uin[data-thread="open"] { grid-template-columns: 13rem minmax(18rem, 22rem) minmax(0, 1.4fr); }
}

/* ---- the rail ---------------------------------------------------------- */
.uin-rail { display: grid; gap: 0.125rem; align-content: start; }
.uin-rail-heading {
  font-size: 0.6875rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-text-muted);
  padding: 0.5rem 0.5rem 0.25rem;
}
.uin-rail a {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.5rem;
  border-radius: 0.375rem;
  color: var(--color-text-secondary);
  text-decoration: none;
  font-size: 0.875rem;
  border: 1px solid transparent;
}
.uin-rail a:hover { background: var(--color-bg-subtle); color: var(--color-text); }
.uin-rail a[aria-current="page"] {
  background: var(--color-primary-subtle);
  border-color: var(--color-primary-border);
  color: var(--color-text);
  font-weight: 600;
}
.uin-rail-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The unread badge is a tinted chip rather than a solid primary pill: white on
   the primary green measures 3.61:1, which is under AA for text this small, and
   a count nobody can read is not a count. */
.uin-rail-count {
  flex: none;
  font-size: 0.6875rem;
  font-weight: 700;
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  background: var(--color-primary-subtle);
  border: 1px solid var(--color-primary-border);
  color: var(--color-text);
}

/* ---- filters ----------------------------------------------------------- */
.uin-filters { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin-bottom: 0.75rem; }
.uin-search { display: flex; gap: 0.5rem; flex: 1 1 14rem; min-width: 0; }
.uin-search input { min-width: 0; flex: 1 1 auto; }
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
.uin-chip:hover { border-color: var(--color-border-strong); color: var(--color-text); }
.uin-chip[aria-pressed="true"],
.uin-chip[aria-current="true"] {
  background: var(--color-primary-subtle);
  border-color: var(--color-primary-border);
  color: var(--color-text);
  font-weight: 600;
}

/* ---- the list ---------------------------------------------------------- */
.uin-list { display: grid; gap: 0.375rem; }
.uin-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 0.625rem;
  align-items: start;
  padding: 0.625rem 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  background: var(--color-surface);
  text-decoration: none;
  color: var(--color-text);
}
.uin-row:hover { border-color: var(--color-border-strong); background: var(--color-surface-raised); }
.uin-row[aria-current="true"] { border-color: var(--color-primary); background: var(--color-primary-subtle); }
/* Muted grey clears AA on the ordinary surfaces but not on the tinted one the
   open conversation sits on, so its secondary text steps up a tier. */
.uin-row[aria-current="true"] .uin-row-preview,
.uin-row[aria-current="true"] .uin-row-meta { color: var(--color-text-secondary); }
.uin-row-unread { border-left: 4px solid var(--color-primary); }
.uin-avatar {
  width: 2rem; height: 2rem; border-radius: 999px;
  display: grid; place-items: center;
  background: var(--color-bg-subtle);
  border: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  font-size: 0.6875rem; font-weight: 700;
}
.uin-row-main { min-width: 0; display: grid; gap: 0.125rem; }
.uin-row-who { display: flex; gap: 0.4rem; align-items: baseline; min-width: 0; }
.uin-row-name { font-size: 0.875rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uin-row-name-unread { font-weight: 700; }
.uin-row-subject { font-size: 0.875rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uin-row-preview {
  font-size: 0.8125rem;
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.uin-row-meta { display: grid; justify-items: end; gap: 0.25rem; font-size: 0.75rem; color: var(--color-text-muted); }
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

/* ---- pagination -------------------------------------------------------- */
.uin-pager { display: flex; gap: 0.5rem; align-items: center; justify-content: space-between; margin-top: 0.75rem; }
.uin-pager span { font-size: 0.8125rem; color: var(--color-text-muted); }

/* ---- one conversation -------------------------------------------------- */
.uin-thread { display: grid; gap: 0.75rem; align-content: start; min-width: 0; }
.uin-thread-head {
  display: grid; gap: 0.5rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--color-border);
}
.uin-thread-subject { font-size: 1.125rem; font-weight: 650; margin: 0; }
.uin-thread-actions { display: flex; flex-wrap: wrap; gap: 0.375rem; align-items: center; }
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
.uin-attachment:hover { border-color: var(--color-border-strong); color: var(--color-text); }

/* ---- composer ---------------------------------------------------------- */
.uin-composer { border: 1px solid var(--color-border); border-radius: 0.5rem; background: var(--color-surface); padding: 0.75rem; display: grid; gap: 0.625rem; }
.uin-composer textarea { width: 100%; min-height: 8rem; resize: vertical; }
.uin-composer-modes { display: flex; flex-wrap: wrap; gap: 0.375rem; }
.uin-composer-row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
.uin-recipients { font-size: 0.8125rem; color: var(--color-text-muted); }

/* ---- empty and error states ------------------------------------------- */
.uin-empty {
  border: 1px dashed var(--color-border-strong);
  border-radius: 0.5rem;
  padding: 1.5rem;
  text-align: center;
  color: var(--color-text-muted);
  background: var(--color-surface);
}
.uin-empty strong { display: block; color: var(--color-text); margin-bottom: 0.25rem; }

/* Every interactive thing on this screen shows where the keyboard is. */
.uin a:focus-visible,
.uin button:focus-visible,
.uin input:focus-visible,
.uin select:focus-visible,
.uin textarea:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: 2px;
}

/* Only one pane at a time on a phone: the list, or the conversation. */
@media (max-width: 899px) {
  .uin[data-thread="open"] .uin-rail,
  .uin[data-thread="open"] .uin-listpane { display: none; }
}
`

export function InboxStyles() {
  return <style dangerouslySetInnerHTML={{ __html: CSS }} />
}

'use client'

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react'
import { BLOCK_CLASS, BLOCK_OFF_CLASS, openUpAround } from '@/modules/unified-inbox/lib/richtext-blocks'
import { LinkIcon, ListIcon, NumberedListIcon, PaletteIcon } from './icons'

// The writing box, with enough formatting to write an email in and no more.
//
// Bold, italic, a colour, a link and the two kinds of list. That is the whole
// list, and it is short on purpose: everything past it - typefaces, sizes,
// alignment, tables - is a way to make an email look like it was assembled
// rather than written, and half of it is rendered differently by every inbox it
// lands in anyway.
//
// It is a contentEditable box driven by document.execCommand. That API is
// deprecated and every browser still implements it, which is the entire reason:
// the alternative is a third-party editor, and a page builder's worth of
// dependency for six buttons is not a trade worth making. What it produces is
// the markup email has always been made of - <b>, <i>, <a>, <ul>, <ol>, and a
// span with a colour on it - and every one of those survives core's email
// sanitiser, which is what the message is put through on the way out.
//
// THE BOX AND ITS BUTTONS ARE TWO COMPONENTS, in one provider. They used to be
// one, with the buttons stuck above the words - which is where a mail program
// put them in 1998 and is not where this composer wants them: everything you
// can do to a message now lives on the one strip along the bottom, beside the
// paperclip. So the provider holds the box and the commands, RichTextBox draws
// the words, and RichTextTools draws the buttons wherever the composer puts
// them. Nothing about the commands changed in the move.
//
// Three decisions worth writing down:
//
//   The box is uncontrolled. Writing `value` back into it on every keystroke
//   would put the caret at the start of the line on every keystroke, which is
//   the classic way to make a contentEditable box unusable. It is written into
//   only when what it is holding is not what it was handed - opening a draft,
//   or being emptied after a send.
//
//   The buttons refuse the mouse-down rather than the click. A press anywhere
//   else on the page takes the selection with it, and a Bold button that has
//   just destroyed the selection it was meant to embolden does nothing at all.
//
//   Paste arrives as text. What comes off the clipboard is arbitrary markup
//   from arbitrary places, and pasting a web page into a reply brings its
//   layout, its fonts and its tracking pixels with it. The words are what
//   somebody meant to paste.

/** What a colour swatch actually writes into the message.
 *
 *  Real colours rather than the admin's own tokens, and deliberately: this is
 *  the CONTENT of an email, read in somebody else's inbox, where a CSS variable
 *  from this site's stylesheet means nothing at all. The admin chrome around
 *  the box is tokens as usual. */
const INK = [
  { id: 'black', label: 'Black', value: '#000000' },
  { id: 'grey', label: 'Grey', value: '#5b6472' },
  { id: 'red', label: 'Red', value: '#b3261e' },
  { id: 'amber', label: 'Amber', value: '#a15c00' },
  { id: 'green', label: 'Green', value: '#1b6b3a' },
  { id: 'blue', label: 'Blue', value: '#1a4fbf' },
  { id: 'purple', label: 'Purple', value: '#6b3fa0' },
]

/** What a browser leaves behind in a box somebody has cleared out. Matched so
 *  an empty box reads as empty everywhere else - the Send button, the draft
 *  guard, the "there is nothing to save yet" refusal. */
function isEmptyMarkup(html: string): boolean {
  return html
    .replace(/<br\s*\/?>/gi, '')
    .replace(/<div>\s*<\/div>/gi, '')
    .replace(/<p>\s*<\/p>/gi, '')
    .replace(/&nbsp;/gi, '')
    .trim().length === 0
}

/** Only what an email may usefully link to. `javascript:` is refused by the
 *  sanitiser on the way out as well; this is so somebody is told rather than
 *  finding a link that quietly did not survive. */
function tidyUrl(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  if (/^(https?:\/\/|mailto:|tel:)/i.test(value)) return value
  // The commonest thing anybody types: a bare address with no scheme on it.
  if (/^[\w.-]+\.[a-z]{2,}(\/|$|\?|#)/i.test(value)) return `https://${value}`
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return `mailto:${value}`
  return null
}

// Only functions and plain values cross this line. The box and the remembered
// selection are refs, and a ref handed out of a hook is a thing another
// component can quietly write to - so the two that need writing to are wrapped
// in the small operations that do it, and they stay where they were made.
type RichTextValue = {
  id: string
  attach: (el: HTMLDivElement | null) => void
  emit: () => void
  exec: (command: string, argument?: string, withCss?: boolean) => void
  /** Where the caret is now, kept for after the link box has taken the focus
   *  away. A link applied to a selection the browser has since forgotten goes
   *  nowhere. */
  rememberSelection: () => void
  /** Put the caret back where it was, and say whether anything is selected. */
  restoreSelection: () => boolean
  /** Drop a block of markup in where the caret was. */
  insertHtml: (html: string) => void
  placeholder: string
  label: string
}

/** What something outside the provider can ask the box to do. Handed out
 *  through a ref rather than context because the composer DRAWS the provider -
 *  it is above it, not inside it, so it cannot read the context it supplies. */
export type RichTextHandle = { insertHtml: (html: string) => void }

const RichTextContext = createContext<RichTextValue | null>(null)

function useRichText(): RichTextValue {
  const value = useContext(RichTextContext)
  if (!value) throw new Error('Used outside a RichText')
  return value
}

type Props = {
  id: string
  /** The markup in the box. Written into it only when it is not already what
   *  the box is holding - see the note above about carets. */
  value: string
  onChange: (html: string) => void
  placeholder: string
  /** Named by something else on the screen, because the label above the box is
   *  the one the rest of the form uses. */
  label: string
  /** Filled in with the box's handle while it is on the screen, for whatever
   *  drew the provider - the catalogue picker, which puts a product where the
   *  caret is. */
  handleRef?: { current: RichTextHandle | null }
  /** The box and the buttons, in whatever order the composer wants them. */
  children: ReactNode
}

/** Holds the writing box and the commands that act on it. Draw a RichTextBox
 *  inside it for the words, and a RichTextTools wherever the buttons belong. */
export function RichText({ id, value, onChange, placeholder, label, handleRef, children }: Props) {
  const box = useRef<HTMLDivElement | null>(null)
  /** Where the caret was when the link box was opened. */
  const savedRange = useRef<Range | null>(null)

  const attach = useCallback((el: HTMLDivElement | null) => { box.current = el }, [])

  const emit = useCallback(() => {
    const el = box.current
    if (!el) return
    const html = el.innerHTML
    onChange(isEmptyMarkup(html) ? '' : html)
  }, [onChange])

  /** One formatting command, applied to whatever is selected.
   *
   *  `styleWithCSS` is set per command rather than once: off, bold and italic
   *  are <b> and <i>, which is what an email is made of and what every inbox
   *  renders; on, a colour is a span with a style on it rather than a <font>
   *  tag from 1997. Both survive the sanitiser; the pair of them is what an
   *  email client would have produced. */
  const exec = useCallback((command: string, argument?: string, withCss = false) => {
    const el = box.current
    if (!el) return
    el.focus()
    try {
      document.execCommand('styleWithCSS', false, withCss ? 'true' : 'false')
      document.execCommand(command, false, argument)
    } catch {
      // A browser that has finally taken execCommand away leaves the writing
      // untouched and the button doing nothing, which is the right way for a
      // formatting button to fail: nothing is lost and the words are still
      // there. Everything this module sends works as plain text.
    }
    emit()
  }, [emit])

  const rememberSelection = useCallback(() => {
    const selection = window.getSelection()
    savedRange.current = selection && selection.rangeCount > 0
      ? selection.getRangeAt(0).cloneRange()
      : null
  }, [])

  const restoreSelection = useCallback(() => {
    const el = box.current
    const range = savedRange.current
    if (el && range) {
      el.focus()
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    }
    const selection = window.getSelection()
    return !!selection && !selection.isCollapsed
  }, [])

  /**
   * A block of markup, dropped in where the caret was.
   *
   * "Where the caret was" is the whole difficulty: whatever asked for this took
   * the focus off the box to ask - a dialog, a menu - so the browser's own idea
   * of the selection is somewhere else by now. The remembered range is used when
   * it is genuinely inside this box, and the end of the writing otherwise, which
   * is where somebody who has not put a caret anywhere means.
   *
   * A line break goes in behind it so there is somewhere to type: a block at the
   * very end of a contentEditable with nothing after it is a box that will not
   * take another word.
   */
  const insertHtml = useCallback((html: string) => {
    const el = box.current
    if (!el) return
    el.focus()
    const selection = window.getSelection()
    const saved = savedRange.current
    if (selection) {
      const range = saved && el.contains(saved.commonAncestorContainer)
        ? saved
        : (() => {
          const end = document.createRange()
          end.selectNodeContents(el)
          end.collapse(false)
          return end
        })()
      selection.removeAllRanges()
      selection.addRange(range)
    }
    try {
      document.execCommand('styleWithCSS', false, 'false')
      document.execCommand('insertHTML', false, `${html}<br />`)
    } catch {
      // Same failure the formatting buttons are written to survive: nothing is
      // lost, and the block goes on the end rather than nowhere at all.
      el.insertAdjacentHTML('beforeend', `${html}<br />`)
    }
    openUpAround(el)
    rememberSelection()
    emit()
  }, [emit, rememberSelection])

  // Handed out while the box is on the screen and taken back when it goes, so
  // nothing can write into a box that has been unmounted.
  useEffect(() => {
    if (!handleRef) return
    handleRef.current = { insertHtml }
    return () => { handleRef.current = null }
  }, [handleRef, insertHtml])

  // Only when they differ. Every keystroke already put its own markup in the
  // box, and writing it back would move the caret to the front of it. Here
  // rather than in RichTextBox because this is where the box's ref is made -
  // the box is drawn by a child, but nothing outside this component writes to
  // it.
  useEffect(() => {
    const el = box.current
    if (!el) return
    if (el.innerHTML === value) return
    // An empty box is genuinely empty, so the placeholder underneath shows.
    el.innerHTML = value
    // A draft written elsewhere - or migrated, with its products run onto the
    // end - arrives with its blocks shoulder to shoulder. Nothing is emitted
    // for this: the line breaks are somewhere to put a caret, not something
    // anybody wrote, and the first keystroke reports them anyway.
    openUpAround(el)
  }, [value])

  const api = useMemo<RichTextValue>(
    () => ({
      id, attach, emit, exec, rememberSelection, restoreSelection, insertHtml, placeholder, label,
    }),
    [
      attach, emit, exec, id, insertHtml, label, placeholder, rememberSelection, restoreSelection,
    ],
  )

  return <RichTextContext.Provider value={api}>{children}</RichTextContext.Provider>
}

/** The words themselves. */
export function RichTextBox() {
  const { id, attach, emit, exec, rememberSelection, placeholder, label } = useRichText()

  /** The little cross on a block - a product, today - takes the whole block
   *  out. The box has no idea what it removed, which is the point: a block is
   *  whatever wears the class, and the thing that put it there decides what
   *  goes in it. */
  const onClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const off = (event.target as Element | null)?.closest?.(`.${BLOCK_OFF_CLASS}`)
    if (!off) return
    event.preventDefault()
    off.closest(`.${BLOCK_CLASS}`)?.remove()
    // Taking the middle one of three out puts the other two together, and they
    // need a line between them as much as they ever did.
    openUpAround(event.currentTarget)
    emit()
  }, [emit])

  /** The two shortcuts fingers already know. Everything else is a button: a
   *  keystroke nobody was told about is not a feature. */
  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!(event.metaKey || event.ctrlKey)) return
    const key = event.key.toLowerCase()
    if (key === 'b') { event.preventDefault(); exec('bold') }
    if (key === 'i') { event.preventDefault(); exec('italic') }
  }, [exec])

  return (
    <div className="uin-richtext">
      <div
        id={id}
        ref={attach}
        className="uin-richtext-box"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        data-placeholder={placeholder}
        onInput={emit}
        // Where the caret was, kept on the way out: anything that opens over the
        // box to ask a question - the link box, the catalogue - takes the focus
        // with it, and what it puts back has to land where somebody was writing.
        onBlur={() => { rememberSelection(); emit() }}
        onKeyDown={onKeyDown}
        onClick={onClick}
        // Arbitrary markup off a clipboard brings a web page's layout, its
        // fonts and its tracking pixels with it. The words are what somebody
        // meant to paste.
        onPaste={(event) => {
          event.preventDefault()
          const text = event.clipboardData.getData('text/plain')
          if (text) exec('insertText', text)
        }}
      />
    </div>
  )
}

/**
 * The buttons. Drawn wherever the composer puts them - which is now on the
 * strip along the bottom, between the paperclip and the ways the message
 * leaves.
 *
 * The colours are behind the palette rather than laid out beside it. Seven
 * swatches in a row was fine when the strip held two icons; on a strip that
 * also carries the attachments, the catalogue, the clock and three ways to send
 * it was seven of the widest things on the line. One press opens them, one
 * press picks one, and picking one puts them away again - which is what a
 * colour menu does everywhere else.
 */
export function RichTextTools() {
  const { id, exec, rememberSelection, restoreSelection } = useRichText()
  const [linking, setLinking] = useState(false)
  const [url, setUrl] = useState('')
  const [urlProblem, setUrlProblem] = useState('')
  const [inking, setInking] = useState(false)

  const openLink = useCallback(() => {
    rememberSelection()
    setUrlProblem('')
    setLinking(true)
  }, [rememberSelection])

  const applyLink = useCallback(() => {
    const tidy = tidyUrl(url)
    if (!tidy) {
      setUrlProblem('That does not look like an address. Try something like example.com/prices.')
      return
    }
    // Nothing selected: the address itself is the words, which is what every
    // mail program does with a link inserted into the middle of a sentence.
    if (restoreSelection()) {
      exec('createLink', tidy)
    } else {
      exec('insertHTML', `<a href="${tidy.replace(/"/g, '&quot;')}">${tidy.replace(/</g, '&lt;')}</a>`)
    }
    setLinking(false)
    setUrl('')
    setUrlProblem('')
  }, [exec, restoreSelection, url])

  return (
    <>
      <span className="uin-richtext-bar" role="toolbar" aria-label="Formatting" aria-controls={id}>
        <button
          type="button"
          className="uin-icon-btn uin-rt-btn"
          title="Bold"
          aria-label="Bold"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => exec('bold')}
        >
          <strong aria-hidden="true">B</strong>
        </button>
        <button
          type="button"
          className="uin-icon-btn uin-rt-btn"
          title="Italic"
          aria-label="Italic"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => exec('italic')}
        >
          <em aria-hidden="true">I</em>
        </button>

        {/* The palette on its own, with no frame round it: it is one more icon
            on a strip of icons, and a box drawn round one of them says it is a
            different kind of thing when it is not. */}
        <button
          type="button"
          className="uin-icon-btn uin-rt-btn"
          title="Colour"
          aria-label="Colour"
          aria-expanded={inking}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setInking((was) => !was)}
        >
          {PaletteIcon}
        </button>
        {inking && (
          <span className="uin-rt-ink" role="group" aria-label="Colour">
            {INK.map((ink) => (
              <button
                key={ink.id}
                type="button"
                className="uin-rt-swatch"
                style={{ background: ink.value }}
                title={ink.label}
                aria-label={ink.label}
                onMouseDown={(e) => e.preventDefault()}
                // Shut on the way: a colour is one answer, and a row of
                // swatches left open across the strip is in the way of the
                // buttons beside it.
                onClick={() => { exec('foreColor', ink.value, true); setInking(false) }}
              />
            ))}
          </span>
        )}

        <button
          type="button"
          className="uin-icon-btn uin-rt-btn"
          title="Add a link"
          aria-label="Add a link"
          onMouseDown={(e) => e.preventDefault()}
          onClick={openLink}
        >
          {LinkIcon}
        </button>
        <button
          type="button"
          className="uin-icon-btn uin-rt-btn"
          title="Bullet list"
          aria-label="Bullet list"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => exec('insertUnorderedList')}
        >
          {ListIcon}
        </button>
        <button
          type="button"
          className="uin-icon-btn uin-rt-btn"
          title="Numbered list"
          aria-label="Numbered list"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => exec('insertOrderedList')}
        >
          {NumberedListIcon}
        </button>
      </span>

      {/* Its own line under the strip, because an address box is wider than
          every button on it. Same box, same words, as when it lived above the
          message. */}
      {linking && (
        <div className="uin-rt-link">
          <label className="sr-only" htmlFor={`${id}-link`}>Where the link goes</label>
          <input
            id={`${id}-link`}
            type="text"
            value={url}
            autoFocus
            placeholder="example.com/prices"
            autoComplete="off"
            onChange={(e) => { setUrl(e.target.value); setUrlProblem('') }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); applyLink() }
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setLinking(false) }
            }}
          />
          <button type="button" className="btn btn-secondary btn-sm" onClick={applyLink}>Link it</button>
          <button
            type="button"
            className="uin-chip"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => exec('unlink')}
          >
            Take the link off
          </button>
          <button type="button" className="uin-chip" onClick={() => { setLinking(false); setUrlProblem('') }}>
            Never mind
          </button>
          {urlProblem && <span className="uin-rt-link-problem" role="alert">{urlProblem}</span>}
        </div>
      )}
    </>
  )
}

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
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

type Props = {
  id: string
  /** The markup in the box. Written into it only when it is not already what
   *  the box is holding - see the note above about carets. */
  value: string
  onChange: (html: string) => void
  placeholder: string
  /** Named by something else on the screen, because the label above the box is
   *  the one the rest of the form uses. */
  'aria-label': string
}

export function RichText({ id, value, onChange, placeholder, ...rest }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const [linking, setLinking] = useState(false)
  const [url, setUrl] = useState('')
  const [urlProblem, setUrlProblem] = useState('')
  /** Where the caret was when the link box was opened. Opening it takes the
   *  focus out of the writing box, and a link applied to a selection the
   *  browser has since forgotten goes nowhere. */
  const savedRange = useRef<Range | null>(null)

  // Only when they differ. Every keystroke already put its own markup in the
  // box, and writing it back would move the caret to the front of it.
  useEffect(() => {
    const el = box.current
    if (!el) return
    if (el.innerHTML === value) return
    // An empty box is genuinely empty, so the placeholder underneath shows.
    el.innerHTML = value
  }, [value])

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

  const openLink = useCallback(() => {
    const selection = window.getSelection()
    savedRange.current = selection && selection.rangeCount > 0
      ? selection.getRangeAt(0).cloneRange()
      : null
    setUrlProblem('')
    setLinking(true)
  }, [])

  const applyLink = useCallback(() => {
    const tidy = tidyUrl(url)
    if (!tidy) {
      setUrlProblem('That does not look like an address. Try something like example.com/prices.')
      return
    }
    const el = box.current
    if (el && savedRange.current) {
      el.focus()
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(savedRange.current)
    }
    // Nothing selected: the address itself is the words, which is what every
    // mail program does with a link inserted into the middle of a sentence.
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) {
      exec('insertHTML', `<a href="${tidy.replace(/"/g, '&quot;')}">${tidy.replace(/</g, '&lt;')}</a>`)
    } else {
      exec('createLink', tidy)
    }
    setLinking(false)
    setUrl('')
    setUrlProblem('')
  }, [exec, url])

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
      <div className="uin-richtext-bar" role="toolbar" aria-label="Formatting" aria-controls={id}>
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

        {/* Seven colours in a row rather than behind a menu. It is a colour
            picker with seven answers - a menu to open before you can see them
            would be one more press for no more choice. */}
        <span className="uin-rt-ink" role="group" aria-label="Colour">
          <span className="uin-rt-ink-icon" aria-hidden="true">{PaletteIcon}</span>
          {INK.map((ink) => (
            <button
              key={ink.id}
              type="button"
              className="uin-rt-swatch"
              style={{ background: ink.value }}
              title={ink.label}
              aria-label={ink.label}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => exec('foreColor', ink.value, true)}
            />
          ))}
        </span>

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
      </div>

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

      <div
        {...rest}
        id={id}
        ref={box}
        className="uin-richtext-box"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        data-placeholder={placeholder}
        onInput={emit}
        onBlur={emit}
        onKeyDown={onKeyDown}
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

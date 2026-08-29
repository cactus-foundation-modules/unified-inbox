'use client'

import { useEffect, useRef, useState } from 'react'
import { markdownToHtml } from '@/lib/markdown-client'

// A small markdown box with a toolbar and a Preview tab, for writing an inbox
// signature in rich text without writing any markup.
//
// Core's renderer is the one used deliberately: it is browser-only, so it can
// never drag jsdom into the client bundle, and it shares its allow-list with
// the server renderer that turns the same markdown into the email that is
// actually sent. Two renderers would be two things to disagree.

type Props = {
  value: string
  onChange: (value: string) => void
  rows?: number
  placeholder?: string
  minHeight?: string
  /** What a screen reader should call the box. Needed wherever the visible
   *  label names a group of controls rather than this one. */
  ariaLabel?: string
  // What to render in the Preview tab when it differs from `value`
  // (e.g. a reply previewed with its signature appended). Defaults to `value`.
  previewContent?: string
}

type ToolAction =
  | { kind: 'wrap'; before: string; after: string; placeholder: string }
  | { kind: 'line'; prefix: string }
  | { kind: 'link' }

const TOOLS: { label: string; title: string; shortcut?: string; style?: React.CSSProperties; action: ToolAction }[] = [
  { label: 'B', title: 'Bold (Ctrl+B)', shortcut: 'b', style: { fontWeight: 700 }, action: { kind: 'wrap', before: '**', after: '**', placeholder: 'bold text' } },
  { label: 'I', title: 'Italic (Ctrl+I)', shortcut: 'i', style: { fontStyle: 'italic' }, action: { kind: 'wrap', before: '*', after: '*', placeholder: 'italic text' } },
  { label: 'S', title: 'Strikethrough', style: { textDecoration: 'line-through' }, action: { kind: 'wrap', before: '~~', after: '~~', placeholder: 'strikethrough' } },
  { label: 'H2', title: 'Heading', action: { kind: 'line', prefix: '## ' } },
  { label: 'Link', title: 'Link (Ctrl+K)', shortcut: 'k', action: { kind: 'link' } },
  { label: '• List', title: 'Bullet list', action: { kind: 'line', prefix: '- ' } },
  { label: '1. List', title: 'Numbered list', action: { kind: 'line', prefix: '1. ' } },
  { label: 'Quote', title: 'Blockquote', action: { kind: 'line', prefix: '> ' } },
  { label: 'Code', title: 'Inline code', style: { fontFamily: 'monospace' }, action: { kind: 'wrap', before: '`', after: '`', placeholder: 'code' } },
]

const SHORTCUT_MAP = Object.fromEntries(
  TOOLS.filter((t) => t.shortcut).map((t) => [t.shortcut!, t.action])
)

// What the rendered markdown looks like in the Preview pane.
//
// It carries its own rules because the class it used to wear, `prose`, is not a
// class this site defines - the preview had no typography at all, and a heading
// looked like a paragraph. Tokens only, so it follows the admin into dark mode.
const PREVIEW_CSS = `
.uin-md-preview > :first-child { margin-top: 0; }
.uin-md-preview > :last-child { margin-bottom: 0; }
.uin-md-preview h1, .uin-md-preview h2, .uin-md-preview h3 {
  margin: 1rem 0 0.5rem;
  line-height: 1.3;
  font-weight: 600;
  color: var(--color-text);
}
.uin-md-preview h1 { font-size: 1.25rem; }
.uin-md-preview h2 { font-size: 1.0625rem; }
.uin-md-preview h3 { font-size: 0.9375rem; }
.uin-md-preview p { margin: 0 0 0.75rem; }
.uin-md-preview ul, .uin-md-preview ol { margin: 0 0 0.75rem; padding-left: 1.5rem; }
.uin-md-preview li { margin-bottom: 0.25rem; }
.uin-md-preview li::marker { color: var(--color-text-muted); }
.uin-md-preview blockquote {
  margin: 0 0 0.75rem;
  padding-left: 0.75rem;
  border-left: 3px solid var(--color-border-strong);
  color: var(--color-text-secondary);
}
.uin-md-preview a { color: var(--color-link); }
.uin-md-preview a:hover { color: var(--color-link-hover); }
.uin-md-preview code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.875em;
  padding: 0.1em 0.3em;
  border-radius: 0.25rem;
  background: var(--color-bg-subtle);
}
.uin-md-preview pre {
  margin: 0 0 0.75rem;
  padding: 0.75rem;
  overflow-x: auto;
  border-radius: 0.375rem;
  background: var(--color-bg-subtle);
}
.uin-md-preview pre code { padding: 0; background: none; }
.uin-md-preview img { max-width: 100%; height: auto; }
.uin-md-preview hr { border: 0; border-top: 1px solid var(--color-border); margin: 1rem 0; }
.uin-md-preview table { border-collapse: collapse; }
.uin-md-preview th, .uin-md-preview td {
  border: 1px solid var(--color-border);
  padding: 0.25rem 0.5rem;
  text-align: left;
}
`

export default function MarkdownEditor({ value, onChange, rows = 8, placeholder, minHeight = '8rem', previewContent, ariaLabel }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const pendingSel = useRef<[number, number] | null>(null)
  const [preview, setPreview] = useState(false)

  // Restore the caret/selection after a toolbar edit re-renders the textarea.
  useEffect(() => {
    if (pendingSel.current && ref.current) {
      const [start, end] = pendingSel.current
      ref.current.focus()
      ref.current.setSelectionRange(start, end)
      pendingSel.current = null
    }
  }, [value])

  function apply(action: ToolAction, currentValue = value) {
    const ta = ref.current
    if (!ta) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const selected = currentValue.slice(start, end)

    let next = currentValue
    let selStart = start
    let selEnd = end

    if (action.kind === 'wrap') {
      const inner = selected || action.placeholder
      next = currentValue.slice(0, start) + action.before + inner + action.after + currentValue.slice(end)
      selStart = start + action.before.length
      selEnd = selStart + inner.length
    } else if (action.kind === 'line') {
      const lineStart = currentValue.lastIndexOf('\n', start - 1) + 1
      const nl = currentValue.indexOf('\n', end)
      const lineEnd = nl === -1 ? currentValue.length : nl
      const block = currentValue.slice(lineStart, lineEnd)
      const prefixed = block
        .split('\n')
        .map((line) => (line.startsWith(action.prefix) ? line : action.prefix + line))
        .join('\n')
      next = currentValue.slice(0, lineStart) + prefixed + currentValue.slice(lineEnd)
      selStart = lineStart
      selEnd = lineStart + prefixed.length
    } else {
      const text = selected || 'text'
      const snippet = `[${text}](url)`
      next = currentValue.slice(0, start) + snippet + currentValue.slice(end)
      selStart = start + text.length + 3 // position of "url"
      selEnd = selStart + 3
    }

    pendingSel.current = [selStart, selEnd]
    onChange(next)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const key = e.key.toLowerCase()
    if ((e.ctrlKey || e.metaKey) && SHORTCUT_MAP[key]) {
      e.preventDefault()
      apply(SHORTCUT_MAP[key], value)
    }
  }

  return (
    <div>
      <style dangerouslySetInnerHTML={{ __html: PREVIEW_CSS }} />
      <div style={{ display: 'flex', gap: '0.25rem', marginBottom: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        {/* Kept on the row in Preview rather than taken off it: removing them
            collapsed the row and made the whole editor jump on every switch. */}
        {TOOLS.map((t) => (
          <button
            key={t.label}
            type="button"
            className="btn btn-secondary btn-sm"
            title={t.title}
            aria-label={t.title}
            disabled={preview}
            onClick={() => apply(t.action)}
            style={t.style}
          >
            {t.label}
          </button>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.25rem' }}>
          <button
            type="button"
            className={`btn btn-sm ${!preview ? 'btn-primary' : 'btn-secondary'}`}
            aria-pressed={!preview}
            onClick={() => setPreview(false)}
          >
            Write
          </button>
          <button
            type="button"
            className={`btn btn-sm ${preview ? 'btn-primary' : 'btn-secondary'}`}
            aria-pressed={preview}
            onClick={() => setPreview(true)}
          >
            Preview
          </button>
        </div>
      </div>

      {preview ? (
        <div
          className="uin-md-preview"
          style={{
            minHeight,
            padding: '0.75rem',
            // --color-surface-raised, not --color-surface-alt: the latter is not
            // a token this site has, and an unresolved variable takes the whole
            // declaration with it, leaving the Preview pane with no ground at all.
            background: 'var(--color-surface-raised)',
            border: '1px solid var(--color-border)',
            borderRadius: '0.375rem',
          }}
          dangerouslySetInnerHTML={{
            __html: (previewContent ?? value)
              ? markdownToHtml(previewContent ?? value)
              : '<em style="color:var(--color-text-secondary)">Nothing to preview.</em>',
          }}
        />
      ) : (
        <div className="field" style={{ marginBottom: 0 }}>
          <textarea
            ref={ref}
            aria-label={ariaLabel}
            rows={rows}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            style={{ minHeight }}
          />
        </div>
      )}
    </div>
  )
}

'use client'

import { useState, type ReactNode } from 'react'
import { splitQuotedText } from '@/modules/unified-inbox/lib/list'
import { splitLinks } from '@/modules/unified-inbox/lib/linkify'
import { LinkPeek, type PeekedLink } from './LinkPeek'

/**
 * A message that arrived with no markup of its own.
 *
 * Its web addresses used to be text and nothing else, which reads as broken to
 * anybody trying to press one. They are links now - but a link in somebody
 * else's message is not followed on the press: it opens the same panel the HTML
 * messages use, which shows where it actually goes before anybody goes there.
 *
 * They are real anchors rather than buttons dressed up as links, so right-click
 * and copy, and open-in-a-new-tab, all behave the way they do everywhere else.
 * Only the plain left click is taken over.
 *
 * `foldQuoted` is off for an internal note, and only for one. Folding away
 * everything after a line beginning with "> " is right for mail, where that
 * line is the message being answered; a note is somebody typing a sentence, and
 * a note that opened with a quotation would have had half of itself hidden
 * behind a toggle that says "Show the earlier messages" about a conversation
 * that has none.
 */
export function MessageText({ text, foldQuoted = true }: { text: string; foldQuoted?: boolean }) {
  const split = splitQuotedText(text)
  const { body, quoted } = foldQuoted ? split : { body: text, quoted: null }
  const [peek, setPeek] = useState<PeekedLink | null>(null)

  return (
    <>
      <LinkPeek link={peek} onClose={() => setPeek(null)} />
      <pre className="uin-msg-text">{linked(body, setPeek)}</pre>
      {quoted && (
        <details style={{ marginTop: '0.75rem' }}>
          <summary className="uin-chip uin-summary">Show the earlier messages</summary>
          <pre className="uin-msg-text" style={{ marginTop: '0.5rem', color: 'var(--color-text-secondary)' }}>
            {linked(quoted, setPeek)}
          </pre>
        </details>
      )}
    </>
  )
}

function linked(text: string, onPeek: (link: PeekedLink) => void): ReactNode {
  const pieces = splitLinks(text)
  if (pieces.length === 1 && pieces[0]!.kind === 'text') return text

  return pieces.map((piece, index) => piece.kind === 'text'
    ? piece.value
    : (
      <a
        key={index}
        href={piece.href}
        onClick={(event) => {
          // A cmd-click or a middle-click is somebody deliberately asking for a
          // new tab, and taking that over would be this screen being clever at
          // the reader's expense.
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
          event.preventDefault()
          onPeek({ href: piece.href, text: piece.value })
        }}
      >
        {piece.value}
      </a>
    ))
}

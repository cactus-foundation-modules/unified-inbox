'use client'

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { formatFull, formatWhen, inboxHref } from '@/modules/unified-inbox/lib/list'
import { AdminTooltip } from '@/components/admin/Tooltip'
import { CloseIcon, ExpandIcon, PaperclipIcon } from './icons'
import { MessageBody } from './MessageBody'
import { MessageText } from './MessageText'
import { STACK_FROM, useSelection } from './Selection'

// ---------------------------------------------------------------------------
// The reading pane while several conversations are picked: the pile itself,
// with the one picked last lying on top.
//
// Before this the pane went on showing whatever conversation happened to be
// open, picked or not, beside a list with three other rows ticked. Two different
// answers to "which conversation am I dealing with?" on one screen, and the
// buttons in that conversation's header acted on the open one AND the pile -
// so a pile of three plus an open fourth that was never picked deleted four.
//
// So the pane says one thing at a time. Nothing picked, or one: the open
// conversation, as ever. Two or more: the pile, and nothing else - the open
// conversation is held behind it, untouched (a half-written reply in it is
// still there when the pile goes), but it is not drawn and it is not acted on.
//
// The card on top is the newest message in the conversation picked last, drawn
// the same way the conversation itself draws it. The ones underneath show the
// edge that a pile of paper shows: who, what about, when. Pressing one brings it
// to the top, which changes nothing but the order of the pile.
// ---------------------------------------------------------------------------

/** How many conversations underneath the top one are drawn as edges. Past
 *  this the pile says how many more there are rather than drawing a deck of
 *  slivers nobody could press. */
const EDGES_SHOWN = 4

type Preview = {
  id: string
  subject: string | null
  messageCount: number
  latest: {
    id: string
    direction: 'in' | 'out' | 'note'
    channel: string
    fromName: string | null
    fromAddress: string | null
    fromPhone: string | null
    toAddresses: string[]
    subject: string | null
    sentAt: string
    hasHtml: boolean
    remoteImages: number
    hasAttachments: boolean
    bodyText: string | null
  } | null
}

type Loaded = Preview | 'failed'

type Props = {
  base: string
  params: Record<string, string>
  timezone: string
  /** The conversation the address says is open, if any - the one the pile is
   *  drawn in front of, and the one letting go leaves open if it is in the
   *  pile. */
  openThreadId: string | null
}

/** The reading pane, deciding between what was opened and the pile.
 *
 *  `children` is the pane as the server drew it. It stays mounted while the
 *  pile is showing - hidden by the stylesheet, not unmounted - so a reply being
 *  written in it is exactly where it was left when the pile is put down. */
export function ReadingPane({
  opened, children, ...props
}: Props & { opened: boolean; children: ReactNode }) {
  const { picked } = useSelection()
  const stacked = picked.length >= STACK_FROM
  // With nothing open the list has the whole width and there is no pane to
  // put a pile in. A pile is only ever made from an open conversation on a
  // desk (see `toggle` in ThreadListView), so this is the rare case of the
  // open one having been taken away underneath it - the bar above the list
  // still acts on the pile.
  if (!opened) return null
  return (
    <div className="uin-read" data-stacked={stacked ? '1' : undefined}>
      {stacked && <PickStack ids={picked} {...props} />}
      {children}
    </div>
  )
}

function PickStack({ ids, base, params, timezone, openThreadId }: Props & { ids: string[] }) {
  const router = useRouter()
  const { setSelected, clear } = useSelection()
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({})

  // Last picked first: that is the top of the pile.
  const pile = ids.reduceRight<string[]>((acc, id) => [...acc, id], [])
  const top = ids.at(-1)
  const under = pile.slice(1, 1 + EDGES_SHOWN)
  const more = pile.length - 1 - under.length

  // Only what is drawn is fetched - the top card and the edges under it - and
  // each once, whatever order the pile is shuffled into. A pile of forty picked
  // with a shift-click asks for five.
  const asked = useRef(new Set<string>())
  const wanted = pile.slice(0, 1 + EDGES_SHOWN).join(',')
  useEffect(() => {
    for (const id of wanted.split(',')) {
      if (!id || asked.current.has(id)) continue
      asked.current.add(id)
      fetch(`/api/m/unified-inbox/threads/${id}`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() as Promise<Preview> : Promise.reject(new Error('refused'))))
        .then((preview) => setLoaded((all) => ({ ...all, [id]: preview })))
        .catch(() => setLoaded((all) => ({ ...all, [id]: 'failed' })))
    }
  }, [wanted])

  /** To the top of the pile: last in pick order. Nothing else about the pick
   *  changes - the same conversations, the same count, the same bar. */
  const bringToTop = (id: string) => {
    setSelected((current) => [...current.filter((x) => x !== id), id])
  }

  /** Put the pile down and read one of it. */
  const openOne = (id: string) => {
    clear()
    if (id !== openThreadId) router.push(inboxHref(base, params, { id }))
  }

  /** Put the pile down. The open conversation stays open where it was one of
   *  the pile; where it was not, the top card is what was being looked at, so
   *  that is what is left open rather than something nobody picked. */
  const letGo = () => {
    if (openThreadId && ids.includes(openThreadId)) clear()
    else if (top) openOne(top)
    else clear()
  }

  // Escape puts the pile down, the way it closes everything else on this
  // screen - unless something on top of the pile is listening for it first (a
  // dialog, a menu, the box being typed in). Listened for once, through a ref
  // that always holds the current letGo, rather than re-subscribed every time
  // the pile changes.
  const letGoRef = useRef(letGo)
  useEffect(() => { letGoRef.current = letGo })
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return
      letGoRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const now = new Date()
  const topLoaded = top ? loaded[top] : undefined

  return (
    <section className="uin-stack" aria-label={`${ids.length} conversations picked`}>
      <header className="uin-stack-head">
        <div className="uin-stack-title">
          <h2>{ids.length} conversations selected</h2>
          <p>The one you picked last is on top. Press one underneath to bring it forward.</p>
        </div>
        <AdminTooltip body="Clear the selection">
          <button type="button" className="uin-icon-btn" onClick={letGo}>
            {CloseIcon}
            <span className="sr-only">Clear the selection</span>
          </button>
        </AdminTooltip>
      </header>

      <div className="uin-stack-pile" data-depth={Math.min(under.length, 2)}>
        {/* Farthest first, so each edge is drawn over the one behind it. */}
        {under.reduceRight<string[]>((acc, id) => [...acc, id], []).map((id) => {
          const depth = under.indexOf(id) + 1
          const preview = loaded[id]
          const card = preview && preview !== 'failed' ? preview : null
          return (
            <button
              key={id}
              type="button"
              className="uin-stack-edge"
              style={{ '--uin-stack-depth': depth } as CSSProperties}
              onClick={() => bringToTop(id)}
            >
              <span className="uin-stack-edge-who">{card ? whoOf(card) : preview === 'failed' ? 'Could not load' : ' '}</span>
              <span className="uin-stack-edge-subject">{card ? subjectOf(card) : ''}</span>
              <span className="uin-stack-edge-when">
                {card?.latest ? formatWhen(card.latest.sentAt, now, timezone) : ''}
              </span>
              <span className="sr-only">Bring this one to the top of the pile</span>
            </button>
          )
        })}

        <article className="uin-stack-card" aria-live="polite">
          {!topLoaded ? (
            <div className="uin-stack-loading">Fetching the top one&hellip;</div>
          ) : topLoaded === 'failed' ? (
            <div className="uin-stack-loading">
              That conversation would not open here. It may have been moved or deleted since the list
              was drawn.
            </div>
          ) : (
            <TopCard preview={topLoaded} timezone={timezone} onOpen={() => openOne(topLoaded.id)} />
          )}
        </article>
      </div>

      {more > 0 && (
        <p className="uin-stack-more">
          And {more} more underneath. The bar above the list acts on all {ids.length}.
        </p>
      )}
    </section>
  )
}

function TopCard({ preview, timezone, onOpen }: { preview: Preview; timezone: string; onOpen: () => void }) {
  const m = preview.latest
  return (
    <>
      <header className="uin-stack-card-head">
        <div className="uin-stack-card-lines">
          <span className="uin-stack-card-who">{whoOf(preview)}</span>
          <span className="uin-stack-card-subject">{subjectOf(preview)}</span>
          {m && m.toAddresses.length > 0 && (
            <span className="uin-stack-card-to">To: {m.toAddresses.join(', ')}</span>
          )}
        </div>
        <div className="uin-stack-card-side">
          {m && <time dateTime={m.sentAt}>{formatFull(m.sentAt, timezone)}</time>}
          <span className="uin-stack-card-tags">
            {m?.hasAttachments && (
              <span className="uin-tag" title="Has an attachment">
                {PaperclipIcon}<span className="sr-only">Has an attachment</span>
              </span>
            )}
            {preview.messageCount > 1 && (
              <span className="uin-count" title={`${preview.messageCount} messages`}>
                {preview.messageCount > 99 ? '99+' : preview.messageCount}
              </span>
            )}
          </span>
          <button type="button" className="btn btn-secondary btn-sm uin-stack-open" onClick={onOpen}>
            {ExpandIcon}<span>Open</span>
          </button>
        </div>
      </header>
      <div className="uin-stack-card-body">
        {!m ? (
          <p className="uin-stack-loading">Nothing has been said in this one yet.</p>
        ) : m.hasHtml && m.channel === 'email' ? (
          <MessageBody
            key={m.id}
            messageId={m.id}
            hasRemoteImages={m.remoteImages > 0}
            // Only what went out from here is ours for certain. Anything that
            // came in keeps its pictures held back until somebody asks, exactly
            // as the conversation does for a stranger.
            ownSender={m.direction === 'out'}
          />
        ) : m.bodyText ? (
          <div className="uin-stack-card-text"><MessageText text={m.bodyText} /></div>
        ) : (
          <p className="uin-stack-loading">No words in this one - open it to see what it holds.</p>
        )}
      </div>
    </>
  )
}

/** Who the card is from, as a reader would name them. */
function whoOf(preview: Preview): string {
  const m = preview.latest
  if (!m) return 'Unknown sender'
  if (m.direction === 'out') {
    const to = m.toAddresses[0]
    return to ? `To ${to}` : 'Sent from here'
  }
  return m.fromName || m.fromAddress || m.fromPhone || 'Unknown sender'
}

function subjectOf(preview: Preview): string {
  return preview.subject || preview.latest?.subject || '(no subject)'
}

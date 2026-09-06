'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ProductChoice } from '@/modules/unified-inbox/lib/products/types'
import { CloseIcon } from './icons'

// Putting something out of the site's own catalogue on a message.
//
// The same object as the file picker beside it and deliberately so: a search
// box, a list, and one press to add. What is different is the middle of it -
// a listing that comes in eight colours is one row here, and the eight are
// behind it rather than beside it. Otherwise a shop with two hundred variations
// buries its own products under its own options, and somebody hunting for "the
// black one" scrolls past four screens of chairs to find it.
//
// Three things can be added and the difference matters to whoever reads the
// message: a plain product, the listing itself (quoted from its cheapest, which
// is what the storefront card says), and one exact variation. The middle one is
// not a mistake - "here is the desk, it comes in four widths" is a real thing to
// send somebody, and it links to the page where they choose.
//
// Nothing here decides what the email says. The names and the prices on the
// screen are the shop's, fetched now; the ones in the message are the shop's
// again, fetched when Send is pressed. A price that moves in between moves in
// the message too, which is the right way round.
//
// It opens over everything rather than inside the composer. It used to unfold
// underneath the writing box, which pushed the message being written off the
// bottom of the pane the moment somebody went looking for a chair - and a
// catalogue is a thing you rummage in, so it is the wrong thing to put inside
// something you are in the middle of.
//
// A range with ninety variations is narrowed by its own options rather than
// scrolled: one menu per option, built out of what the variations actually
// carry, so "the black one with arms" is two presses instead of four screens.
// The menus appear only where they would do something - an option with a single
// value across the whole range answers nothing.

type Props = {
  onPick: (item: ProductChoice) => void
  onClose: () => void
  /** Already on the message, so a second press cannot add a second copy. */
  chosen: readonly ProductChoice[]
}

function keyOf(item: { moduleName: string; kind: string; id: string }): string {
  return `${item.moduleName}:${item.kind}:${item.id}`
}

/** The price as one line: 'From £419.00 + VAT'. The same sentence the email
 *  prints, so what is picked and what arrives cannot read differently. */
export function priceLabel(item: ProductChoice): string {
  if (!item.price) return ''
  const figure = item.priceFrom ? `From ${item.price}` : item.price
  return item.priceSuffix ? `${figure} ${item.priceSuffix}` : figure
}

/** What a variation is called under its listing. Its own name where it has one
 *  worth reading, and the options that make it either way. */
function variationLabel(item: ProductChoice): string {
  return item.options || item.name
}

/** Which option is chosen on a listing that has been opened up. Option name to
 *  value, and an option nobody has narrowed is simply not in here. */
type Narrowing = Record<string, string>

/**
 * The menus to offer over a list of variations: every option any of them
 * carries, each with the values that actually occur, in the order the shop
 * arranged them.
 *
 * An option with one value across the whole range is left out. It is true of
 * every variation, so choosing it removes nothing - and a row of menus that
 * cannot narrow anything is a row of menus in the way.
 */
function optionMenus(list: readonly ProductChoice[]): { option: string; values: string[] }[] {
  const seen = new Map<string, string[]>()
  for (const item of list) {
    for (const pair of item.optionPairs) {
      const values = seen.get(pair.option)
      if (!values) { seen.set(pair.option, [pair.value]); continue }
      if (!values.includes(pair.value)) values.push(pair.value)
    }
  }
  return [...seen.entries()]
    .filter(([, values]) => values.length > 1)
    .map(([option, values]) => ({ option, values }))
}

/** Whether one variation answers everything that has been narrowed. */
function matches(item: ProductChoice, narrowing: Narrowing): boolean {
  return Object.entries(narrowing).every(([option, value]) =>
    !value || item.optionPairs.some((pair) => pair.option === option && pair.value === value))
}

export function ProductPicker({ onPick, onClose, chosen }: Props) {
  const [items, setItems] = useState<ProductChoice[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  // Null until somebody has actually asked for something. An empty list before
  // that is not a result, and "nothing found" is the wrong answer to a question
  // nobody has asked yet.
  const [term, setTerm] = useState<string | null>(null)
  /** Which listing has been opened up, and what it came back with. Kept per
   *  listing rather than as one open panel, so opening a second does not throw
   *  away the first - somebody comparing two ranges is the normal case. */
  const [opened, setOpened] = useState<Record<string, ProductChoice[] | 'loading' | 'failed'>>({})

  // Every search that comes back is checked against the one being waited for.
  // Two keystrokes in flight at once come back in whichever order the database
  // felt like, and the older one landing last shows the wrong list.
  const request = useRef(0)

  useEffect(() => {
    if (term === null) return
    const mine = ++request.current
    const timer = setTimeout(() => {
      setLoading(true)
      const params = new URLSearchParams()
      if (term.trim()) params.set('q', term.trim())
      fetch(`/api/m/unified-inbox/products?${params.toString()}`)
        // A refusal is not an empty catalogue. Told apart because the two used
        // to arrive on screen as the same sentence, and the first of them left
        // somebody hunting for a product that was there all along.
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('refused'))))
        .then((data: { items?: ProductChoice[] }) => {
          if (mine !== request.current) return
          setItems(Array.isArray(data.items) ? data.items : [])
          setOpened({})
          setFailed(false)
        })
        .catch(() => {
          if (mine !== request.current) return
          setItems([])
          setFailed(true)
        })
        .finally(() => { if (mine === request.current) setLoading(false) })
      // Long enough that typing a name is one search rather than twelve, short
      // enough that the list feels like it is keeping up. The same wait the file
      // picker and the record picker use, because they are the same gesture.
    }, term.trim() ? 250 : 0)
    return () => clearTimeout(timer)
  }, [term])

  // Read out of a box rather than off the props, so the listener below can be
  // put on the page once and left there while the composer above re-renders.
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // Anything asking a question on top of this owns Escape. Same standing
      // down the file picker does, and for the same reason: the confirm dialog
      // listens on the page in the capture phase as well.
      if (document.querySelector('[data-uin-confirm]')) return
      // Stopped here so shutting this list does not also shut the message being
      // written behind it, which listens for Escape as it bubbles.
      event.preventDefault()
      event.stopPropagation()
      closeRef.current()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [])

  const ask = useCallback((next: string) => {
    setQuery(next)
    setTerm(next)
    // Said before the wait below starts rather than after it: an empty list
    // drawn in that tick reads as an answer to a question not yet asked.
    setLoading(true)
  }, [])

  const open = useCallback((item: ProductChoice) => {
    const id = keyOf(item)
    setOpened((was) => {
      // A second press closes it again, and a third asks the shop afresh. Which
      // is the right way round: a list of variations is a list of prices, and a
      // panel reopened ten minutes later showing the ones from ten minutes ago
      // is the sort of thing somebody quotes out of.
      if (was[id] && was[id] !== 'loading') {
        const { [id]: _gone, ...rest } = was
        return rest
      }
      return was[id] ? was : { ...was, [id]: 'loading' }
    })
    if (opened[id]) return
    const params = new URLSearchParams({ of: item.id, module: item.moduleName })
    fetch(`/api/m/unified-inbox/products?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('refused'))))
      .then((data: { items?: ProductChoice[] }) => {
        setOpened((was) => ({ ...was, [id]: Array.isArray(data.items) ? data.items : [] }))
      })
      .catch(() => setOpened((was) => ({ ...was, [id]: 'failed' })))
  }, [opened])

  const already = new Set(chosen.map(keyOf))

  const results = (
    <>
      <div className="uin-composer-row uin-product-find">
        <label className="sr-only" htmlFor="uin-product-search">Find a product</label>
        <input
          id="uin-product-search"
          type="search"
          value={query}
          placeholder="Find a product"
          autoFocus
          onChange={(e) => ask(e.target.value)}
          onFocus={() => { if (term === null) { setTerm(''); setLoading(true) } }}
        />
      </div>

      {failed && (
        <div className="alert alert-danger" role="alert">
          Your products could not be listed. You may not be allowed to see them, or the site did
          not answer. Try again in a moment.
        </div>
      )}
      {loading && <p className="uin-recipients">Looking...</p>}
      {!loading && !failed && term === null && (
        <p className="uin-recipients">Start typing to find a product.</p>
      )}
      {!loading && !failed && term !== null && items.length === 0 && (
        <p className="uin-recipients">
          {query.trim() ? 'Nothing in your catalogue matches that.' : 'There is nothing in your catalogue yet.'}
        </p>
      )}

      {items.length > 0 && (
        <ul className="uin-ctx-picker uin-product-picker">
          {items.map((item) => {
            const id = keyOf(item)
            const list = opened[id]
            const price = priceLabel(item)
            return (
              <li key={id}>
                <button
                  type="button"
                  title={item.name}
                  aria-label={`Put ${item.name} on this message`}
                  disabled={already.has(id)}
                  onClick={() => onPick(item)}
                >
                  <span className="uin-product-row">
                    {item.imageUrl
                      // eslint-disable-next-line @next/next/no-img-element -- media library URLs are arbitrary remote hosts, not a configured next/image loader
                      ? <img className="uin-product-thumb" src={item.imageUrl} alt="" width={40} height={40} />
                      : <span className="uin-product-thumb uin-product-thumb-empty" aria-hidden="true" />}
                    <span className="uin-product-words">
                      <span className="uin-ctx-main">
                        <span className="uin-chip-clear-text">{item.name}</span>
                        {already.has(id) && <span className="uin-tag">On the message</span>}
                      </span>
                      <span className="uin-ctx-sub">
                        {[price, item.sku].filter(Boolean).join(' - ')}
                      </span>
                    </span>
                  </span>
                </button>

                {item.variationCount > 0 && (
                  <button
                    type="button"
                    className="uin-ctx-remove uin-product-open"
                    aria-expanded={!!list && list !== 'loading'}
                    onClick={() => open(item)}
                  >
                    {list && list !== 'loading' && list !== 'failed'
                      ? 'Hide the variations'
                      : `Choose one of ${item.variationCount}`}
                  </button>
                )}

                {list === 'loading' && <p className="uin-ctx-sub">Looking...</p>}
                {list === 'failed' && (
                  <p className="uin-ctx-sub">Those variations could not be listed.</p>
                )}
                {Array.isArray(list) && list.length === 0 && (
                  <p className="uin-ctx-sub">Nothing on this one can be bought at the moment.</p>
                )}
                {Array.isArray(list) && list.length > 0 && (
                  <Variations key={id} list={list} already={already} onPick={onPick} />
                )}
              </li>
            )
          })}
        </ul>
      )}
    </>
  )

  // Over everything rather than inside the composer: see the note at the top of
  // this file. Drawn into the body for the same reason the popped-out reply is -
  // the composer sits in a pane that scrolls its own contents, and a dialog
  // inside one of those is a dialog clipped by it.
  return createPortal(
    <div className="uin-modal">
      <div
        className="uin-modal-card uin-modal-card-picker"
        role="dialog"
        aria-modal="true"
        aria-label="Put something you sell on this message"
      >
        <div className="uin-modal-head">
          <h2 className="uin-modal-title">Add a product</h2>
          <button
            type="button"
            className="uin-modal-close"
            aria-label="Close the catalogue"
            title="Close the catalogue"
            onClick={onClose}
          >
            {CloseIcon}
          </button>
        </div>
        <div className="uin-modal-body">{results}</div>
      </div>
    </div>,
    document.body,
  )
}

/**
 * The variations of one listing, and the menus that narrow them.
 *
 * A component of its own because the narrowing is per listing and has to be
 * forgotten when that listing is closed - which is exactly what unmounting
 * does, for free. Held in the picker as a map keyed by listing it would have to
 * be cleaned up by hand, and the day somebody forgot, the black-chairs-only
 * filter would still be on when they opened a range of desks.
 */
function Variations({ list, already, onPick }: {
  list: ProductChoice[]
  already: Set<string>
  onPick: (item: ProductChoice) => void
}) {
  const [narrowing, setNarrowing] = useState<Narrowing>({})
  const menus = useMemo(() => optionMenus(list), [list])
  const shown = useMemo(() => list.filter((one) => matches(one, narrowing)), [list, narrowing])
  const narrowed = Object.values(narrowing).some(Boolean)

  return (
    <>
      {menus.length > 0 && (
        <div className="uin-product-narrow">
          {menus.map((menu) => (
            <label key={menu.option} className="uin-product-narrow-one">
              <span>{menu.option}</span>
              <select
                value={narrowing[menu.option] ?? ''}
                onChange={(event) => setNarrowing((was) => ({ ...was, [menu.option]: event.target.value }))}
              >
                <option value="">Any</option>
                {menu.values.map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
            </label>
          ))}
          {narrowed && (
            <button type="button" className="uin-chip" onClick={() => setNarrowing({})}>
              Show them all
            </button>
          )}
        </div>
      )}

      {shown.length === 0 ? (
        <p className="uin-ctx-sub">Nothing on this one comes in that combination.</p>
      ) : (
        <ul className="uin-product-variations">
          {shown.map((variation) => {
            const vid = keyOf(variation)
            const vprice = priceLabel(variation)
            return (
              <li key={vid}>
                <button
                  type="button"
                  title={variationLabel(variation)}
                  aria-label={`Put ${variationLabel(variation)} on this message`}
                  disabled={already.has(vid)}
                  onClick={() => onPick(variation)}
                >
                  <span className="uin-ctx-main">
                    <span className="uin-chip-clear-text">{variationLabel(variation)}</span>
                    {already.has(vid) && <span className="uin-tag">On the message</span>}
                  </span>
                  {vprice && <span className="uin-ctx-sub">{vprice}</span>}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}

/** The key a product is removed by, and the one the picker compares against.
 *  Exported so both composers and the preview speak the same language about
 *  which product is which without any of them inventing a second scheme. */
export function productKey(item: { moduleName: string; kind: string; id: string }): string {
  return keyOf(item)
}

'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DeliveryQuote, ProductRef } from '@/modules/unified-inbox/lib/products/types'
import {
  SLOT_DELIVERY_ACT,
  SLOT_DELIVERY_CLASS,
  parseRefClass,
  refClass,
  slotDeliveryInnerHtml,
  withDelivery,
} from '@/modules/unified-inbox/lib/products/slots'
import type { BlockAction } from './RichText'

// Quoting a delivery service beside a product in the writing box.
//
// A product block offers "Add delivery" to whoever is writing - and only to
// them: the block is thrown away at the moment Send is pressed and the real
// table rendered in its place, so the control never reaches a customer. Pressing
// it opens a short menu of the services that product can be bought with, priced
// as the message would quote them. Picking one writes the service's KEY onto the
// block, beside the product's own reference, and shows the line that will print.
// The price itself is read from the shop again when the message goes, exactly as
// the product's is, so a delivery charge that moves in between moves in the
// message too.
//
// The box knows nothing about any of this. It hands over the block and the
// control (see BlockAction in ./RichText.tsx); this file reads the reference off
// the block's own class, asks the catalogue route what can deliver it, and
// rewrites the block in place.

/** Roughly how tall the menu comes out, for placing it before it is measured. */
const ASSUMED_HEIGHT = 220
const WIDTH = 320
const GAP = 4

type Open = {
  block: HTMLElement
  ref: ProductRef
  changed: () => void
  top: number
  left: number
  /** The control it opened from, for handing the focus back. */
  control: HTMLElement
}

/** The reference a slot wears, read off its class list. */
function slotRef(block: HTMLElement): { token: string; ref: ProductRef } | null {
  for (const token of Array.from(block.classList)) {
    const ref = parseRefClass(token)
    if (ref) return { token, ref }
  }
  return null
}

/** Rewrite a slot to quote this service, or none: its reference token swapped
 *  for one carrying the key, and its delivery line redrawn. Returns false when
 *  the block is not a slot it can read, which leaves it exactly as it was. */
function applyToSlot(block: HTMLElement, quote: DeliveryQuote | null): boolean {
  const found = slotRef(block)
  if (!found) return false
  block.classList.replace(found.token, refClass(withDelivery(found.ref, quote?.key ?? null)))
  let line = block.querySelector<HTMLElement>(`.${SLOT_DELIVERY_CLASS}`)
  if (!line) {
    line = document.createElement('span')
    line.className = SLOT_DELIVERY_CLASS
    block.querySelector('.uin-ps-words')?.appendChild(line)
  }
  line.innerHTML = slotDeliveryInnerHtml(quote)
  return true
}

function placeBelow(control: HTMLElement, height: number): { top: number; left: number } {
  const at = control.getBoundingClientRect()
  const left = Math.max(8, Math.min(at.left, window.innerWidth - WIDTH - 8))
  const below = at.bottom + GAP
  const top = below + height > window.innerHeight - 8 ? Math.max(8, at.top - GAP - height) : below
  return { top, left }
}

/**
 * The menu, and the handler the writing box calls when a control in a block is
 * pressed. Draw `menu` anywhere - it portals itself to the page - and hand
 * `onBlockAction` to the RichText.
 */
export function useDeliveryPicker(): { onBlockAction: (action: BlockAction) => void; menu: React.ReactNode } {
  const [open, setOpen] = useState<Open | null>(null)

  const onBlockAction = useCallback((action: BlockAction) => {
    if (action.act !== SLOT_DELIVERY_ACT) return
    const found = slotRef(action.block)
    if (!found) return
    setOpen({
      block: action.block,
      ref: found.ref,
      changed: action.changed,
      control: action.control,
      ...placeBelow(action.control, ASSUMED_HEIGHT),
    })
  }, [])

  const close = useCallback(() => {
    setOpen((was) => {
      was?.control.focus?.()
      return null
    })
  }, [])

  const menu = open && typeof document !== 'undefined'
    ? createPortal(<DeliveryMenu open={open} onClose={close} onMoved={(at) => setOpen((was) => (was ? { ...was, ...at } : was))} />, document.body)
    : null

  return { onBlockAction, menu }
}

function DeliveryMenu({
  open, onClose, onMoved,
}: {
  open: Open
  onClose: () => void
  onMoved: (at: { top: number; left: number }) => void
}) {
  const panel = useRef<HTMLDivElement | null>(null)
  const [items, setItems] = useState<DeliveryQuote[] | null>(null)
  const [problem, setProblem] = useState('')
  const chosen = open.ref.delivery ?? null

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams({
      deliveries: open.ref.id,
      module: open.ref.moduleName,
      kind: open.ref.kind,
      ...(open.ref.picks ? { picks: open.ref.picks } : {}),
    })
    fetch(`/api/m/unified-inbox/products?${params.toString()}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        const json = (await res.json()) as { items?: DeliveryQuote[] }
        setItems(Array.isArray(json.items) ? json.items : [])
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setProblem('The delivery services would not load. Try again in a moment.')
        setItems([])
      })
    return () => controller.abort()
  }, [open.ref])

  // Placed again once it has a real height, so a menu near the bottom of the
  // window opens upwards rather than off the edge.
  useLayoutEffect(() => {
    const el = panel.current
    if (!el) return
    const at = placeBelow(open.control, el.offsetHeight)
    if (at.top !== open.top || at.left !== open.left) onMoved(at)
  }, [items, open.control, open.left, open.top, onMoved])

  // Shut by a press anywhere else, Escape, or the page moving under it - a
  // fixed menu left behind by a scroll is pointing at nothing.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (panel.current && !panel.current.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
    }
    const onScroll = (event: Event) => {
      if (panel.current && event.target instanceof Node && panel.current.contains(event.target)) return
      onClose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onClose)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [onClose])

  useEffect(() => {
    if (items && items.length > 0) panel.current?.querySelector<HTMLElement>('[data-menu-item]')?.focus()
  }, [items])

  const pick = (quote: DeliveryQuote | null) => {
    // The block may have been deleted while the menu was open; then there is
    // nothing to write to and nothing to report.
    if (open.block.isConnected && applyToSlot(open.block, quote)) open.changed()
    onClose()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const list = Array.from(panel.current?.querySelectorAll<HTMLElement>('[data-menu-item]') ?? [])
    if (list.length === 0) return
    event.preventDefault()
    const from = list.indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'ArrowDown' ? Math.min(list.length - 1, from + 1) : Math.max(0, from - 1)
    list[next]?.focus()
  }

  return (
    <div
      className="uin-menu uin-delivery-menu"
      ref={panel}
      role="menu"
      aria-label="Delivery to quote"
      style={{ top: open.top, left: open.left, width: WIDTH }}
      onKeyDown={onKeyDown}
    >
      <div className="uin-menu-title">Delivery to quote</div>
      {items === null && <p className="uin-delivery-menu-note">Looking up delivery services…</p>}
      {problem && <p className="uin-delivery-menu-note" role="alert">{problem}</p>}
      {items !== null && !problem && items.length === 0 && (
        <p className="uin-delivery-menu-note">No delivery service reaches this one. The shop has nothing to quote.</p>
      )}
      {items?.map((quote) => (
        <button
          key={quote.key}
          type="button"
          role="menuitemradio"
          aria-checked={quote.key === chosen}
          data-menu-item
          className="uin-menu-item"
          onClick={() => pick(quote)}
          title={quote.description ?? undefined}
        >
          <span className="uin-menu-item-label">
            {quote.label}
            {quote.description ? <span className="uin-delivery-menu-desc">{quote.description}</span> : null}
          </span>
          <span className="uin-menu-item-hint">
            {quote.priceSuffix ? `${quote.price} ${quote.priceSuffix}` : quote.price}
          </span>
        </button>
      ))}
      {chosen && (
        <>
          <div className="uin-menu-sep" />
          <button type="button" role="menuitem" data-menu-item className="uin-menu-item" onClick={() => pick(null)}>
            <span className="uin-menu-item-label">No delivery</span>
          </button>
        </>
      )}
    </div>
  )
}

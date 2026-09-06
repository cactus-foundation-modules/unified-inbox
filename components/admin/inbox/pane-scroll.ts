'use client'

// Bringing something to the TOP of the reading pane, rather than merely into
// view.
//
// `scrollIntoView` is the obvious answer and it is the wrong one twice over.
// With `block: 'nearest'` it stops as soon as the thing is on the screen at
// all, which for the writing box means "at the very bottom, under whatever was
// already there"; with `block: 'start'` it aligns to the top of the scroller
// and slides the header - which is pinned there - straight over the top of what
// it just brought up.
//
// So the two questions get asked out loud: what actually scrolls, and how much
// of its top the header is sitting over. Shared by the two things that need to
// move the pane - opening a conversation on a particular message, and opening
// the writing box - because they were quietly answering them differently.

/** The thing that actually scrolls, walking out from an element.
 *
 *  Not assumed: the reading pane scrolls its own contents on a wide screen, and
 *  on a phone the whole page scrolls instead. Null means the window. */
export function scrollParent(from: HTMLElement): HTMLElement | null {
  let node = from.parentElement
  while (node) {
    const overflow = getComputedStyle(node).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return node
    node = node.parentElement
  }
  return null
}

/** How much of the top of the pane the conversation's header is sitting over.
 *  It is pinned there on a wide screen and in the flow on a phone, so this is
 *  asked rather than assumed - aligning to the top of a scroller that has an
 *  opaque band across it hides whatever was brought up. */
export function pinnedHeader(target: HTMLElement): number {
  const head = target.closest('.uin-thread')?.querySelector('.uin-thread-head')
  if (!(head instanceof HTMLElement)) return 0
  return getComputedStyle(head).position === 'sticky' ? head.getBoundingClientRect().height : 0
}

/** Put the top of `target` at the top of whatever scrolls it, under the header.
 *  Smooth unless the reader has asked for less movement. */
export function alignToTop(target: HTMLElement, smooth = false): void {
  const scroller = scrollParent(target)
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const behavior: ScrollBehavior = smooth && !still ? 'smooth' : 'auto'
  const wanted = target.getBoundingClientRect().top - pinnedHeader(target)
  if (scroller) {
    scroller.scrollTo({
      top: scroller.scrollTop + wanted - scroller.getBoundingClientRect().top,
      behavior,
    })
  } else {
    window.scrollBy({ top: wanted, behavior })
  }
}

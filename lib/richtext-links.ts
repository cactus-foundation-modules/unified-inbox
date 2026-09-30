import { splitLinks } from './linkify'

// Web addresses in the writing box, made links while somebody writes.
//
// An address typed or pasted into the box used to stay words. The message went
// out with a link only if its author had selected the address and pressed the
// link button, which nobody does for an address they have just pasted - so a
// draft, a scheduled message, and the copy on the Sent list all showed an
// address that could not be pressed.
//
// Every mail program links an address the moment you finish typing it, and so
// does this: when a space or a new line goes in behind it, when somebody pastes
// and carries on, when the writing loses the focus, and when a draft is opened.
// The send path links whatever is left (lib/compose.ts), so this is about the
// box looking like what it will send rather than the last line of defence.
//
// A file of its own, like richtext-blocks.ts beside it: no React, and no DOM
// until something calls the function.

export type LinkifyMode =
  /** Link every address in the box. For moments nobody is mid-word - opening
   *  a draft, leaving the box. */
  | 'all'
  /** Link every address EXCEPT the one somebody may still be typing. In the
   *  text the caret sits in, an address is only linked when there is a space
   *  between its end and the caret: "deskwell.co." is half of
   *  "deskwell.co.uk", and linking it early leaves "uk" hanging off the end. */
  | 'typing'

type Part = { kind: 'text'; value: string } | { kind: 'link'; value: string; href: string }

/**
 * Wrap every bare address in the box in an <a>, and say whether anything
 * changed so the caller knows to report the new markup.
 *
 * Text already inside a link is left alone - somebody chose those words and
 * that destination - and so is anything inside a block (a product), which is an
 * object the box does not edit.
 *
 * The caret is put back where it was, in whichever piece its words ended up
 * in. And a SELECTION is never touched at all: a stretch of words selected is
 * most likely words about to be linked by hand - the link box takes the focus
 * to ask where to - and rewriting the text under it would drop the very
 * selection the link is meant for. Leaving the box later links what is left.
 */
export function linkifyEditable(root: HTMLElement, mode: LinkifyMode): boolean {
  const selection = root.ownerDocument.getSelection()
  const caret = selection && selection.rangeCount > 0 && root.contains(selection.anchorNode)
    ? selection
    : null
  if (caret && !caret.isCollapsed) return false
  const caretNode = caret?.anchorNode ?? null
  const caretOffset = caret?.anchorOffset ?? 0

  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement
    if (!parent || parent.closest('a, [contenteditable="false"]')) continue
    nodes.push(node as Text)
  }

  let changed = false
  for (const node of nodes) {
    const text = node.data
    const atCaret = node === caretNode
    let at = 0
    const parts: Part[] = []
    for (const piece of splitLinks(text)) {
      at += piece.value.length
      const finished = mode === 'all' || !atCaret
        || (at < caretOffset && /\s/.test(text.slice(at, caretOffset)))
      if (piece.kind === 'link' && finished) {
        parts.push(piece)
      } else {
        const last = parts[parts.length - 1]
        if (last && last.kind === 'text') last.value += piece.value
        else parts.push({ kind: 'text', value: piece.value })
      }
    }
    if (!parts.some((part) => part.kind === 'link')) continue

    const fragment = root.ownerDocument.createDocumentFragment()
    // Plain words first: a caret on the boundary between a link and the words
    // after it belongs to the words, so typing carries on outside the link
    // rather than stretching it. Inside a link only when that is the only place
    // it can be.
    let caretInWords: { node: Text; offset: number } | null = null
    let caretInLink: { node: Text; offset: number } | null = null
    let offset = 0
    for (const part of parts) {
      const words = root.ownerDocument.createTextNode(part.value)
      if (part.kind === 'link') {
        const anchor = root.ownerDocument.createElement('a')
        anchor.setAttribute('href', part.href)
        anchor.appendChild(words)
        fragment.appendChild(anchor)
      } else {
        fragment.appendChild(words)
      }
      if (atCaret && caretOffset >= offset && caretOffset <= offset + part.value.length) {
        const home = { node: words, offset: caretOffset - offset }
        if (part.kind === 'text') caretInWords ??= home
        else caretInLink ??= home
      }
      offset += part.value.length
    }

    node.replaceWith(fragment)
    const home = caretInWords ?? caretInLink
    if (home && caret) caret.collapse(home.node, home.offset)
    changed = true
  }
  return changed
}

/** The link the caret is in, when it is in one inside this box - for the line
 *  under the box that says where it goes and lets somebody go there. */
export function linkAtCaret(root: HTMLElement): string | null {
  const selection = root.ownerDocument.getSelection()
  const node = selection && selection.rangeCount > 0 ? selection.anchorNode : null
  if (!node || !root.contains(node)) return null
  const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
  const anchor = element?.closest('a')
  if (!anchor || !root.contains(anchor)) return null
  return anchor.getAttribute('href')
}

/** An address it is safe to send somebody to from the admin: the web, an
 *  email, a phone number. Anything else - a `javascript:` smuggled into a
 *  draft by something other than this box - is not offered as a way out. */
export function openableHref(href: string | null): string | null {
  if (!href) return null
  return /^(https?:|mailto:|tel:)/i.test(href.trim()) ? href.trim() : null
}

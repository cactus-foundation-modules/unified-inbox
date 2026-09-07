// The two class names that make something in the writing box an OBJECT rather
// than words: one press of Backspace takes the whole thing, and the little cross
// on it takes it off deliberately.
//
// A file of its own because both halves need them and neither should have to
// import the other: the box (components/admin/inbox/RichText.tsx) removes any
// block wearing them without knowing or caring what it is, and the catalogue
// (lib/products/slots.ts) puts them on a product without knowing how the box
// works. No React, and no DOM until something calls the one function below, so
// the server may read the names off it as happily as the browser does.

/** On the block itself. Whatever wears this is removed as one piece. */
export const BLOCK_CLASS = 'uin-richtext-block'

/** On the cross inside it. Pressing it removes the block it sits in. */
export const BLOCK_OFF_CLASS = 'uin-richtext-off'

/**
 * A line to type on, on both sides of every block in a writing box.
 *
 * A block is `contenteditable="false"` - one object, that a backspace takes
 * whole - and that is exactly what makes it awkward to write ROUND. If it is the
 * first thing in the box there is nothing before it to put a caret in, so a
 * product picked into an empty reply is a product nobody can write an
 * introduction above; two blocks back to back have nothing between them, so
 * "this one is the cheapest" cannot go where it belongs. Clicking above a block
 * that has nothing above it does nothing at all in every browser there is, which
 * is why every serious editor puts a line there rather than hoping.
 *
 * So: a <br /> before any block that starts its parent or follows another one,
 * and after any block that ends its parent. Idempotent - on the second pass the
 * neighbour is the <br /> the first pass left, so nothing is added - which
 * matters because this runs on every insert and on every draft opened.
 */
export function openUpAround(el: HTMLElement): void {
  for (const block of Array.from(el.querySelectorAll(`.${BLOCK_CLASS}`))) {
    const parent = block.parentNode
    if (!parent) continue
    const before = block.previousSibling
    if (!before || (before instanceof Element && before.classList.contains(BLOCK_CLASS))) {
      parent.insertBefore(document.createElement('br'), block)
    }
    if (!block.nextSibling) parent.appendChild(document.createElement('br'))
  }
}

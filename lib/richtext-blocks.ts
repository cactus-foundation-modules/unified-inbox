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

/** On any other control inside a block, alongside a `data-act` naming what it
 *  does. The box does not know what any of them mean: pressing one hands the
 *  block and the name to whatever drew the box, which does know - the
 *  catalogue's "Add delivery", today. */
export const BLOCK_ACT_CLASS = 'uin-richtext-act'

/** Is there anything at all in the box after (or before) this node: a word, an
 *  image, another block? A bare line break does not count - it is a spacer, not
 *  content, and is exactly the thing being decided about. */
function hasContentBeside(el: HTMLElement, node: Node, side: 'after' | 'before'): boolean {
  const range = document.createRange()
  range.selectNodeContents(el)
  if (side === 'after') range.setStartAfter(node)
  else range.setEndBefore(node)
  const rest = range.cloneContents()
  return rest.textContent?.trim() !== '' || rest.querySelector(`img, .${BLOCK_CLASS}`) !== null
}

/**
 * A line to type on at each END of the writing box, and nowhere else.
 *
 * A block is `contenteditable="false"` - one object, that a backspace takes
 * whole - and that is what makes the ends awkward. If it is the first thing in
 * the box there is nothing above it to put a caret in, so a product picked into
 * an empty reply is a product nobody can write an introduction above; and a
 * block at the very end is a box that will not take another word.
 *
 * It used to put a line break between every pair of blocks as well, and after
 * every block that ended its wrapper. Browsers wrap what is inserted in a <div>
 * of their own, so EVERY block ended its wrapper: a list of products came out
 * with an empty line (and the block's own margin) between each, and deleting one
 * brought it straight back. So now only the ends are enforced - a <br> before a
 * block with nothing before it, and after one with nothing after it - and a
 * stray break directly behind a block that has content following is taken out,
 * which tidies drafts saved with the old gaps in them. Idempotent, because it
 * runs on every insert and on every draft opened.
 */
export function openUpAround(el: HTMLElement): void {
  for (const block of Array.from(el.querySelectorAll(`.${BLOCK_CLASS}`))) {
    const parent = block.parentNode
    if (!parent) continue
    const next = block.nextSibling
    if (next instanceof Element && next.nodeName === 'BR' && hasContentBeside(el, next, 'after')) {
      next.remove()
    }
    if (!hasContentBeside(el, block, 'before')) {
      const before = block.previousSibling
      if (!(before instanceof Element && before.nodeName === 'BR')) {
        parent.insertBefore(document.createElement('br'), block)
      }
    }
    if (!hasContentBeside(el, block, 'after')) {
      const range = document.createRange()
      range.selectNodeContents(el)
      range.setStartAfter(block)
      if (!range.cloneContents().querySelector('br')) {
        parent.insertBefore(document.createElement('br'), block.nextSibling)
      }
    }
  }
}

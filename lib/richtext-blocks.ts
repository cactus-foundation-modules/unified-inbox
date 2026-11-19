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

/** The outermost block holding this node inside the box, or null when it sits
 *  in plain writing. */
function outermostBlock(el: HTMLElement, node: Node | null): Element | null {
  let found: Element | null = null
  for (let n: Node | null = node; n && n !== el; n = n.parentNode) {
    if (n instanceof Element && n.classList.contains(BLOCK_CLASS)) found = n
  }
  return found
}

/**
 * Moves a caret that has ended up INSIDE a block to just after it.
 *
 * A block is one object, so there is no inside to put anything in - but the
 * browser does not always agree. After a block is inserted, Safari and Chrome
 * both leave the selection at the end of the block's own last span, and the
 * next product picked went in there: nested in the one before, each squeezed
 * into a flex row beside its host, three products wide and one syllable to a
 * line. Whatever goes in at the caret goes after the block instead.
 */
export function keepOutOfBlocks(el: HTMLElement, range: Range): void {
  const block = outermostBlock(el, range.endContainer) ?? outermostBlock(el, range.startContainer)
  if (!block) return
  range.setStartAfter(block)
  range.collapse(true)
}

/**
 * Lifts any block that has been nested inside another out to sit after it, in
 * the order they were in. The repair for drafts saved while keepOutOfBlocks was
 * not there - and a guard for the send path, which finds a block by matching to
 * its first closing tag and would cut a nested pair in half.
 */
export function unnestBlocks(el: HTMLElement): void {
  // Hosts worked out before anything moves, so every nested block - however
  // deep - goes after its original top-level host, in document order.
  const moves = Array.from(el.querySelectorAll(`.${BLOCK_CLASS} .${BLOCK_CLASS}`))
    .map((block) => ({ block, host: outermostBlock(el, block.parentNode) }))
  const lastPlaced = new Map<Element, Node>()
  for (const { block, host } of moves) {
    const parent = host?.parentNode
    if (!host || !parent) continue
    const after = lastPlaced.get(host) ?? host
    parent.insertBefore(block, after.nextSibling)
    lastPlaced.set(host, block)
  }
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
  unnestBlocks(el)
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

/**
 * Every pair of blocks with nothing at all between them: no word, no picture,
 * not even an empty line. Those are the pairs with nowhere to put a caret -
 * each block is one object, and two of them touching leave no gap a click can
 * land in - so they are the pairs the box offers a line between.
 *
 * Browsers wrap what is inserted in a <div> of their own, so two blocks in
 * neighbouring wrappers are still touching: the test is what lies between
 * them, not whether they are siblings.
 */
export function touchingBlockPairs(el: HTMLElement): Array<[Element, Element]> {
  const blocks = Array.from(el.querySelectorAll(`.${BLOCK_CLASS}`))
  const pairs: Array<[Element, Element]> = []
  for (let i = 0; i + 1 < blocks.length; i++) {
    const first = blocks[i]
    const second = blocks[i + 1]
    if (!first || !second || first.contains(second)) continue
    const range = document.createRange()
    range.setStartAfter(first)
    range.setEndBefore(second)
    const between = range.cloneContents()
    const empty = (between.textContent ?? '').trim() === ''
      && between.querySelector('img, br, hr, table') === null
    if (empty) pairs.push([first, second])
  }
  return pairs
}

/**
 * An empty line straight after a block, with the caret put in it.
 *
 * A <div> holding a <br> - what the browser itself makes for a new line in a
 * box like this - rather than a bare <br>: openUpAround takes a bare break
 * behind a block out whenever something follows it, and something always
 * follows this one.
 */
export function openLineAfter(el: HTMLElement, block: Element): HTMLElement | null {
  const parent = block.parentNode
  if (!parent || !el.contains(block)) return null
  const line = document.createElement('div')
  line.appendChild(document.createElement('br'))
  parent.insertBefore(line, block.nextSibling)
  el.focus()
  const selection = window.getSelection()
  if (selection) {
    const range = document.createRange()
    range.setStart(line, 0)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
  }
  return line
}

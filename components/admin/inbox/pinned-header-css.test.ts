import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The header of an open conversation is position: sticky, and nothing that
// checks this module can see whether it actually sticks. It stopped once
// already, silently: the box round it was a grid, a sticky grid item can only
// travel inside its own grid area, and row one was exactly as tall as the
// header. So the rules it depends on are pinned here, against the stylesheet
// as written.

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'inbox.css'), 'utf8')

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&')
  const found = new RegExp(`(?:^|\\})\\s*(?:/\\*[\\s\\S]*?\\*/\\s*)*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css)
  if (!found) throw new Error(`No rule for ${selector} in inbox.css`)
  return found[1] ?? ''
}

describe('the pinned conversation header', () => {
  it('sits in a column, never a grid, so it has the whole conversation to travel in', () => {
    const thread = rule('.uin-thread')
    expect(thread).toMatch(/display:\s*flex/)
    expect(thread).toMatch(/flex-direction:\s*column/)
    expect(css).not.toMatch(/\.uin-thread(?:-conv)?\s*\{[^}]*display:\s*grid/)
    expect(css).not.toMatch(/\.uin-thread-conv\s*\{[^}]*grid-template-rows/)
  })

  it('is in a box that grows to the pane and never shrinks to it', () => {
    expect(rule('.uin-read > .uin-thread')).toMatch(/flex:\s*1 0 auto/)
  })

  it('is still pinned, and the pane it is pinned in is still what scrolls', () => {
    expect(css).toMatch(/\.uin-thread-head\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0/)
    expect(rule('.uin-read')).toMatch(/overflow-y:\s*auto/)
  })
})

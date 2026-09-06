// The arithmetic behind the draggable column edges, kept apart from the
// component that draws them so it can be tested without a browser.
//
// Two rules, and both were arrived at by getting them wrong first. An edge may
// not be dragged past the point where its own column stops being usable, and
// the two of them together may not squeeze the conversation - the thing
// somebody actually came to read - below what a line of text needs.

/** Matches the fallbacks in the stylesheet's grid. Change both together. */
export const DEFAULT_WIDTHS = { rail: 240, list: 384 } as const

/** How far each edge may be dragged before its column stops being usable. */
export const WIDTH_LIMITS = { rail: { min: 176, max: 420 }, list: { min: 272, max: 680 } } as const

/** What the conversation keeps, whatever the other two are doing. */
export const MIN_READ = 360

/** What the context panel takes when it is on screen as a fourth column, so a
 *  drag cannot squeeze the conversation out from behind it. Matches the 16rem
 *  minimum in the grid. */
export const CTX_WIDTH = 256

export type ColumnEdge = keyof typeof DEFAULT_WIDTHS
export type ColumnWidths = Record<ColumnEdge, number>

export function clampWidth(edge: ColumnEdge, px: number): number {
  return Math.round(Math.min(WIDTH_LIMITS[edge].max, Math.max(WIDTH_LIMITS[edge].min, px)))
}

/** The room the two left-hand columns may share: everything the frame has, less
 *  what the conversation - and the context panel beside it, when there is one -
 *  must keep. */
export function roomForColumns(frameWidth: number, contextColumn: boolean): number {
  return frameWidth - MIN_READ - (contextColumn ? CTX_WIDTH : 0)
}

/** Applies one edge's new width, then gives way on THAT SAME EDGE if the pair no
 *  longer leaves the conversation its room. It never moves the other edge: a
 *  drag that shoves a column somebody did not touch is one they cannot undo. */
export function settleWidths(
  room: number,
  current: ColumnWidths,
  edge: ColumnEdge,
  px: number,
): ColumnWidths {
  const next: ColumnWidths = { ...current, [edge]: clampWidth(edge, px) }
  const over = next.rail + next.list - room
  if (over > 0) next[edge] = clampWidth(edge, next[edge] - over)
  return next
}

/** What was stored last time, ignoring anything that is not two sane numbers.
 *  A hand-edited or half-written value is a screen with no rail on it, so
 *  everything here is checked rather than trusted. */
export function parseStoredWidths(raw: string | null): Partial<ColumnWidths> {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object') return {}
  const out: Partial<ColumnWidths> = {}
  for (const edge of ['rail', 'list'] as const) {
    const v = (parsed as Record<string, unknown>)[edge]
    if (typeof v === 'number' && Number.isFinite(v)) out[edge] = clampWidth(edge, v)
  }
  return out
}

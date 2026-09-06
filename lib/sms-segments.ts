// How many texts a message will actually be, and therefore what it costs.
//
// A text is charged by the segment: 160 characters of the plain GSM alphabet,
// or 70 once anything outside it appears - one curly quote pasted in from Word,
// one emoji, one accented name - and that shorter limit applies to the WHOLE
// message rather than to the part that caused it. Somebody typing 150
// characters and pressing Send has sent one text; the same 150 with a "don't"
// autocorrected to a curly apostrophe is three.
//
// Nothing here refuses or truncates anything. It exists so the box can say so
// before Send is pressed rather than the bill saying so afterwards.

/** One segment of a plain text, and of one carrying anything outside GSM-7.
 *  The same two numbers core's own SMS template editor counts against. */
export const SEGMENT_CHARS = 160
export const SEGMENT_CHARS_UNICODE = 70

/**
 * Whether anything in here forces the whole message down to the shorter
 * segment. Deliberately crude - printable ASCII is treated as plain and
 * everything else as not - because the true GSM-7 table includes a handful of
 * characters this calls unicode (£, é) and excludes a few it calls plain
 * (^, {, }, which cost two). Erring towards the shorter answer means the count
 * beside the box is a floor rather than a hope.
 */
export function needsUnicodeSegments(text: string): boolean {
  // The range is the point: printable ASCII plus the two line breaks, and
  // anything at all outside it counts as unicode.
  return /[^\x20-\x7E\r\n]/.test(text)
}

export function segmentsFor(text: string): { segments: number; perSegment: number } {
  const perSegment = needsUnicodeSegments(text) ? SEGMENT_CHARS_UNICODE : SEGMENT_CHARS
  return { segments: text.length === 0 ? 0 : Math.ceil(text.length / perSegment), perSegment }
}

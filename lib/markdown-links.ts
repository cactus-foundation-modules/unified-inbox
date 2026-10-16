// `[words](https://address)` as safe HTML, for the copy of a reply this module
// keeps of what it sent down a channel that writes links that way (see
// `markdownLinks` on a conversation provider). Everything is escaped and only
// web addresses become anchors.

const LINK = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s()]{1,2000})\)/g

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Escaped HTML with the links as anchors, or null when there are none. */
export function markdownLinksToHtml(text: string): string | null {
  let out = ''
  let from = 0
  let found = false
  for (const match of text.matchAll(LINK)) {
    const at = match.index ?? 0
    out += escapeHtml(text.slice(from, at))
    out += `<a href="${escapeHtml(match[2] as string)}" target="_blank" rel="noopener noreferrer">${escapeHtml(match[1] as string)}</a>`
    from = at + match[0].length
    found = true
  }
  if (!found) return null
  return (out + escapeHtml(text.slice(from))).replace(/\n/g, '<br>')
}

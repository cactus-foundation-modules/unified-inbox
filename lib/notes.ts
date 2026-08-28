// An internal note is typed as plain text and stored as both. The HTML half is
// built here rather than trusted from the browser: a colleague pasting markup
// into a note has no reason to have it rendered, and running it through a
// sanitiser would only invite the argument about which tags are allowed.

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c]!)
}

/** Plain text as safe markup: escaped, with line breaks kept. */
export function noteHtml(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, '<br>')
}

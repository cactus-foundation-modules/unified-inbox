// The inbox screen's stylesheet is `inbox.css`, next to this file - see the note
// at the top of it for what is in there and the one trap that has caught every
// pass over it.
//
// This file exists only to put that stylesheet on the page. It used to hold the
// CSS itself, as a template literal rendered into a `<style>` tag, and that was
// quietly the most expensive thing on the screen: 170KB of text went into the
// server payload of EVERY navigation - opening a conversation, closing a draft,
// changing a filter - to be shipped, parsed and re-applied all over again for a
// stylesheet that had not changed since the page was first drawn. As a real
// stylesheet it is fetched once, cached by the browser like any other, and
// weighs nothing at all on the click after that.
//
// The import is what does the work; the component renders nothing. Keeping the
// component means both screens that want the stylesheet (the hub and the
// settings tab) go on asking for it in the same place, and neither has to know
// that asking is now a matter of the import above rather than a tag below.
import './inbox.css'

export function InboxStyles() {
  return null
}

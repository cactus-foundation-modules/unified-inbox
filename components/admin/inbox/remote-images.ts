// Which messages have already had their remote pictures fetched.
//
// The notice above a message protects exactly one thing: fetching a picture off
// somebody else's server tells them the message was opened. Once that has
// happened for a message it cannot be unhappened - the sender already knows -
// so putting the notice back the next time the conversation is opened asks for
// a click that protects nothing, and reads as though the message had failed to
// load rather than as though it were being held back.
//
// Kept in the browser rather than on the server, and deliberately. What is
// being remembered is a request THIS machine has already made, which is the
// exact scope of the promise the notice makes. It also means no column, no
// migration, and nothing to fetch on the way into a conversation.
//
// The parsing and the trimming are pure and live here so they can be tested
// without a browser; only the two thin wrappers underneath touch localStorage.

const STORAGE_KEY = 'uin-shown-images'

/** Newest first, oldest dropped off the end. Somebody who reads a lot of post
 *  would otherwise grow a list with no ceiling in it, and the entries that fall
 *  off are for messages nobody is about to open again. */
export const SHOWN_LIMIT = 500

/** Anything at all can be sitting under a localStorage key - somebody else's
 *  value, a half-written one, a hand edit. An unreadable list is treated as no
 *  list, which is the safe way round to be wrong: the notice comes back. */
export function parseShownIds(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((id): id is string => typeof id === 'string' && id !== '')
      .slice(0, SHOWN_LIMIT)
  } catch {
    return []
  }
}

/** Newest to the front, and only ever held once, so reopening an old message
 *  keeps it from ageing off the end while it is still being read. */
export function addShownId(ids: readonly string[], id: string): string[] {
  return [id, ...ids.filter((held) => held !== id)].slice(0, SHOWN_LIMIT)
}

function readShownIds(): string[] {
  try {
    return parseShownIds(window.localStorage.getItem(STORAGE_KEY))
  } catch {
    // A private window, or storage turned off. Not being able to read is the
    // same as having nothing stored.
    return []
  }
}

export function hasShownImages(id: string): boolean {
  return readShownIds().includes(id)
}

export function rememberShownImages(id: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(addShownId(readShownIds(), id)))
  } catch {
    // Not being able to remember costs one more click next time. It is not
    // worth interrupting somebody reading their post to say so.
  }
}

// A conversation in the air between the list and the rail.
//
// Dragging a row onto a mailbox moves it there. Two other things on this screen
// already use HTML drag and drop, and the payload is shaped to stay out of both:
// the writing box only claims a drag whose types include "Files", and the rail's
// own reordering only acts on a drag IT started. So this one travels under a
// type of its own, and the rail asks for it by name.
//
// The browser will not let anybody READ a drag's data until it is dropped - only
// its types - which is no use for the one question worth asking mid-flight: "is
// this the mailbox it is already in?". Both ends of the drag are on the same
// page, so what is in the air is simply remembered here for as long as it is.

export const THREAD_DRAG_TYPE = 'application/x-uin-threads'

export type ThreadDragPayload = {
  ids: string[]
  /** The mailbox each dragged conversation is in now, without repeats. Null is
   *  a conversation that has not been filed anywhere yet. */
  fromInboxIds: (string | null)[]
}

let inFlight: ThreadDragPayload | null = null

/** Which conversations a drag that started on this row is carrying: the whole
 *  ticked pile when the row is one of them, and that row alone when it is not -
 *  the same rule a file manager follows, and for the same reason. */
export function draggedIds(rowId: string, picked: string[]): string[] {
  return picked.includes(rowId) && picked.length > 1 ? picked : [rowId]
}

export function beginThreadDrag(transfer: DataTransfer, payload: ThreadDragPayload): void {
  inFlight = payload
  transfer.effectAllowed = 'move'
  transfer.setData(THREAD_DRAG_TYPE, JSON.stringify(payload.ids))
  // A row is a link, and a dragged link carries its URL as text by default -
  // which is what drops into a colleague's chat window if they let go over it.
  // Nothing useful, and the rail's reordering reads text/plain as a mailbox id.
  transfer.setData('text/plain', '')
}

export function endThreadDrag(): void {
  inFlight = null
}

export function currentThreadDrag(): ThreadDragPayload | null {
  return inFlight
}

/** Whether what is over us is a conversation at all, from the types alone. */
export function isThreadDrag(transfer: DataTransfer | null): boolean {
  if (!transfer) return false
  const types = transfer.types
  for (let i = 0; i < types.length; i += 1) if (types[i] === THREAD_DRAG_TYPE) return true
  return false
}

/** Whether dropping this on that mailbox would change anything. False only when
 *  every conversation in the air is already there, which is when the mailbox
 *  should not light up and the pointer should say "not here". */
export function wouldMove(payload: ThreadDragPayload | null, inboxId: string): boolean {
  if (!payload || payload.ids.length === 0) return false
  return payload.fromInboxIds.some((from) => from !== inboxId)
}

/** "Moved to Sales." / "6 moved to Sales." */
export function movedMessage(count: number, inboxName: string): string {
  return count === 1 ? `Moved to ${inboxName}.` : `${count} moved to ${inboxName}.`
}

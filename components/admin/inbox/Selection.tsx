'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react'

// ---------------------------------------------------------------------------
// What is ticked, held above both columns.
//
// It used to live inside the list, which is where it is made: rows are picked
// there, the bar that acts on them is drawn there, and nothing else needed to
// know. Then the conversation beside the list grew the same buttons - bin,
// junk, snooze, done - and a reader who had picked six conversations, opened
// one of them to check it was the right pile, and pressed Delete in the header
// deleted exactly one. The pile was still ticked in the list behind, and the
// button they pressed could not see it.
//
// So the pick is raised to the same place the undo offer is raised (see
// UndoProvider, directly above this in the tree): one thing, visible to the bar
// over the list and to the header of the open conversation both, so pressing a
// button in either place does the same thing to the same conversations.
//
// The list is the only thing that WRITES rows into it. The pane only ever reads
// - see useBulkTargets, which is the whole of the pane's side of this.
// ---------------------------------------------------------------------------

/** One row as the pick needs it: enough to act on and enough to put back. */
export type PickedRow = {
  id: string
  status: string
  /** ISO, or null. Kept as the string the API wants rather than as a Date:
   *  putting a snoozed conversation back the way it was needs the date it was
   *  due, and an API that takes ISO wants ISO. */
  snoozeUntil: string | null
  unread: boolean
}

type Value = {
  /** Every id ticked, in the order they were ticked, whatever page they were
   *  ticked on. The list's own row handlers write this. */
  selected: string[]
  setSelected: Dispatch<SetStateAction<string[]>>
  /** Ticked AND still on the screen, in tick order. Anything ticked on a page
   *  a filter or a search has since replaced is not on the screen any more, and
   *  acting on it would be acting on something nobody can see. */
  picked: string[]
  /** The same set as rows, in list order, with the state each one was in when
   *  the list last drew it - which is what an undo needs to put them back. */
  pickedRows: PickedRow[]
  clear: () => void
}

const NOTHING: Value = {
  selected: [],
  setSelected: () => {},
  picked: [],
  pickedRows: [],
  clear: () => {},
}

const Selection = createContext<Value>(NOTHING)

/** The pick, from anywhere under the provider. A component outside one gets an
 *  empty pick that cannot be written to, which is the right answer for a screen
 *  with no list on it. */
export function useSelection() {
  return useContext(Selection)
}

/** The list saying what is on the screen right now, so the pick can drop
 *  anything that has scrolled off it - and so a button in the conversation
 *  beside the list knows what state each ticked row was in.
 *
 *  Called from the list's own render pass through an effect, and guarded on the
 *  way in: a fresh server render hands down a new array every time, and setting
 *  state on every one of those would redraw the whole panel for no change. */
function useOnScreen(): [PickedRow[], (rows: PickedRow[]) => void] {
  const [onScreen, setOnScreen] = useState<PickedRow[]>([])
  const register = useCallback((rows: PickedRow[]) => {
    setOnScreen((current) => (same(current, rows) ? current : rows))
  }, [])
  return [onScreen, register]
}

/** Whether two drawings of the list say the same thing. Cheap and exact: the
 *  four fields the pick reads, in order, which is all this has to be right
 *  about. */
function same(a: PickedRow[], b: PickedRow[]): boolean {
  if (a.length !== b.length) return false
  return a.every((row, index) => {
    const other = b[index]
    return !!other
      && row.id === other.id
      && row.status === other.status
      && row.snoozeUntil === other.snoozeUntil
      && row.unread === other.unread
  })
}

const Register = createContext<(rows: PickedRow[]) => void>(() => {})

/** For the list, and only the list: hand up what is on the screen. Kept out of
 *  `useSelection` so that everything else physically cannot write to it. */
export function useRegisterRows(rows: PickedRow[]) {
  const register = useContext(Register)
  useEffect(() => { register(rows) }, [register, rows])
}

export function SelectionProvider({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<string[]>([])
  const [onScreen, register] = useOnScreen()

  const clear = useCallback(() => setSelected([]), [])

  const value = useMemo<Value>(() => {
    const here = new Set(onScreen.map((row) => row.id))
    const ticked = new Set(selected)
    return {
      selected,
      setSelected,
      clear,
      picked: selected.filter((id) => here.has(id)),
      pickedRows: onScreen.filter((row) => ticked.has(row.id)),
    }
  }, [clear, onScreen, selected])

  return (
    <Register.Provider value={register}>
      <Selection.Provider value={value}>{children}</Selection.Provider>
    </Register.Provider>
  )
}

/** What a button inside the open conversation should act on: this conversation,
 *  and everything else ticked in the list beside it.
 *
 *  The conversation being read is always in the answer, even on the rare pick
 *  that does not include it. Somebody who presses Delete while reading
 *  something means that something to go, whatever else is ticked - and a delete
 *  that spared the one conversation on the screen would be the strangest press
 *  on the whole screen.
 *
 *  Nothing ticked gives exactly the one conversation, which is what every one
 *  of these buttons did before there was a pick to read. */
export function useBulkTargets(threadId: string): string[] {
  const { picked } = useSelection()
  return useMemo(
    () => (picked.length > 0 ? [...new Set([threadId, ...picked])] : [threadId]),
    [picked, threadId],
  )
}

/** "1 conversation", "6 conversations", for the sentence on a toast. */
export function them(n: number): string {
  return n === 1 ? 'conversation' : 'conversations'
}

/** The same request against a pile of conversations. One per conversation
 *  rather than a bulk endpoint: the routes already exist and already check who
 *  may touch which inbox. Settled rather than raced, so one refusal does not
 *  hide five successes.
 *
 *  Answers how many would not go, which is what the sentence on the screen
 *  needs - and whether ANY of them went, which is what the callers that ask a
 *  question afterwards need. */
export async function runOnMany(
  ids: string[],
  send: (id: string) => Promise<Response>,
): Promise<{ failed: number; count: number }> {
  const results = await Promise.allSettled(ids.map((id) =>
    send(id).then((r) => { if (!r.ok) throw new Error('refused') })
  ))
  return { failed: results.filter((r) => r.status === 'rejected').length, count: ids.length }
}

/** What to say when some of a pile would not move. Null when they all did. */
export function refusalMessage(failed: number, count: number): string | null {
  if (failed === 0) return null
  if (failed === count) {
    return count === 1 ? 'That did not save.' : 'None of those could be changed.'
  }
  return `${failed} of ${count} could not be changed. The rest were.`
}

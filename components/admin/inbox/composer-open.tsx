'use client'

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import type { ComposerMode } from './Composer'

// Whether the writing box is open, and which of the three it opened as.
//
// It used to be neither question: the box was always there, under every
// conversation, whether anybody wanted to write or not. Which puts a form
// between the reader and the messages on a screen opened nine times out of ten
// to read something, and pushes the newest message off the top of a short one.
//
// What opens it is the reply icon on a message, or Reply to all or Forward on
// that message's own menu - beside the words being answered, which is where a
// mail program has always put them. The box itself opens beside the newest
// message. Two places, one answer, so the answer lives here rather than in
// either of them.
//
// A half-written draft opens the box on the way in. A draft nobody can see is
// a draft nobody finishes.
//
// Its own file, away from the slot that draws the box: the box itself asks for
// this - the cross in its corner shuts it - and the slot renders the box, so
// keeping both in one module would have the two importing each other.

type Opened = { mode: ComposerMode; at: number } | null

type ComposerOpenValue = {
  opened: Opened
  /** Presses the same button twice to close it, a different one to switch. */
  toggle: (mode: ComposerMode) => void
  /** Shuts it outright, whatever it was open as. What the cross in the corner
   *  of the box does once the question about the draft has been answered. */
  close: () => void
}

const ComposerOpenContext = createContext<ComposerOpenValue | null>(null)

export function useComposerOpen(): ComposerOpenValue {
  const value = useContext(ComposerOpenContext)
  if (!value) throw new Error('Used outside a ComposerOpenProvider')
  return value
}

export function ComposerOpenProvider({
  initialMode, children,
}: { initialMode: ComposerMode | null; children: ReactNode }) {
  const [opened, setOpened] = useState<Opened>(initialMode ? { mode: initialMode, at: 0 } : null)

  // `at` counts presses, so pressing Forward while a forward is already open
  // still reaches the composer as a fresh instruction rather than as no change
  // at all. Which matters once somebody has switched mode inside the box.
  const toggle = useCallback((mode: ComposerMode) => {
    setOpened((current) => (current?.mode === mode ? null : { mode, at: (current?.at ?? 0) + 1 }))
  }, [])

  const close = useCallback(() => { setOpened(null) }, [])

  const value = useMemo(() => ({ opened, toggle, close }), [close, opened, toggle])
  return <ComposerOpenContext.Provider value={value}>{children}</ComposerOpenContext.Provider>
}


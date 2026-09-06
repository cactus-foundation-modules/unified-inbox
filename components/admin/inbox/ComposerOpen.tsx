'use client'

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { Composer, type ComposerMode } from './Composer'
import type { DraftForComposer } from '@/modules/unified-inbox/lib/drafts'

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

type Opened = { mode: ComposerMode; at: number } | null

type ComposerOpenValue = {
  opened: Opened
  /** Presses the same button twice to close it, a different one to switch. */
  toggle: (mode: ComposerMode) => void
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

  const value = useMemo(() => ({ opened, toggle }), [opened, toggle])
  return <ComposerOpenContext.Provider value={value}>{children}</ComposerOpenContext.Provider>
}

type SlotProps = {
  threadId: string
  replyTo: string[]
  replyAllTo: string[]
  canReply: boolean
  canForward: boolean
  staff: Array<{ id: string; name: string }>
  cannotReplyReason: string | null
  draft: DraftForComposer | null
  /** The earliest a reply may be set to go out, in the picker's own shape and
   *  in the site's zone. Worked out on the server and carried through. */
  minSendAt: string
  timezone: string
}

/**
 * Where the box appears, once somebody has asked for it.
 *
 * Not rendered at all while it is shut, rather than hidden: the composer holds
 * a draft, a token and an unsaved-work guard, and none of that should be alive
 * on a conversation nobody is writing on.
 */
export function ComposerSlot(props: SlotProps) {
  const { opened } = useComposerOpen()
  if (!opened) return null
  return (
    <div id="uin-composer">
      <Composer {...props} requestedMode={opened.mode} requestedAt={opened.at} />
    </div>
  )
}

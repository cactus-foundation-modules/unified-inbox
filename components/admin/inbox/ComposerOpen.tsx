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
// The buttons that open it belong in the row of actions at the top, beside the
// other things you can do to a conversation, and the box itself belongs where
// it has always been - beside the newest message. Two places, one answer, so
// the answer lives here rather than in either of them.
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

function useComposerOpen(): ComposerOpenValue {
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

/**
 * The three buttons, for the top row of actions.
 *
 * Only what this person can actually do: no Reply on an inbox that cannot send
 * or to a reader who may not answer, no Forward on the same terms. An internal
 * note is always offered - it goes nowhere and needs no sending address.
 */
export function ReplyActions({
  canReply, canForward, cannotReplyReason,
}: { canReply: boolean; canForward: boolean; cannotReplyReason: string | null }) {
  const { opened, toggle } = useComposerOpen()

  const buttons: Array<{ mode: ComposerMode; label: string }> = []
  if (canReply) buttons.push({ mode: 'reply', label: 'Reply' })
  if (canForward) buttons.push({ mode: 'forward', label: 'Forward' })
  buttons.push({ mode: 'note', label: 'Internal note' })

  return (
    <div className="uin-thread-actions uin-reply-actions">
      {buttons.map((button) => {
        // Reply to all is a chip inside the box rather than a fourth button up
        // here: it is a variation on Reply, and it is only on the menu at all
        // when there is somebody else on the message.
        const on = opened?.mode === button.mode || (button.mode === 'reply' && opened?.mode === 'reply-all')
        return (
          <button
            key={button.mode}
            type="button"
            className="btn btn-secondary btn-sm"
            data-open={on ? '1' : undefined}
            aria-expanded={on}
            aria-controls="uin-composer"
            onClick={() => toggle(button.mode)}
          >
            {button.label}
          </button>
        )
      })}
      {/* Why there is no Reply button. The writing box says the same thing, but
          the box is shut now, and a row of actions with the obvious one missing
          and no explanation is the sort of thing people report as broken. */}
      {!canReply && cannotReplyReason && (
        <span className="uin-recipients">{cannotReplyReason}</span>
      )}
    </div>
  )
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

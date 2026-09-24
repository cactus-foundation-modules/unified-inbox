'use client'

import { useEffect, useState } from 'react'
import type { ConversationAttachmentAction, ConversationAttachmentState } from '@/lib/conversations/types'
import { ConfirmDialog } from './ConfirmDialog'
import { PaperclipIcon } from './icons'

// The recordings on a message a channel owns: a player each, and whatever the
// channel says can be done to each one where it keeps them - taking a call off
// the phone company's servers, throwing away the copy kept here afterwards.
//
// Its own island for the reason MessageActions gives: ThreadPane is a server
// component and should stay one. The channel is asked where its files stand
// when the message is drawn, not when it was collected, because the answer
// changes the moment somebody presses one of these.
//
// A file the channel says is gone for good keeps its line - "this was a
// recording" is still true - but loses its player, which would only ever answer
// "not found".

export type ProviderAudioFile = {
  id: string
  filename: string
  url: string
  contentType: string | null
}

type Pending = { url: string; action: ConversationAttachmentAction }

export function ProviderAudio({ messageId, files, canAct }: {
  messageId: string
  files: ProviderAudioFile[]
  /** Whether this reader may be offered the channel's actions at all. */
  canAct: boolean
}) {
  const [states, setStates] = useState<Map<string, ConversationAttachmentState>>(new Map())
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!canAct) return
    let live = true
    fetch(`/api/m/unified-inbox/messages/${messageId}/attachment-actions`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { states?: ConversationAttachmentState[] } | null) => {
        if (live && body?.states) setStates(new Map(body.states.map((s) => [s.url, s])))
      })
      // Nothing to offer is the safe reading of a failure: the player still works.
      .catch(() => {})
    return () => { live = false }
  }, [messageId, canAct])

  async function run(p: Pending) {
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/m/unified-inbox/messages/${messageId}/attachment-actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: p.url, actionId: p.action.id }),
      })
      const body = (await response.json().catch(() => null)) as
        | { states?: ConversationAttachmentState[]; error?: string }
        | null
      if (!response.ok) {
        setError(
          response.status === 401 ? 'You have been signed out. Sign in again and try once more.'
            : response.status === 403 ? 'You are not allowed to do that on this channel.'
              : body?.error ?? 'That could not be done just now. Try again in a moment.',
        )
        return
      }
      if (body?.states) setStates(new Map(body.states.map((s) => [s.url, s])))
      setPending(null)
    } catch {
      setError('The site could not be reached, so nothing was changed.')
    } finally {
      setBusy(false)
    }
  }

  function perform(url: string, action: ConversationAttachmentAction) {
    setError('')
    if (action.confirm) setPending({ url, action })
    else void run({ url, action })
  }

  return (
    <>
      {files.map((file) => {
        const state = states.get(file.url)
        const available = state?.available ?? true
        return (
          <div key={file.id} className="uin-recording">
            {available ? (
              <>
                <audio controls preload="none" className="uin-recording-player">
                  <source src={file.url} type={file.contentType || 'audio/mpeg'} />
                  Your browser does not support the audio element.
                </audio>
                <a className="uin-attachment" href={file.url} download={file.filename}>
                  {PaperclipIcon}
                  {file.filename}
                </a>
              </>
            ) : null}
            {state?.note && <span className="uin-recording-note">{state.note}</span>}
            {state && state.actions.length > 0 && (
              <span className="uin-recording-actions">
                {state.actions.map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busy}
                    onClick={() => perform(file.url, action)}
                  >
                    {action.label}
                  </button>
                ))}
              </span>
            )}
          </div>
        )
      })}
      {/* Same colour as the inbox's other refusals: --color-danger measures
          under AA on this ground at this size. */}
      {error && !pending && (
        <span style={{ color: 'var(--color-destructive-hover)' }} role="alert">{error}</span>
      )}
      <ConfirmDialog
        open={!!pending}
        title={pending ? `${pending.action.label}?` : ''}
        body={
          <>
            {pending?.action.confirm}
            {error && (
              <span style={{ display: 'block', marginTop: '0.5rem', color: 'var(--color-destructive-hover)' }} role="alert">
                {error}
              </span>
            )}
          </>
        }
        confirmLabel={pending?.action.label ?? 'Yes, go ahead'}
        destructive
        busy={busy}
        onCancel={() => { if (!busy) { setPending(null); setError('') } }}
        onConfirm={() => { if (pending) void run(pending) }}
      />
    </>
  )
}

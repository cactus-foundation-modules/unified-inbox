'use client'

import { useEffect, useRef, useState } from 'react'
import { FieldGroup, MUTED } from './ui'
import { API, OFFLINE } from './api'

// ---------------------------------------------------------------------------
// Putting the older files on the media page.
//
// Attachments are filed into the media library as they are stored, under whoever
// the correspondence was with. Anything stored before that was how it worked
// sits in a folder of its own that the media page does not show, and nothing
// moves it on its own - a file is only ever filed at the moment its bytes are
// written, and bytes fetched last March are never written again.
//
// So this offers to walk them. It appears only when there is something to walk,
// and it disappears the moment there is not, because a button that does nothing
// on a settings page is a button somebody reports as broken.
//
// It presses the same route over and over rather than asking the server for one
// long job: the work is a download and an upload per file, and a site with a few
// thousand of them would run out of time in the middle of any single request.
// Stopping halfway is safe and is meant to be - the count picks up where it left
// off, and closing the page is a perfectly good way to stop.
// ---------------------------------------------------------------------------

type State =
  | { phase: 'loading' }
  | { phase: 'idle'; remaining: number }
  | { phase: 'working'; remaining: number; filed: number }
  | { phase: 'done'; filed: number; failures: number }
  | { phase: 'stalled'; remaining: number; filed: number }

export function AttachmentFilingSection() {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [error, setError] = useState<string | null>(null)
  // Stops a second press starting a second walk over the same rows while the
  // first is still going, which would have both of them filing the same file.
  const running = useRef(false)

  useEffect(() => {
    let live = true
    fetch(`${API}/attachments/backfill`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('no'))))
      .then((body: { remaining?: number }) => {
        if (live) setState({ phase: 'idle', remaining: Number(body.remaining ?? 0) })
      })
      .catch(() => {
        // Not worth an error on a settings page nobody opened for this. The
        // section simply does not appear.
        if (live) setState({ phase: 'idle', remaining: 0 })
      })
    return () => { live = false }
  }, [])

  async function run() {
    if (running.current) return
    running.current = true
    setError(null)

    let filed = 0
    let failures = 0
    let remaining = state.phase === 'idle' ? state.remaining : 0

    try {
      for (;;) {
        const res = await fetch(`${API}/attachments/backfill`, { method: 'POST' })
        if (!res.ok) {
          setError('That did not work. Nothing has been moved.')
          setState({ phase: 'idle', remaining })
          return
        }
        const body = await res.json() as { filed?: number; failures?: number; remaining?: number }
        filed += Number(body.filed ?? 0)
        // Counted up rather than overwritten: a file that could not be read in
        // the first batch is still a file that could not be read once the last
        // one finishes, and reporting only the final batch's tally would say
        // everything went perfectly.
        failures += Number(body.failures ?? 0)
        const left = Number(body.remaining ?? 0)

        if (left === 0) {
          setState({ phase: 'done', filed, failures })
          return
        }
        // The count did not come down and there is still work to do. Whatever
        // the server made of the batch, going round again would put the same
        // files through the same refusal for ever, so this is where it stops.
        // Judged on the count alone rather than on what the batch claimed,
        // because the count is the thing the button is meant to be shifting.
        if (left >= remaining) {
          setState({ phase: 'stalled', remaining: left, filed })
          return
        }
        remaining = left
        setState({ phase: 'working', remaining: left, filed })
      }
    } catch {
      setError(OFFLINE)
      setState({ phase: 'idle', remaining })
    } finally {
      running.current = false
    }
  }

  if (state.phase === 'loading') return null
  if (state.phase === 'idle' && state.remaining === 0 && !error) return null

  return (
    <FieldGroup
      title="Older files"
      hint={<>
        Files that came in or went out with a message are kept on your media page, filed under
        whoever the message was with. Anything that arrived before that was how it worked is still
        tucked away where the media page cannot see it. This moves it across. It is safe to stop
        part way through - nothing is thrown away, and pressing it again carries on from where it
        got to.
      </>}
    >
      {error && <p style={{ color: 'var(--color-danger)', margin: '0 0 0.75rem' }}>{error}</p>}

      {state.phase === 'done' ? (
        <p style={{ ...MUTED, margin: 0 }}>
          {state.filed === 0
            ? 'Nothing needed moving.'
            : `Done - ${state.filed} ${state.filed === 1 ? 'file is' : 'files are'} now on your media page.`}
          {state.failures > 0 && ' A few could not be read and were left exactly where they were.'}
        </p>
      ) : state.phase === 'stalled' ? (
        <p style={{ ...MUTED, margin: 0 }}>
          {state.filed > 0 && `${state.filed} moved across. `}
          The remaining {state.remaining} could not be read from storage, so they have been left
          alone. They are still on their conversations, which is where they have always been.
        </p>
      ) : (
        <>
          <p style={{ ...MUTED, margin: '0 0 0.75rem' }}>
            {state.phase === 'working'
              ? `Moving them across - ${state.filed} done, ${state.remaining} to go.`
              : `${state.remaining} ${state.remaining === 1 ? 'file is' : 'files are'} not on your media page yet.`}
          </p>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={run}
            disabled={state.phase === 'working'}
          >
            {state.phase === 'working' ? 'Moving them…' : 'Put them on the media page'}
          </button>
        </>
      )}
    </FieldGroup>
  )
}

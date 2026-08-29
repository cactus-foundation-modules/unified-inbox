'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Puck } from '@puckeditor/core'
import type { Data } from '@puckeditor/core'
import '@puckeditor/core/no-external.css'
import { emailSignaturePuckConfig, setEmailEditorPalette } from '@/lib/puck/email-config'
import { paletteFromTokens } from '@/lib/email/palette'
import { withImagePickerFields } from '@/lib/puck/MediaPickerField'

// The block-built signature. Core owns the blocks and the config; this only
// mounts them and hands the data back up.
//
// Mounted inline rather than taking over the viewport: a signature is four or
// five blocks, and the settings screen around it is where the rest of the
// inbox is configured. Loaded only when somebody picks this kind - Puck and its
// stylesheet are a large import for a box most people never open.

export const EMPTY_SIGNATURE_DATA: Data = { root: { props: {} }, content: [], zones: {} } as unknown as Data

type Props = {
  value: unknown
  onChange: (data: Data) => void
}

export default function SignaturePuckEditor({ value, onChange }: Props) {
  // Puck is uncontrolled after mount - handing it a new `data` prop on every
  // keystroke would reset the selection - so the incoming value is read once.
  const initialData = useMemo(() => {
    const data = value as Data | null
    return data && typeof data === 'object' ? data : EMPTY_SIGNATURE_DATA
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount value only, by design
  }, [])

  // Puck's first onChange is the config's own normalisation of the data it was
  // given, not an edit. Counting it as one marks a freshly opened editor dirty.
  const seenFirstChange = useRef(false)

  const [tokensReady, setTokensReady] = useState(false)

  useEffect(() => {
    let mounted = true
    fetch('/api/admin/appearance')
      .then((r) => r.json())
      .then((d: { designTokens?: unknown }) => {
        // The blocks resolve token ids to flat colours themselves - an inbox
        // cannot read a CSS variable - so the canvas needs the same lookup the
        // send-time renderer builds server-side.
        if (mounted && d?.designTokens) setEmailEditorPalette(paletteFromTokens(d.designTokens))
      })
      // A palette that will not load is a canvas drawn in the blocks' own
      // fallback colours. Worth showing; not worth blocking the editor over.
      .catch(() => {})
      .finally(() => { if (mounted) setTokensReady(true) })
    return () => { mounted = false }
  }, [])

  const config = useMemo(() => withImagePickerFields(emailSignaturePuckConfig), [])

  // Puck's own header carries a Publish button this screen has no use for - the
  // page's Save button is the one that stores the signature. Removed rather than
  // disabled, so there is only ever one thing to press.
  // Puck's override type insists on an element rather than null, so the header
  // is rendered as an empty fragment.
  const overrides = useMemo(() => ({ header: () => <></> }), [])

  const handleChange = useCallback((data: Data) => {
    if (!seenFirstChange.current) { seenFirstChange.current = true; return }
    onChange(data)
  }, [onChange])

  if (!tokensReady) {
    return (
      <div style={{ height: 560, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted)' }}>
        Loading the builder…
      </div>
    )
  }

  return (
    <div style={{ height: 560, border: '1px solid var(--color-border)', borderRadius: 6, overflow: 'hidden' }}>
      <Puck
        config={config as never}
        data={initialData}
        onChange={handleChange}
        overrides={overrides}
        iframe={{ enabled: false }}
      />
    </div>
  )
}

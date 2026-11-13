'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Puck } from '@puckeditor/core'
import type { Data } from '@puckeditor/core'
import '@puckeditor/core/no-external.css'
import { tabbedFieldsOverride } from '@/lib/puck/tabs/TabbedFieldsOverride'
import { emailSignaturePuckConfig, setEmailEditorPalette } from '@/lib/puck/email-config'
import { paletteFromTokens } from '@/lib/email/palette'
import { withImagePickerFields } from '@/lib/puck/MediaPickerField'
import { useAdminConfirm } from '@/components/admin/useAdminConfirm'
import { MERGE_TAGS, MERGE_TAG_HELP, LINK_TAGS } from '@/modules/unified-inbox/lib/campaigns/personalise'
import type { CampaignDesign } from '@/modules/unified-inbox/lib/campaigns/design'

// ---------------------------------------------------------------------------
// The campaign message, designed rather than typed - over the whole screen.
//
// Core's own email blocks (the ones the site's email designs and block-built
// signatures are made of), minus "the message goes here", because this IS the
// message. Whatever is built here is rendered by the same core code when it is
// sent, so the canvas and the inbox agree.
//
// It pops out over everything rather than sitting in the campaign form: a
// designer squeezed into a column beside a list of campaigns is a designer
// nobody can see the email in. Nothing is saved from in here - Done hands the
// design back to the form, and the form's own Save keeps it, exactly as with
// every other box on the campaign. Cancel throws away what was done in here.
//
// Loaded only when somebody opens it: Puck and its stylesheet are a large
// import for a button most campaigns never press.
// ---------------------------------------------------------------------------

const EMPTY_DESIGN = { root: { props: {} }, content: [], zones: {} } as unknown as Data

type Props = {
  /** What it says now, or null to start from nothing. Read once, on opening. */
  value: CampaignDesign | null
  /** Which message this is, for the bar along the top. */
  title: string
  onDone: (design: CampaignDesign) => void
  onCancel: () => void
}

export default function CampaignDesigner({ value, title, onDone, onCancel }: Props) {
  // Puck is uncontrolled after mount: handing it a new document on every edit
  // would throw away what is selected. So the value is read once.
  const initial = useMemo(() => {
    const data = value as Data | null
    return data && typeof data === 'object' ? data : EMPTY_DESIGN
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount value only, by design
  }, [])

  const latest = useRef<Data>(initial)
  const seenFirstChange = useRef(false)
  const [changed, setChanged] = useState(false)
  const [tokensReady, setTokensReady] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [askConfirm, confirmNode] = useAdminConfirm()

  // Portals need a document, which a server render does not have.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- a one-off "the browser is here" flag
  useEffect(() => { setMounted(true) }, [])

  // The page behind does not scroll while this is over it.
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [])

  useEffect(() => {
    let live = true
    fetch('/api/admin/appearance')
      .then((r) => r.json())
      .then((d: { designTokens?: unknown }) => {
        // The blocks turn the site's colour names into plain colours themselves
        // - an inbox cannot read the site's stylesheet - so the canvas needs
        // the same lookup the send does.
        if (live && d?.designTokens) setEmailEditorPalette(paletteFromTokens(d.designTokens))
      })
      // A palette that will not load is a canvas in the blocks' own fallback
      // colours. Worth showing; not worth refusing to open over.
      .catch(() => {})
      .finally(() => { if (live) setTokensReady(true) })
    return () => { live = false }
  }, [])

  const config = useMemo(() => withImagePickerFields(emailSignaturePuckConfig), [])
  // Puck's own header has a Publish button with nothing to publish to; this
  // bar's Done is the one thing to press.
  const overrides = useMemo(() => ({ header: () => <></>, fields: tabbedFieldsOverride }), [])

  const handleChange = useCallback((data: Data) => {
    latest.current = data
    // The first call is Puck tidying the document it was given, not an edit.
    if (!seenFirstChange.current) { seenFirstChange.current = true; return }
    setChanged(true)
  }, [])

  const done = useCallback(() => {
    onDone(latest.current as unknown as CampaignDesign)
  }, [onDone])

  const cancel = useCallback(async () => {
    if (changed && !await askConfirm({
      title: 'Leave the designer?',
      message: 'What you have done in here since opening it will be lost.',
      confirmLabel: 'Throw it away',
    })) return
    onCancel()
  }, [askConfirm, changed, onCancel])

  // Escape closes it, asking first if there is anything to lose - but not
  // while a field inside the designer has the keyboard, where Escape means
  // something to that field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const target = event.target as HTMLElement | null
      if (target && target.closest('input, textarea, select, [contenteditable="true"]')) return
      void cancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cancel])

  if (!mounted) return null

  return createPortal(
    <div className="uin-camp-designer" role="dialog" aria-modal="true" aria-label={`Designing ${title}`}>
      {confirmNode}
      <div className="uin-camp-designer-head">
        <div className="uin-camp-designer-title">
          <strong>Designing {title}</strong>
          <span>Nothing is kept until you press Done here and then Save on the campaign.</span>
        </div>
        <div className="uin-camp-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void cancel()}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={done}>
            Done
          </button>
        </div>
      </div>

      {/* The merge tags work in any text, heading, button or link in here, the
          same as in the plain box - fallback and all. */}
      <div className="uin-camp-designer-tags">
        <span>Works in any text, heading, button or link:</span>
        {MERGE_TAGS.map((tag) => (
          <code key={tag} title={MERGE_TAG_HELP[tag]}>
            {LINK_TAGS.has(tag) ? `{{${tag}}}` : `{{${tag}|there}}`}
          </code>
        ))}
      </div>

      <div className="uin-camp-designer-canvas">
        {tokensReady ? (
          <Puck
            config={config as never}
            data={initial}
            onChange={handleChange}
            overrides={overrides}
            iframe={{ enabled: false }}
          />
        ) : (
          <div className="uin-empty">Loading the designer&hellip;</div>
        )}
      </div>
    </div>,
    document.body,
  )
}

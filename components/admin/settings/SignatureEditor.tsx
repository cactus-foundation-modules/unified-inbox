'use client'

import { useCallback, useId, useState } from 'react'
import dynamic from 'next/dynamic'
import type { Data } from '@puckeditor/core'
import MarkdownEditor from '../MarkdownEditor'
import { API } from './api'
import type { SignatureKind } from './types'
import type { InboxDraft } from './inbox-draft'
import { GROUP_LABEL, MUTED } from './ui'

// Puck and its stylesheet are a large import for a screen most people open to
// change a folder name, so the signature builder only arrives if they ask for
// it.
const SignaturePuckEditor = dynamic(() => import('../SignaturePuckEditor'), {
  ssr: false,
  loading: () => (
    <div style={{ height: 560, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted)' }}>
      Loading the builder…
    </div>
  ),
})

const SIGNATURE_KIND_OPTIONS: Array<{ value: SignatureKind; label: string; hint: string }> = [
  { value: 'markdown', label: 'Rich text', hint: 'Type it. Bold, links, lists - nothing to think about.' },
  { value: 'html', label: 'HTML', hint: 'Paste the signature your organisation already uses.' },
  { value: 'puck', label: 'Page builder', hint: 'Build it out of blocks, the way you build a page.' },
]

const SIGNATURE_MERGE_TAGS: Array<{ tag: string; label: string }> = [
  { tag: '{{FROM_NAME}}', label: 'the name replies go out under' },
  { tag: '{{INBOX_NAME}}', label: 'what this inbox is called' },
  { tag: '{{EMAIL}}', label: 'this inbox’s address' },
]

/** One signature per inbox, written whichever way suits the person writing it:
 *  typed as rich text, pasted as the markup the organisation already uses, or
 *  built out of the same blocks the site's emails are built from. All three are
 *  kept, so switching between them loses nothing.
 *
 *  The preview is rendered on the server on purpose - the block-built kind
 *  resolves the site's colours and fonts there, and a preview drawn any other
 *  way is a preview that can disagree with the email that goes out. */
export function SignatureEditor({ draft, setDraft }: {
  draft: InboxDraft
  setDraft: React.Dispatch<React.SetStateAction<InboxDraft>>
}) {
  const [preview, setPreview] = useState<string | null>(null)
  const [previewShown, setPreviewShown] = useState(false)
  const [previewBusy, setPreviewBusy] = useState(false)
  // Whether the last attempt got an answer at all. Without this, a preview that
  // could not be drawn was reported as an empty signature, which is a lie about
  // somebody's own data.
  const [previewFailed, setPreviewFailed] = useState(false)
  const fid = useId()

  const handlePuckChange = useCallback(
    (data: Data) => setDraft((d) => ({ ...d, signaturePuck: data })),
    [setDraft],
  )

  async function refreshPreview() {
    setPreviewBusy(true)
    setPreviewFailed(false)
    try {
      const res = await fetch(`${API}/signature-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: draft.signatureKind,
          signature: draft.signature || null,
          signatureHtml: draft.signatureHtml || null,
          signaturePuck: draft.signaturePuck ?? null,
          name: draft.name,
          address: draft.address,
          fromName: draft.fromName || null,
        }),
      })
      if (!res.ok) {
        setPreview(null)
        setPreviewFailed(true)
      } else {
        const body = (await res.json()) as { html: string | null }
        setPreview(body.html)
      }
    } catch {
      setPreview(null)
      setPreviewFailed(true)
    } finally {
      setPreviewShown(true)
      setPreviewBusy(false)
    }
  }

  return (
    <div className="field" role="group" aria-labelledby={`${fid}-sig-label`}>
      {/* A group rather than one box: what it names is the row of choices below
          and whichever editor they open. */}
      <span id={`${fid}-sig-label`} style={GROUP_LABEL}>How to write it</span>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', margin: '0.25rem 0 0.75rem' }}>
        {SIGNATURE_KIND_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setDraft((d) => ({ ...d, signatureKind: option.value }))}
            aria-pressed={draft.signatureKind === option.value}
            style={{
              flex: '1 1 12rem', textAlign: 'left', cursor: 'pointer',
              padding: '0.75rem', borderRadius: 6,
              // --color-primary, not --color-accent: the latter is not a token
              // this site has, and an unresolved variable takes the whole border
              // with it - so the chosen one was the only one without an edge.
              border: `1px solid ${draft.signatureKind === option.value ? 'var(--color-primary)' : 'var(--color-border)'}`,
              background: draft.signatureKind === option.value ? 'var(--color-primary-subtle)' : 'var(--color-bg)',
              color: 'var(--color-text)',
            }}
          >
            <span style={{ display: 'block', fontWeight: 600, fontSize: '0.875rem' }}>{option.label}</span>
            <span style={{ display: 'block', fontSize: '0.75rem', color: 'var(--color-text-secondary)', marginTop: '0.25rem' }}>
              {option.hint}
            </span>
          </button>
        ))}
      </div>

      {draft.signatureKind === 'markdown' && (
        <MarkdownEditor
          value={draft.signature}
          onChange={(value) => setDraft((d) => ({ ...d, signature: value }))}
          rows={6}
          ariaLabel="Signature"
          placeholder={'Kind regards,\nThe Sales Team\n\nYour company'}
        />
      )}

      {draft.signatureKind === 'html' && (
        <>
          <label htmlFor={`${fid}-sig-html`} className="sr-only">The signature markup</label>
          <textarea
            id={`${fid}-sig-html`}
            rows={12}
            spellCheck={false}
            maxLength={50000}
            value={draft.signatureHtml}
            onChange={(e) => setDraft((d) => ({ ...d, signatureHtml: e.target.value }))}
            placeholder="<table>…</table>"
            style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.8125rem' }}
          />
          <span className="field-hint" style={{ display: 'block', marginTop: '0.5rem' }}>
            Tables, inline styles, images and links all come through as written. Scripts and anything
            that runs on its own - <code>onerror</code> and the like - are removed when you save,
            because this markup ends up in a customer&rsquo;s inbox rather than in here.
          </span>
        </>
      )}

      {draft.signatureKind === 'puck' && (
        <>
          <span className="field-hint" style={{ display: 'block', marginBottom: '0.5rem' }}>
            The same blocks the site&rsquo;s emails are built from. Text blocks accept the tags below.
          </span>
          <SignaturePuckEditor value={draft.signaturePuck} onChange={handlePuckChange} />
        </>
      )}

      {draft.signatureKind !== 'markdown' && (
        <span className="field-hint" style={{ display: 'block', marginTop: '0.5rem' }}>
          Fill-in tags:{' '}
          {SIGNATURE_MERGE_TAGS.map((t, i) => (
            <span key={t.tag}>{i > 0 ? ', ' : ''}<code>{t.tag}</code> ({t.label})</span>
          ))}
        </span>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '0.75rem' }}>
        <button type="button" className="btn btn-secondary btn-sm" disabled={previewBusy} onClick={refreshPreview}>
          {previewBusy ? 'Working…' : 'Show me how it will look'}
        </button>
      </div>

      {previewShown && (
        preview ? (
          <div
            style={{
              marginTop: '0.75rem', padding: '1rem', borderRadius: 6,
              border: '1px solid var(--color-border)',
              // The one hex in the module, and it has to stay one. This is a
              // picture of what an email will look like where it lands, and an
              // inbox has a white page whichever theme the admin is wearing. A
              // token here would repaint the preview and stop it being a preview.
              background: '#ffffff', colorScheme: 'light', overflowX: 'auto',
            }}
            dangerouslySetInnerHTML={{ __html: preview }}
          />
        ) : previewFailed ? (
          <span role="alert" style={{ color: 'var(--color-destructive-hover)', fontSize: '0.8125rem', display: 'block', marginTop: '0.75rem' }}>
            The preview could not be drawn just now, so this is not a picture of an empty signature - it is
            no picture at all. Try it again in a moment.
          </span>
        ) : (
          <span style={{ ...MUTED, fontSize: '0.8125rem', display: 'block', marginTop: '0.75rem' }}>
            Nothing to show - this signature is empty, so replies go out without one.
          </span>
        )
      )}
    </div>
  )
}

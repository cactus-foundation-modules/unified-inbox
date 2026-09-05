'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { inboxHref } from '@/modules/unified-inbox/lib/list'
import {
  buildImportTemplateCsv,
  CONTACT_FIELD_GROUPS,
  CONTACT_FIELD_LABELS,
  guessColumnMap,
  isWorthImporting,
  MAX_IMPORT_ROWS,
  parseCsv,
  rowToContact,
  type ColumnTarget,
  type ImportSummary,
} from '@/modules/unified-inbox/lib/contacts'
import { BackIcon } from './icons'

// Bringing an address book in from somewhere else.
//
// Three steps, in the order somebody actually does them: choose the file, say
// what each column is, bring it in. The middle step is the whole point. Every
// system in the world exports contacts under slightly different headings, and a
// tool that insists on its own column names is a tool that gets used once and
// then abandoned for a morning of copying and pasting.
//
// The guess is made first and shown as the starting point, so a file exported
// from Outlook or Google needs nothing changed and a file somebody typed
// themselves needs three menus set. Getting a guess wrong costs a moment;
// refusing to guess costs fifteen menus on every file.
//
// The file is read HERE and never uploaded. What is posted is the rows and the
// decision made about each column, which means the server applies exactly what
// was on the screen when the button was pressed rather than re-reading a file
// and hoping it reads it the same way. It also means nothing lands in storage
// that then has to be swept up: an address book is the most personal thing a
// site holds, and the copy of it that never existed is the one that cannot leak.

type Props = {
  base: string
  params: Record<string, string>
}

/** How many rows of the file are shown before the button. Enough to notice a
 *  column in the wrong place, few enough to still see the button. */
const PREVIEW_ROWS = 5

/** What the target menu offers, grouped the way the card is. 'fullName' is
 *  offered alongside the fields because a single "Name" column is the commonest
 *  thing a hand-kept spreadsheet has. */
const TARGET_GROUPS: ReadonlyArray<{ label: string; options: ReadonlyArray<{ value: ColumnTarget; label: string }> }> = [
  {
    label: 'Name',
    options: [
      { value: 'firstName', label: CONTACT_FIELD_LABELS.firstName },
      { value: 'lastName', label: CONTACT_FIELD_LABELS.lastName },
      { value: 'fullName', label: 'Full name (split into first and last)' },
    ],
  },
  ...CONTACT_FIELD_GROUPS.map((group) => ({
    label: group.label,
    options: group.fields
      .filter((field) => field !== 'firstName' && field !== 'lastName')
      .map((field) => ({ value: field as ColumnTarget, label: CONTACT_FIELD_LABELS[field] })),
  })),
]

export function ContactImport({ base, params }: Props) {
  const router = useRouter()
  const [filename, setFilename] = useState('')
  const [header, setHeader] = useState<string[]>([])
  const [rows, setRows] = useState<string[][]>([])
  const [map, setMap] = useState<ColumnTarget[]>([])
  const [updateExisting, setUpdateExisting] = useState(false)
  const [categoryName, setCategoryName] = useState('')
  const [categories, setCategories] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [summary, setSummary] = useState<ImportSummary | null>(null)

  // The labels the site already has, offered under the box so a file is filed
  // under an existing one rather than under a new one spelt slightly differently.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch('/api/m/unified-inbox/categories')
        if (!response.ok) return
        const body = await response.json() as { categories?: Array<{ name: string }> }
        if (!cancelled) setCategories((body.categories ?? []).map((c) => c.name))
      } catch {
        // A box with no suggestions under it still works perfectly well.
      }
    })()
    return () => { cancelled = true }
  }, [])

  const readable = useMemo(
    () => rows.slice(0, PREVIEW_ROWS).map((row) => rowToContact(row, map)),
    [rows, map],
  )
  const usableRows = useMemo(
    () => rows.filter((row) => isWorthImporting(rowToContact(row, map))).length,
    [rows, map],
  )
  const mappedAnything = map.some((target) => target !== '')

  const choose = async (file: File | null) => {
    setError('')
    setSummary(null)
    if (!file) return
    try {
      const text = await file.text()
      const parsed = parseCsv(text)
      const [first, ...rest] = parsed
      if (!first || rest.length === 0) {
        setError('That file has a heading row and nothing under it.')
        setHeader([])
        setRows([])
        setMap([])
        return
      }
      if (rest.length > MAX_IMPORT_ROWS) {
        setError(`That file has ${rest.length.toLocaleString('en-GB')} rows, and ${MAX_IMPORT_ROWS.toLocaleString('en-GB')} is the most that can come in at once. Split it and bring it in in two goes.`)
        return
      }
      setFilename(file.name)
      setHeader(first)
      setRows(rest)
      setMap(guessColumnMap(first))
    } catch {
      setError('That file could not be read. It needs to be a CSV.')
    }
  }

  const setTarget = (index: number, target: ColumnTarget) => {
    setMap((current) => {
      const next = [...current]
      // One field, one column. Picking a field another column already has takes
      // it off that one rather than filling it twice - which is what somebody
      // means when they correct a guess.
      if (target) {
        for (let i = 0; i < next.length; i++) if (i !== index && next[i] === target) next[i] = ''
      }
      next[index] = target
      return next
    })
  }

  const run = async () => {
    setBusy(true)
    setError('')
    setSummary(null)
    try {
      const response = await fetch('/api/m/unified-inbox/contacts/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          columns: map, rows, updateExisting, categoryName: categoryName.trim() || null,
        }),
      })
      const body = await response.json().catch(() => null) as
        { error?: string; summary?: ImportSummary } | null
      if (!response.ok || !body?.summary) {
        setError(body?.error ?? 'That import did not run.')
        return
      }
      setSummary(body.summary)
      router.refresh()
    } catch {
      setError('The site could not be reached, so nothing was brought in.')
    } finally {
      setBusy(false)
    }
  }

  const template = `data:text/csv;charset=utf-8,${encodeURIComponent(buildImportTemplateCsv())}`

  return (
    <div className="uin-thread">
      <div className="uin-thread-head">
        <Link
          className="uin-chip uin-back"
          href={inboxHref(base, params, { import: null })}
          style={{ justifySelf: 'start' }}
        >
          <span className="uin-back-phone" aria-hidden="true">{BackIcon} Back to the list</span>
          <span className="uin-back-wide" aria-hidden="true">&times; Close</span>
          <span className="sr-only">Close the importer and go back to the list</span>
        </Link>
        <h2 className="uin-thread-subject">Import contacts</h2>
        <div className="uin-thread-meta">
          <span>The file stays on this computer. Only the rows you can see below are sent.</span>
        </div>
      </div>

      <div className="uin-thread-body">
        <div className="uin-card">
          {error && <div className="alert alert-danger" role="alert">{error}</div>}

          <section className="uin-card-section">
            <h4 className="uin-ctx-heading">1. Choose the file</h4>
            <p className="uin-ctx-sub">
              A CSV, saved out of a spreadsheet or exported from wherever the contacts are
              now. If you would rather start from ours,{' '}
              <a href={template} download="contacts-template.csv">download a blank one</a>.
            </p>
            <input
              type="file"
              accept=".csv,text/csv,text/plain"
              disabled={busy}
              onChange={(event) => { void choose(event.target.files?.[0] ?? null) }}
            />
            {filename && (
              <p className="uin-ctx-sub">
                {filename} - {rows.length.toLocaleString('en-GB')}{' '}
                {rows.length === 1 ? 'row' : 'rows'}, {header.length}{' '}
                {header.length === 1 ? 'column' : 'columns'}.
              </p>
            )}
          </section>

          {header.length > 0 && (
            <>
              <section className="uin-card-section">
                <h4 className="uin-ctx-heading">2. Match the columns</h4>
                <p className="uin-ctx-sub">
                  We have had a go at this already. Change anything that looks wrong, and
                  set anything you do not want to &ldquo;Leave this column out&rdquo;.
                </p>
                <div className="uin-fields">
                  {header.map((column, index) => (
                    <div className="uin-field-row" key={`${column}-${index}`}>
                      <label htmlFor={`uin-map-${index}`}>{column || `Column ${index + 1}`}</label>
                      <div className="uin-field-control">
                        <select
                          id={`uin-map-${index}`}
                          value={map[index] ?? ''}
                          disabled={busy}
                          onChange={(event) => setTarget(index, event.target.value as ColumnTarget)}
                        >
                          <option value="">Leave this column out</option>
                          {TARGET_GROUPS.map((group) => (
                            <optgroup key={group.label} label={group.label}>
                              {group.options.map((option) => (
                                <option key={option.value} value={option.value}>{option.label}</option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                        <span className="uin-field-hint">
                          {rows[0]?.[index]?.trim() || 'blank'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="uin-card-section">
                <h4 className="uin-ctx-heading">3. Check and bring them in</h4>
                {mappedAnything ? (
                  <>
                    <p className="uin-ctx-sub">
                      The first {Math.min(PREVIEW_ROWS, rows.length)} rows, as they would be
                      saved.
                    </p>
                    <ul className="uin-ctx-list">
                      {readable.map((contact, index) => (
                        <li key={index} className="uin-ctx-row">
                          <div className="uin-ctx-main">
                            <span className="uin-ctx-name">
                              {[contact.firstName, contact.lastName].filter(Boolean).join(' ')
                                || contact.email || contact.phone || contact.organisation
                                || 'Nothing on this row'}
                            </span>
                            {contact.organisation && <span className="uin-tag">{contact.organisation}</span>}
                          </div>
                          <span className="uin-ctx-sub">
                            {[contact.jobTitle, contact.email, contact.phone, contact.addressPostcode]
                              .filter(Boolean).join(' · ') || 'No other details'}
                          </span>
                        </li>
                      ))}
                    </ul>

                    <div className="uin-field-row">
                      <label htmlFor="uin-import-category">Category</label>
                      <div className="uin-field-control">
                        <input
                          id="uin-import-category"
                          list="uin-import-categories"
                          value={categoryName}
                          disabled={busy}
                          placeholder="Leave empty for none"
                          onChange={(event) => setCategoryName(event.target.value)}
                        />
                        <datalist id="uin-import-categories">
                          {categories.map((name) => <option key={name} value={name} />)}
                        </datalist>
                        <span className="uin-field-hint">Put everybody in this file in it</span>
                      </div>
                    </div>
                    <p className="uin-ctx-sub">
                      On top of anything a category column on the row says, and never instead
                      of it. Nobody loses a label they already had.
                    </p>

                    <label className="uin-card-check">
                      <input
                        type="checkbox"
                        checked={updateExisting}
                        disabled={busy}
                        onChange={(event) => setUpdateExisting(event.target.checked)}
                      />
                      <span>
                        Fill in contacts already here. Off, a row whose address or number we
                        already hold is counted and left alone - which is the safe answer for a
                        file with half its columns blank.
                      </span>
                    </label>

                    <div className="uin-actions">
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={busy || usableRows === 0}
                        onClick={() => { void run() }}
                      >
                        {busy
                          ? 'Bringing them in...'
                          : `Import ${usableRows.toLocaleString('en-GB')} ${usableRows === 1 ? 'contact' : 'contacts'}`}
                      </button>
                    </div>
                    {usableRows === 0 && (
                      <p className="uin-ctx-sub">
                        Nothing on those rows would make a contact. Check the columns above -
                        a row needs a name, an address, a number or an organisation.
                      </p>
                    )}
                  </>
                ) : (
                  <p className="uin-ctx-sub">
                    Nothing is matched to anything yet, so there is nothing to bring in.
                  </p>
                )}
              </section>
            </>
          )}

          {summary && (
            <section className="uin-card-section">
              <h4 className="uin-ctx-heading">Done</h4>
              <div className="alert alert-info" role="status">
                {summary.created.toLocaleString('en-GB')} added,{' '}
                {summary.updated.toLocaleString('en-GB')} filled in,{' '}
                {summary.skipped.toLocaleString('en-GB')} left alone
                {summary.organisationsCreated > 0 && (
                  <>, {summary.organisationsCreated.toLocaleString('en-GB')}{' '}
                  {summary.organisationsCreated === 1 ? 'organisation' : 'organisations'} created</>
                )}
                {summary.categoriesCreated > 0 && (
                  <>, {summary.categoriesCreated.toLocaleString('en-GB')} new{' '}
                  {summary.categoriesCreated === 1 ? 'category' : 'categories'}</>
                )}.
              </div>
              {summary.problems.length > 0 && (
                <>
                  <p className="uin-ctx-sub">What was left alone, and why:</p>
                  <ul className="uin-log">
                    {summary.problems.map((problem) => (
                      <li key={`${problem.row}-${problem.reason}`}>
                        Row {problem.row}: {problem.reason}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <div className="uin-actions">
                <Link className="btn btn-secondary btn-sm" href={inboxHref(base, params, { import: null })}>
                  Back to the contacts
                </Link>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}

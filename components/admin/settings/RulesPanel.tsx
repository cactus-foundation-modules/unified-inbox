'use client'

import { useCallback, useEffect, useId, useState, type CSSProperties } from 'react'
import { useAdminConfirm } from '@/components/admin/useAdminConfirm'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import type { RuleBody } from '@/modules/unified-inbox/lib/rules'
import { API, OFFLINE } from './api'
import { RuleEditor } from './RuleEditor'
import {
  RULE_TEMPLATES,
  blankRule,
  describeRule,
  whenAgo,
  type Named,
  type RuleTemplate,
  type RuleView,
} from './rules-ui'
import { Chip, EditPanel, EmptyState, HeaderActions, ListRow, MUTED, NoteAlert, Panel } from './ui'
import type { Note } from './types'

// ---------------------------------------------------------------------------
// The Rules tab.
//
// A list of rules, top one first, each with a switch, a one-line account of
// what it does in plain English and how often it has done it. A rule opens in
// the editor (RuleEditor.tsx), which shows what it would have done to recent
// post as it is written. Once saved, a rule can be run over the mail that is
// already here, and shows what it has done lately with a way to put a merge
// back.
// ---------------------------------------------------------------------------

type Editing = { ruleId: string | null; initial: RuleBody; key: number } | null

type RunRow = {
  id: string
  messageId: string
  threadId: string | null
  summary: string | null
  mergeIds: string[]
  undone: boolean
  createdAt: string
}

type Backfill = { state: 'idle' } | { state: 'running'; looked: number; applied: number } | { state: 'done'; looked: number; applied: number }

const BACKFILL_DAYS = [7, 14, 30, 90] as const

/** Hover and keyboard focus, which inline styles cannot say. Prefixed, so
 *  nothing in core or another module can collide with them. */
const RULES_CSS = `
.uin-rule-switch:focus-visible + span { box-shadow: 0 0 0 3px var(--color-primary-glow); }
.uin-rule-template { transition: border-color var(--dur-base, 150ms), background var(--dur-base, 150ms); }
.uin-rule-template:hover { border-color: var(--color-border-strong); background: var(--color-surface); }
.uin-rule-template:focus-visible { outline: none; border-color: var(--color-border-focus); box-shadow: 0 0 0 3px var(--color-primary-glow); }
`

const ICONS: Record<RuleTemplate['icon'], string> = {
  merge: 'M5 3v4a4 4 0 0 0 4 4h6M5 21v-4a4 4 0 0 1 4-4h6m0-6 4 4-4 4',
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0',
  tick: 'M4 12l5 5L20 6',
  inbox: 'M3 13h5l1.5 3h5L16 13h5M5 5h14l2 8v6H3v-6l2-8Z',
}

function Icon({ path }: { path: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={path} />
    </svg>
  )
}

/** The on/off switch beside each rule. A real checkbox underneath, so a
 *  keyboard and a screen reader get the control they expect. */
function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  const track: CSSProperties = {
    position: 'relative',
    display: 'inline-block',
    width: 40,
    height: 22,
    borderRadius: 999,
    background: checked ? 'var(--color-primary)' : 'var(--color-border-strong)',
    transition: 'background var(--dur-base, 150ms)',
    flexShrink: 0,
    opacity: disabled ? 0.5 : 1,
  }
  const knob: CSSProperties = {
    position: 'absolute',
    top: 3,
    left: checked ? 21 : 3,
    width: 16,
    height: 16,
    borderRadius: '50%',
    background: 'var(--color-surface)',
    boxShadow: '0 1px 2px var(--color-overlay)',
    transition: 'left var(--dur-base, 150ms)',
  }
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', cursor: disabled ? 'default' : 'pointer' }}>
      <input
        type="checkbox"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="uin-rule-switch"
        style={{ position: 'absolute', opacity: 0, width: 1, height: 1 }}
      />
      <span style={track} aria-hidden="true"><span style={knob} /></span>
    </label>
  )
}

function TemplateGallery({ onPick, compact }: { onPick: (template: RuleTemplate | null) => void; compact?: boolean }) {
  return (
    <div>
      {!compact && (
        <p style={{ ...MUTED, fontSize: 'var(--text-sm)', margin: '0 0 0.75rem' }}>Start from one of these, or from a blank rule.</p>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 15rem), 1fr))', gap: '0.75rem' }}>
        {RULE_TEMPLATES.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => onPick(t)}
            className="uin-rule-template"
            style={{
              textAlign: 'left',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.375rem',
              padding: '0.875rem 1rem',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--color-bg)',
              color: 'var(--color-text)',
              cursor: 'pointer',
              font: 'inherit',
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 'var(--radius)', background: 'var(--color-primary-subtle)', color: 'var(--color-primary)' }}>
              <Icon path={ICONS[t.icon]} />
            </span>
            <span style={{ fontWeight: 'var(--font-semibold)', fontSize: 'var(--text-sm)' }}>{t.title}</span>
            <span className="field-hint">{t.blurb}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => onPick(null)}
          className="uin-rule-template"
          style={{
            textAlign: 'left',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            gap: '0.375rem',
            padding: '0.875rem 1rem',
            border: '1px dashed var(--color-border-strong)',
            borderRadius: 'var(--radius-md)',
            background: 'transparent',
            color: 'var(--color-text)',
            cursor: 'pointer',
            font: 'inherit',
          }}
        >
          <span style={{ fontWeight: 'var(--font-semibold)', fontSize: 'var(--text-sm)' }}>+ A blank rule</span>
          <span className="field-hint">Pick the conditions and steps yourself.</span>
        </button>
      </div>
    </div>
  )
}

function RuleActivity({ ruleId, inboxBase, refreshKey }: { ruleId: string; inboxBase: string; refreshKey: number }) {
  const [runs, setRuns] = useState<RunRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [undoing, setUndoing] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API}/rules/${ruleId}/activity`)
      const body = await res.json().catch(() => ({})) as { runs?: RunRow[]; error?: string }
      if (!res.ok) { setError(body.error ?? 'Could not load what this rule has done.'); return }
      setRuns(body.runs ?? [])
      setError(null)
    } catch {
      setError(OFFLINE)
    }
  }, [ruleId])

  // eslint-disable-next-line react-hooks/set-state-in-effect -- delegating to an async loader; every setState runs after an await
  useEffect(() => { void load() }, [load, refreshKey])

  async function undo(run: RunRow) {
    setUndoing(run.id)
    try {
      for (const mergeId of run.mergeIds) {
        const res = await fetch(`/api/m/unified-inbox/threads/merges/${mergeId}/undo`, { method: 'POST' })
        if (!res.ok) {
          const body = await res.json().catch(() => ({})) as { error?: string }
          setError(body.error ?? 'Could not put that back.')
          return
        }
      }
      await load()
    } catch {
      setError(OFFLINE)
    } finally {
      setUndoing(null)
    }
  }

  if (error) return <p style={{ color: 'var(--color-danger)', fontSize: 'var(--text-sm)', margin: '0.75rem 0 0' }} role="alert">{error}</p>
  if (!runs) return <p style={{ ...MUTED, fontSize: 'var(--text-sm)', margin: '0.75rem 0 0' }}>Loading…</p>
  if (runs.length === 0) {
    return <p style={{ ...MUTED, fontSize: 'var(--text-sm)', margin: '0.75rem 0 0' }}>Nothing yet. It will show here the first time it does something.</p>
  }
  return (
    <ul style={{ listStyle: 'none', margin: '0.75rem 0 0', padding: 0, display: 'grid', gap: '0.375rem' }}>
      {runs.map((run) => (
        <li
          key={run.id}
          style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius)', background: 'var(--color-bg-subtle)' }}
        >
          <span style={{ flex: '1 1 16rem', minWidth: 0, fontSize: 'var(--text-sm)', textDecoration: run.undone ? 'line-through' : undefined, color: run.undone ? 'var(--color-text-muted)' : undefined }}>
            {run.summary}
          </span>
          <span className="field-hint" style={{ whiteSpace: 'nowrap' }}>{run.undone ? 'Put back' : whenAgo(run.createdAt)}</span>
          {run.threadId && (
            <a className="btn btn-ghost btn-sm" href={`${inboxBase}?tab=unified-inbox&id=${encodeURIComponent(run.threadId)}`}>Open</a>
          )}
          {run.mergeIds.length > 0 && !run.undone && (
            <button type="button" className="btn btn-ghost btn-sm" disabled={undoing === run.id} onClick={() => void undo(run)}>
              {undoing === run.id ? 'Putting back…' : 'Undo merge'}
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

function RuleCard({
  rule, index, total, inboxes, users, inboxBase, onEdit, onToggle, onMove, onDelete, onDuplicate, onRan, highlight,
}: {
  rule: RuleView
  index: number
  total: number
  inboxes: Named[]
  users: Named[]
  inboxBase: string
  onEdit: () => void
  onToggle: (next: boolean) => void
  onMove: (delta: -1 | 1) => void
  onDelete: () => void
  onDuplicate: () => void
  onRan: (note: Note) => void
  highlight: boolean
}) {
  const [open, setOpen] = useState<'activity' | 'run' | null>(highlight ? 'run' : null)
  const [days, setDays] = useState<(typeof BACKFILL_DAYS)[number]>(14)
  const [backfill, setBackfill] = useState<Backfill>({ state: 'idle' })
  const [refreshKey, setRefreshKey] = useState(0)
  const daysId = useId()

  async function run() {
    let looked = 0
    let applied = 0
    let after: string | null = null
    setBackfill({ state: 'running', looked, applied })
    try {
      for (let slice = 0; slice < 200; slice++) {
        const res: Response = await fetch(`${API}/rules/${rule.id}/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ days, after }),
        })
        const body = await res.json().catch(() => ({})) as { error?: string; applied?: number; looked?: number; next?: string | null; done?: boolean }
        if (!res.ok) {
          onRan({ tone: 'bad', text: body.error ?? 'That did not work.' })
          setBackfill({ state: 'idle' })
          return
        }
        looked += body.looked ?? 0
        applied += body.applied ?? 0
        setBackfill({ state: 'running', looked, applied })
        if (body.done !== false || !body.next) break
        after = body.next
      }
      setBackfill({ state: 'done', looked, applied })
      setRefreshKey((k) => k + 1)
      onRan({
        tone: 'ok',
        text: applied === 0
          ? `“${rule.name}” looked at ${looked} messages and found nothing it had not already dealt with.`
          : `“${rule.name}” looked at ${looked} messages and acted on ${applied}.`,
      })
    } catch {
      onRan({ tone: 'bad', text: OFFLINE })
      setBackfill({ state: 'idle' })
    }
  }

  const reorder: CSSProperties = { height: 28, width: 28, padding: 0 }

  return (
    <ListRow>
      <div style={{ display: 'flex', gap: '0.875rem', alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', alignItems: 'center', paddingTop: '0.125rem' }}>
          <span style={{ ...MUTED, fontSize: 'var(--text-xs)', fontVariantNumeric: 'tabular-nums' }} aria-hidden="true">{index + 1}</span>
          <button type="button" className="btn btn-ghost btn-sm" style={reorder} disabled={index === 0} onClick={() => onMove(-1)} aria-label={`Move “${rule.name}” up`} title="Run earlier">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true"><path d="M4 10l4-4 4 4" /></svg>
          </button>
          <button type="button" className="btn btn-ghost btn-sm" style={reorder} disabled={index === total - 1} onClick={() => onMove(1)} aria-label={`Move “${rule.name}” down`} title="Run later">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
          </button>
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', gap: '0.625rem', alignItems: 'center', minWidth: 0, flexWrap: 'wrap' }}>
              <Switch checked={rule.enabled} disabled={rule.unreadable} onChange={onToggle} label={`${rule.enabled ? 'Switch off' : 'Switch on'} “${rule.name}”`} />
              <strong style={{ fontSize: 'var(--text-base)', color: rule.enabled ? 'var(--color-text)' : 'var(--color-text-muted)' }}>{rule.name}</strong>
              {!rule.enabled && !rule.unreadable && <Chip tone="plain">Off</Chip>}
              {rule.unreadable && <Chip tone="bad">Needs saving again</Chip>}
              {rule.stopProcessing && <Chip tone="info">Stops here</Chip>}
              {rule.includeSent && <Chip tone="info">Sent mail too</Chip>}
            </div>
            <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-secondary btn-sm" onClick={onEdit}>Edit</button>
              <button type="button" className="btn btn-secondary btn-sm" aria-expanded={open === 'run'} onClick={() => setOpen(open === 'run' ? null : 'run')}>Run on recent mail</button>
              <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open === 'activity'} onClick={() => setOpen(open === 'activity' ? null : 'activity')}>Activity</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={onDuplicate}>Duplicate</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={onDelete} style={{ color: 'var(--color-danger)' }}>Delete</button>
            </div>
          </div>
          <p style={{ margin: '0.375rem 0 0', fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', lineHeight: 'var(--leading-base)' }}>
            {describeRule(rule, inboxes, users)}
          </p>
          <p className="field-hint" style={{ margin: '0.25rem 0 0' }}>
            {rule.fireCount === 0
              ? 'Has not done anything yet.'
              : `Done its thing ${rule.fireCount === 1 ? 'once' : `${rule.fireCount.toLocaleString('en-GB')} times`}, most recently ${whenAgo(rule.lastFiredAt)}.`}
          </p>

          {open === 'run' && (
            <div style={{ marginTop: '0.75rem', padding: '0.75rem', borderRadius: 'var(--radius)', background: 'var(--color-bg-subtle)', display: 'flex', alignItems: 'center', gap: '0.625rem', flexWrap: 'wrap' }}>
              <label htmlFor={daysId} style={{ fontSize: 'var(--text-sm)' }}>Run it over everything that arrived in the last</label>
              <span className="field" style={{ margin: 0 }}>
                <select id={daysId} value={days} onChange={(e) => setDays(Number(e.target.value) as (typeof BACKFILL_DAYS)[number])} style={{ height: 30, width: 'auto', paddingRight: '1.75rem' }} disabled={backfill.state === 'running'}>
                  {BACKFILL_DAYS.map((d) => <option key={d} value={d}>{d} days</option>)}
                </select>
              </span>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void run()} disabled={backfill.state === 'running' || rule.unreadable}>
                {backfill.state === 'running' ? 'Running…' : 'Run now'}
              </button>
              <span className="field-hint" aria-live="polite" style={{ flexBasis: '100%' }}>
                {backfill.state === 'running'
                  ? `Looked at ${backfill.looked} so far, acted on ${backfill.applied}.`
                  : backfill.state === 'done'
                    ? `Done: looked at ${backfill.looked}, acted on ${backfill.applied}.`
                    : 'Mail the rule has already dealt with is skipped, so running it twice is harmless.'}
              </span>
            </div>
          )}

          {(open === 'activity' || backfill.state === 'done') && (
            <RuleActivity ruleId={rule.id} inboxBase={inboxBase} refreshKey={refreshKey} />
          )}
        </div>
      </div>
    </ListRow>
  )
}

export function RulesPanel({ inboxes, users }: { inboxes: Named[]; users: Named[] }) {
  const [rules, setRules] = useState<RuleView[] | null>(null)
  const [editing, setEditing] = useState<Editing>(null)
  const [note, setNote] = useState<Note | null>(null)
  const [showTemplates, setShowTemplates] = useState(false)
  const [justSaved, setJustSaved] = useState<string | null>(null)
  const [confirm, confirmNode] = useAdminConfirm()
  const adminPath = useAdminPath()
  const inboxBase = `/${adminPath}/inbox`

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API}/rules`)
      const body = await res.json().catch(() => ({})) as { rules?: RuleView[]; error?: string }
      if (!res.ok) { setNote({ tone: 'bad', text: body.error ?? 'Could not load the rules.' }); return }
      setRules(body.rules ?? [])
    } catch {
      setNote({ tone: 'bad', text: OFFLINE })
    }
  }, [])

  // eslint-disable-next-line react-hooks/set-state-in-effect -- delegating to an async loader; every setState runs after an await
  useEffect(() => { void load() }, [load])

  function startFrom(template: RuleTemplate | null) {
    setShowTemplates(false)
    setNote(null)
    setEditing({ ruleId: null, initial: template ? template.build() : blankRule(), key: Date.now() })
  }

  function bodyOf(rule: RuleView): RuleBody {
    return {
      name: rule.name,
      enabled: rule.enabled,
      trigger: rule.trigger,
      match: rule.match,
      conditions: rule.conditions,
      actions: rule.actions,
      stopProcessing: rule.stopProcessing,
      includeSent: rule.includeSent,
    }
  }

  async function send(path: string, init: RequestInit): Promise<boolean> {
    try {
      const res = await fetch(`${API}${path}`, { ...init, headers: { 'Content-Type': 'application/json' } })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        setNote({ tone: 'bad', text: body.error ?? 'That did not work.' })
        return false
      }
      return true
    } catch {
      setNote({ tone: 'bad', text: OFFLINE })
      return false
    }
  }

  async function toggle(rule: RuleView, enabled: boolean) {
    setRules((current) => current?.map((r) => (r.id === rule.id ? { ...r, enabled } : r)) ?? current)
    if (!await send(`/rules/${rule.id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) })) await load()
  }

  async function move(index: number, delta: -1 | 1) {
    if (!rules) return
    const next = [...rules]
    const [moved] = next.splice(index, 1)
    if (!moved) return
    next.splice(index + delta, 0, moved)
    setRules(next)
    if (!await send('/rules/order', { method: 'POST', body: JSON.stringify({ ids: next.map((r) => r.id) }) })) await load()
  }

  async function remove(rule: RuleView) {
    const ok = await confirm({
      title: 'Delete this rule?',
      message: `“${rule.name}” stops running straight away. Anything it has already done stays done - a merge it made can still be put back from the conversation.`,
      confirmLabel: 'Delete rule',
    })
    if (!ok) return
    if (await send(`/rules/${rule.id}`, { method: 'DELETE' })) {
      setNote({ tone: 'ok', text: 'Rule deleted.' })
      await load()
    }
  }

  const editor = editing && (
    <EditPanel title={editing.ruleId ? 'Edit rule' : 'New rule'}>
      <RuleEditor
        key={editing.key}
        initial={editing.initial}
        ruleId={editing.ruleId}
        inboxes={inboxes}
        users={users}
        onCancel={() => setEditing(null)}
        onSaved={(text, savedId, isNew) => {
          setEditing(null)
          setNote({ tone: 'ok', text: isNew ? `${text} To tidy up mail that is already here, use “Run on recent mail” below.` : text })
          setJustSaved(isNew ? savedId : null)
          void load()
        }}
      />
    </EditPanel>
  )

  return (
    <>
      {confirmNode}
      <style>{RULES_CSS}</style>
      <Panel
        title="Rules"
        blurb="Tell the inbox what to do with mail as it arrives: put a supplier’s reply with the order it is about, hand everything from one company to the person who looks after them, file receipts away as done. Rules run top to bottom on every message collected from now on."
      >
        {!editing && (
          <HeaderActions>
            <button type="button" className="btn btn-primary" onClick={() => setShowTemplates((v) => !v)} aria-expanded={showTemplates}>
              New rule
            </button>
          </HeaderActions>
        )}

        <NoteAlert note={note} />

        {editing ? editor : (
          <>
            {showTemplates && rules && rules.length > 0 && (
              <div style={{ marginBottom: '1.25rem' }}>
                <TemplateGallery onPick={startFrom} />
              </div>
            )}

            {rules === null && <p style={MUTED}>Loading…</p>}

            {rules && rules.length === 0 && (
              <EmptyState>
                <div style={{ textAlign: 'left' }}>
                  <p style={{ margin: '0 0 1rem', color: 'var(--color-text)', fontWeight: 'var(--font-medium)', textAlign: 'center' }}>
                    No rules yet, so mail is filed exactly as it arrives.
                  </p>
                  <TemplateGallery onPick={startFrom} compact />
                </div>
              </EmptyState>
            )}

            {rules && rules.map((rule, index) => (
              <RuleCard
                key={rule.id}
                rule={rule}
                index={index}
                total={rules.length}
                inboxes={inboxes}
                users={users}
                inboxBase={inboxBase}
                highlight={justSaved === rule.id}
                onEdit={() => { setNote(null); setEditing({ ruleId: rule.id, initial: bodyOf(rule), key: Date.now() }) }}
                onToggle={(next) => void toggle(rule, next)}
                onMove={(delta) => void move(index, delta)}
                onDelete={() => void remove(rule)}
                onDuplicate={() => {
                  setNote(null)
                  setEditing({ ruleId: null, initial: { ...bodyOf(rule), name: `${rule.name} (copy)`.slice(0, 120), enabled: false }, key: Date.now() })
                }}
                onRan={setNote}
              />
            ))}
          </>
        )}
      </Panel>
    </>
  )
}

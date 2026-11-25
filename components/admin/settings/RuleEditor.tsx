'use client'

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  MAX_ACTIONS,
  MAX_CONDITIONS,
  RuleBody,
  patternFromExample,
  ruleProblem,
  type RuleAction,
  type RuleActionType,
  type RuleCondition,
} from '@/modules/unified-inbox/lib/rules'
import { API, OFFLINE } from './api'
import {
  ACTION_LABELS,
  ACTION_ORDER,
  CHANNEL_OPTIONS,
  TEXT_OP_ORDER,
  blankAction,
  blankCondition,
  describeRule,
  newConditionId,
  type Named,
} from './rules-ui'
import { FIELD_LABELS, OP_LABELS } from '@/modules/unified-inbox/lib/rules'
import { CheckField, FormActions, GROUP_LABEL, MUTED } from './ui'

// ---------------------------------------------------------------------------
// Writing one rule.
//
// Laid out as the sentence it is - When, If, Then - with the whole rule read
// back in plain English at the top as it is built, and what it would have done
// to the last fortnight's post shown underneath, updating as you type. The
// idea is that nobody should have to save a rule to find out what it does.
// ---------------------------------------------------------------------------

type PreviewMatch = {
  messageId: string
  threadId: string
  subject: string | null
  from: string | null
  outcome: string
  wouldAct: boolean
}

type Preview =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'error'; text: string }
  | { state: 'done'; scanned: number; matched: number; matches: PreviewMatch[] }

const STEP: CSSProperties = {
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--color-surface)',
  padding: '1rem',
  marginBottom: '0.75rem',
}

const STEP_LABEL: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: '3.25rem',
  padding: '0.125rem 0.5rem',
  borderRadius: '999px',
  background: 'var(--color-primary-subtle)',
  color: 'var(--color-text)',
  fontSize: 'var(--text-xs)',
  fontWeight: 'var(--font-semibold)',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
}

const ROW: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 11rem), 1fr)) auto',
  gap: '0.5rem',
  alignItems: 'start',
  marginBottom: '0.5rem',
}

const SENTENCE: CSSProperties = {
  borderLeft: '3px solid var(--color-primary)',
  background: 'var(--color-bg)',
  padding: '0.75rem 1rem',
  borderRadius: 'var(--radius)',
  color: 'var(--color-text)',
  fontSize: 'var(--text-sm)',
  lineHeight: 'var(--leading-base)',
  margin: '0 0 1.25rem',
}

function Section({ label, title, children, aside }: { label: string; title: ReactNode; children: ReactNode; aside?: ReactNode }) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} style={STEP}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', marginBottom: '0.875rem', flexWrap: 'wrap' }}>
        <span style={STEP_LABEL} aria-hidden="true">{label}</span>
        <h5 id={headingId} style={{ margin: 0, fontSize: 'var(--text-sm)', fontWeight: 'var(--font-semibold)', color: 'var(--color-text)', flex: '1 1 auto' }}>
          {title}
        </h5>
        {aside}
      </div>
      {children}
    </section>
  )
}

/** A suggestion to swap a real reference for the pattern it stands for, so
 *  somebody who types PO-00091 is offered PO-##### instead of a rule that only
 *  ever matches the one order. */
function PatternHint({ value, onUse }: { value: string; onUse: (next: string) => void }) {
  const trimmed = value.trim()
  const suggestion = patternFromExample(trimmed)
  if (!trimmed || !/\d/.test(trimmed) || suggestion === trimmed) {
    return (
      <p className="field-hint" style={{ margin: '0.25rem 0 0' }}>
        <code>#</code> is any digit, <code>@</code> any letter, <code>*</code> any run of either. <code>PO-#####</code> matches PO-00091.
      </p>
    )
  }
  return (
    <p className="field-hint" style={{ margin: '0.25rem 0 0' }}>
      That only matches {trimmed} itself.{' '}
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => onUse(suggestion)} style={{ padding: '0 0.375rem', height: 'auto' }}>
        Use <code>{suggestion}</code> for every one like it
      </button>
    </p>
  )
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      aria-label={label}
      title={label}
      onClick={onClick}
      style={{ height: 36, width: 36, padding: 0, color: 'var(--color-text-muted)' }}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
        <path d="M4 4l8 8M12 4l-8 8" />
      </svg>
    </button>
  )
}

function ConditionRow({ condition, inboxes, onChange, onRemove, index }: {
  condition: RuleCondition
  inboxes: Named[]
  onChange: (next: RuleCondition) => void
  onRemove: () => void
  index: number
}) {
  const fieldId = useId()
  const setField = (field: RuleCondition['field']) => {
    const id = condition.id
    if (field === 'inbox') onChange({ id, field, op: 'is', value: inboxes[0]?.id ?? '' })
    else if (field === 'channel') onChange({ id, field, op: 'is', value: 'email' })
    else if (field === 'attachments') onChange({ id, field, op: 'has', value: '' })
    else {
      const op = 'op' in condition && (TEXT_OP_ORDER as readonly string[]).includes(condition.op) ? condition.op : 'contains'
      // Cast because TypeScript cannot pick a union member from a field held in
      // a variable; every text field shares this one shape, which zod checks again on save.
      onChange({ id, field, op: op as (typeof TEXT_OP_ORDER)[number], value: 'value' in condition ? condition.value ?? '' : '' } as RuleCondition)
    }
  }

  let opControl: ReactNode
  let valueControl: ReactNode = null
  switch (condition.field) {
    case 'inbox':
      opControl = (
        <select aria-label={`Condition ${index + 1}: how to compare`} value={condition.op} onChange={(e) => onChange({ ...condition, op: e.target.value as 'is' | 'isNot' })}>
          <option value="is">is</option>
          <option value="isNot">is not</option>
        </select>
      )
      valueControl = (
        <select aria-label={`Condition ${index + 1}: mailbox`} value={condition.value} onChange={(e) => onChange({ ...condition, value: e.target.value })}>
          {inboxes.length === 0 && <option value="">No mailboxes yet</option>}
          {inboxes.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </select>
      )
      break
    case 'channel':
      opControl = (
        <select aria-label={`Condition ${index + 1}: how to compare`} value={condition.op} onChange={(e) => onChange({ ...condition, op: e.target.value as 'is' | 'isNot' })}>
          <option value="is">is</option>
          <option value="isNot">is not</option>
        </select>
      )
      valueControl = (
        <select aria-label={`Condition ${index + 1}: channel`} value={condition.value} onChange={(e) => onChange({ ...condition, value: e.target.value })}>
          {CHANNEL_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      )
      break
    case 'attachments':
      opControl = (
        <select aria-label={`Condition ${index + 1}: attachments`} value={condition.op} onChange={(e) => onChange({ ...condition, op: e.target.value as 'has' | 'hasNone' })}>
          <option value="has">{OP_LABELS.has}</option>
          <option value="hasNone">{OP_LABELS.hasNone}</option>
        </select>
      )
      break
    default: {
      const textCondition = condition
      const isPattern = textCondition.op === 'matches' || textCondition.op === 'notMatches'
      opControl = (
        <select
          aria-label={`Condition ${index + 1}: how to compare`}
          value={textCondition.op}
          onChange={(e) => onChange({ ...textCondition, op: e.target.value as (typeof TEXT_OP_ORDER)[number] })}
        >
          {TEXT_OP_ORDER.map((op) => <option key={op} value={op}>{OP_LABELS[op]}</option>)}
        </select>
      )
      valueControl = (
        <div>
          <input
            aria-label={`Condition ${index + 1}: value`}
            value={textCondition.value}
            placeholder={isPattern ? 'PO-#####' : textCondition.field === 'fromDomain' ? 'supplier.co.uk' : 'Type something to look for'}
            onChange={(e) => onChange({ ...textCondition, value: e.target.value })}
            spellCheck={!isPattern}
            style={isPattern ? { fontFamily: 'var(--font-mono, ui-monospace, monospace)' } : undefined}
          />
          {isPattern && <PatternHint value={textCondition.value} onUse={(next) => onChange({ ...textCondition, value: next })} />}
        </div>
      )
    }
  }

  return (
    <div className="field" style={{ marginBottom: 0 }}>
      <div style={ROW}>
        <select id={fieldId} aria-label={`Condition ${index + 1}: what to look at`} value={condition.field} onChange={(e) => setField(e.target.value as RuleCondition['field'])}>
          {(Object.keys(FIELD_LABELS) as RuleCondition['field'][]).map((f) => <option key={f} value={f}>{FIELD_LABELS[f]}</option>)}
        </select>
        {opControl}
        {valueControl ?? <span aria-hidden="true" />}
        <RemoveButton label={`Remove condition ${index + 1}`} onClick={onRemove} />
      </div>
    </div>
  )
}

function ActionCard({ action, inboxes, users, onChange, onRemove }: {
  action: RuleAction
  inboxes: Named[]
  users: Named[]
  onChange: (next: RuleAction) => void
  onRemove: () => void
}) {
  const id = useId()
  let body: ReactNode = null
  switch (action.type) {
    case 'mergeByReference':
      body = (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 13rem), 1fr))', gap: '0 1rem' }}>
            <div className="field">
              <label htmlFor={`${id}-pattern`}>The reference looks like</label>
              <input
                id={`${id}-pattern`}
                value={action.pattern}
                placeholder="PO-#####"
                spellCheck={false}
                style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}
                onChange={(e) => onChange({ ...action, pattern: e.target.value })}
              />
              <PatternHint value={action.pattern} onUse={(next) => onChange({ ...action, pattern: next })} />
            </div>
            <div className="field">
              <label htmlFor={`${id}-look`}>Look for it in</label>
              <select id={`${id}-look`} value={action.lookIn} onChange={(e) => onChange({ ...action, lookIn: e.target.value as 'subject' | 'subjectOrBody' })}>
                <option value="subject">the subject</option>
                <option value="subjectOrBody">the subject or the message text</option>
              </select>
              <p className="field-hint" style={{ margin: '0.25rem 0 0' }}>
                On both: the new message, and the earlier conversation it is matched with.
              </p>
            </div>
            <div className="field">
              <label htmlFor={`${id}-days`}>Only conversations active in the last</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input
                  id={`${id}-days`}
                  type="number"
                  min={1}
                  max={365}
                  value={action.withinDays}
                  onChange={(e) => onChange({ ...action, withinDays: Math.max(1, Math.min(365, Number(e.target.value) || 1)) })}
                  style={{ maxWidth: '6rem' }}
                />
                <span style={MUTED}>days</span>
              </div>
            </div>
          </div>
          <CheckField
            label="Only with a conversation the same company is on"
            checked={action.sameCompany}
            onChange={(next) => onChange({ ...action, sameCompany: next })}
            hint="Matches the sender’s domain - faye@supplier.co.uk goes with a conversation you had with sales@supplier.co.uk. For a gmail-style address, it has to be the same person. Leave this on unless two companies can never share a reference."
          />
          <p className="field-hint" style={{ margin: 0 }}>
            The newer conversation folds into the older one, which keeps its subject. Anybody who can read either mailbox can then read the whole thing, and it can be put back from the conversation if it was wrong.
          </p>
        </>
      )
      break
    case 'assign':
      body = (
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor={`${id}-user`}>Colleague</label>
          <select id={`${id}-user`} value={action.userId} onChange={(e) => onChange({ ...action, userId: e.target.value })}>
            <option value="">Pick somebody…</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </div>
      )
      break
    case 'move':
      body = (
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor={`${id}-inbox`}>Mailbox</label>
          <select id={`${id}-inbox`} value={action.inboxId} onChange={(e) => onChange({ ...action, inboxId: e.target.value })}>
            <option value="">Pick a mailbox…</option>
            {inboxes.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        </div>
      )
      break
    case 'snooze':
      body = (
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor={`${id}-snooze`}>For</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input
              id={`${id}-snooze`}
              type="number"
              min={1}
              max={90}
              value={action.days}
              onChange={(e) => onChange({ ...action, days: Math.max(1, Math.min(90, Number(e.target.value) || 1)) })}
              style={{ maxWidth: '6rem' }}
            />
            <span style={MUTED}>{action.days === 1 ? 'day' : 'days'}</span>
          </div>
        </div>
      )
      break
    default:
      body = null
  }

  return (
    <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius)', padding: '0.75rem 0.875rem', marginBottom: '0.625rem', background: 'var(--color-bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', marginBottom: body ? '0.75rem' : 0 }}>
        <strong style={{ fontSize: 'var(--text-sm)' }}>{ACTION_LABELS[action.type]}</strong>
        <RemoveButton label={`Remove “${ACTION_LABELS[action.type]}”`} onClick={onRemove} />
      </div>
      {body}
    </div>
  )
}

const PREVIEW_DAYS = [7, 14, 30, 90] as const

export function RuleEditor({ initial, ruleId, inboxes, users, onSaved, onCancel }: {
  initial: RuleBody
  ruleId: string | null
  inboxes: Named[]
  users: Named[]
  onSaved: (message: string, savedId: string, isNew: boolean) => void
  onCancel: () => void
}) {
  const [rule, setRule] = useState<RuleBody>(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previewDays, setPreviewDays] = useState<(typeof PREVIEW_DAYS)[number]>(14)
  const [preview, setPreview] = useState<Preview>({ state: 'idle' })
  const nameId = useId()
  const addStepId = useId()
  const previewSeq = useRef(0)

  const parsed = useMemo(() => RuleBody.safeParse(rule), [rule])
  const problem = parsed.success ? ruleProblem(parsed.data) : null
  const sentence = describeRule(rule, inboxes, users)
  const unusedActions = ACTION_ORDER.filter((t) => !rule.actions.some((a) => a.type === t))

  // The preview follows the rule as it is typed, a moment after the typing
  // stops, and only once the rule is whole enough to mean something.
  const previewKey = parsed.success && !problem ? JSON.stringify({ r: parsed.data, d: previewDays }) : null
  useEffect(() => {
    if (!previewKey) return
    const seq = ++previewSeq.current
    const timer = window.setTimeout(async () => {
      setPreview({ state: 'loading' })
      try {
        const res = await fetch(`${API}/rules/preview`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify((({ r, d }: { r: unknown; d: number }) => ({ rule: r, days: d }))(JSON.parse(previewKey))),
        })
        const body = await res.json().catch(() => ({}))
        if (seq !== previewSeq.current) return
        if (!res.ok) {
          setPreview({ state: 'error', text: (body as { error?: string }).error ?? 'Could not try that rule.' })
          return
        }
        setPreview({ state: 'done', ...(body as { scanned: number; matched: number; matches: PreviewMatch[] }) })
      } catch {
        if (seq === previewSeq.current) setPreview({ state: 'error', text: OFFLINE })
      }
    }, 700)
    return () => window.clearTimeout(timer)
  }, [previewKey])

  const update = (patch: Partial<RuleBody>) => setRule((current) => ({ ...current, ...patch }))
  const setCondition = (index: number, next: RuleCondition) =>
    update({ conditions: rule.conditions.map((c, i) => (i === index ? next : c)) })
  const setAction = (index: number, next: RuleAction) =>
    update({ actions: rule.actions.map((a, i) => (i === index ? next : a)) })

  function addAction(type: RuleActionType) {
    const action = blankAction(type)
    // A merge is told the reference the conditions already look for, so the
    // common case is one pattern typed once.
    if (action.type === 'mergeByReference') {
      const fromCondition = rule.conditions.find((c) => 'op' in c && c.op === 'matches')
      if (fromCondition && 'value' in fromCondition && fromCondition.value) action.pattern = fromCondition.value
    }
    update({
      actions: [...rule.actions, action],
      // Merging only applies to mail that starts a conversation; say so in the
      // When rather than refusing the save.
      ...(type === 'mergeByReference' ? { trigger: 'newConversation' as const } : {}),
    })
  }

  async function save() {
    if (!parsed.success) {
      setError(rule.name.trim() ? 'Something in the rule is not filled in yet - every condition needs a value, and every step its details.' : 'Give the rule a name, so you can tell it apart from the others.')
      return
    }
    if (problem) { setError(problem); return }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(ruleId ? `${API}/rules/${ruleId}` : `${API}/rules`, {
        method: ruleId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.data),
      })
      const body = await res.json().catch(() => ({})) as { error?: string; rule?: { id: string } }
      if (!res.ok || !body.rule) {
        setError(body.error ?? 'That did not save.')
        return
      }
      onSaved(ruleId ? 'Rule saved.' : 'Rule added. It runs on everything that arrives from now on.', body.rule.id, !ruleId)
    } catch {
      setError(OFFLINE)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <FormActions>
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={saving}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : ruleId ? 'Save rule' : 'Add rule'}
        </button>
      </FormActions>

      <div className="field" style={{ maxWidth: '32rem' }}>
        <label htmlFor={nameId}>Name</label>
        <input
          id={nameId}
          value={rule.name}
          placeholder="Supplier replies join their purchase order"
          onChange={(e) => update({ name: e.target.value })}
          maxLength={120}
        />
      </div>

      <p style={SENTENCE} aria-live="polite">
        <span style={{ ...MUTED, display: 'block', fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.25rem' }}>
          In plain English
        </span>
        {sentence}
      </p>

      {error && <div className="alert alert-danger" role="alert" style={{ marginBottom: '1rem' }}>{error}</div>}

      <Section label="When" title="Which messages this rule looks at">
        <div role="radiogroup" aria-label="Which messages this rule looks at" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
          {([
            ['newConversation', 'A message starts a new conversation', 'The first message of each conversation. Replies are left alone.'],
            ['everyMessage', 'Any message arrives', 'Every message, replies included.'],
          ] as const).map(([value, label, hint]) => {
            const on = rule.trigger === value
            const disabled = value === 'everyMessage' && rule.actions.some((a) => a.type === 'mergeByReference')
            return (
              <label
                key={value}
                style={{
                  flex: '1 1 15rem',
                  display: 'flex',
                  gap: '0.625rem',
                  alignItems: 'flex-start',
                  padding: '0.75rem',
                  border: `1px solid ${on ? 'var(--color-primary)' : 'var(--color-border)'}`,
                  background: on ? 'var(--color-primary-subtle)' : 'var(--color-bg)',
                  borderRadius: 'var(--radius)',
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  opacity: disabled ? 0.6 : 1,
                }}
              >
                <input
                  type="radio"
                  name={`${nameId}-trigger`}
                  checked={on}
                  disabled={disabled}
                  onChange={() => update({ trigger: value })}
                  style={{ marginTop: '0.2rem' }}
                />
                <span>
                  <span style={{ display: 'block', fontWeight: 'var(--font-medium)', fontSize: 'var(--text-sm)' }}>{label}</span>
                  <span className="field-hint">{disabled ? 'Merging only works on mail that starts a conversation.' : hint}</span>
                </span>
              </label>
            )
          })}
        </div>
      </Section>

      <Section
        label="If"
        title={rule.conditions.length === 0 ? 'Every one of them - no conditions' : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.375rem', flexWrap: 'wrap' }}>
            <span>Only when</span>
            <span className="field" style={{ margin: 0, display: 'inline-flex' }}>
              <select
                aria-label="Whether every condition must hold, or just one"
                value={rule.match}
                onChange={(e) => update({ match: e.target.value as 'all' | 'any' })}
                style={{ height: 30, width: 'auto', paddingRight: '1.75rem' }}
              >
                <option value="all">all</option>
                <option value="any">any</option>
              </select>
            </span>
            <span>of these are true</span>
          </span>
        )}
      >
        {rule.conditions.map((condition, index) => (
          <ConditionRow
            key={condition.id}
            condition={condition}
            index={index}
            inboxes={inboxes}
            onChange={(next) => setCondition(index, next)}
            onRemove={() => update({ conditions: rule.conditions.filter((_, i) => i !== index) })}
          />
        ))}
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => update({ conditions: [...rule.conditions, { ...blankCondition(), id: newConditionId() }] })}
          disabled={rule.conditions.length >= MAX_CONDITIONS}
          style={{ marginTop: '0.25rem' }}
        >
          + Add condition
        </button>
      </Section>

      <Section label="Then" title="What to do with it">
        {rule.actions.length === 0 && (
          <p className="field-hint" style={{ margin: '0 0 0.75rem' }}>No steps yet. Add at least one.</p>
        )}
        {rule.actions.map((action, index) => (
          <ActionCard
            key={action.type}
            action={action}
            inboxes={inboxes}
            users={users}
            onChange={(next) => setAction(index, next)}
            onRemove={() => update({ actions: rule.actions.filter((_, i) => i !== index) })}
          />
        ))}
        {unusedActions.length > 0 && rule.actions.length < MAX_ACTIONS && (
          <div className="field" style={{ marginBottom: 0, maxWidth: '18rem' }}>
            <label htmlFor={addStepId} style={GROUP_LABEL}>Add a step</label>
            <select
              id={addStepId}
              value=""
              onChange={(e) => { if (e.target.value) addAction(e.target.value as RuleActionType) }}
            >
              <option value="">Choose…</option>
              {unusedActions.map((type) => <option key={type} value={type}>{ACTION_LABELS[type]}</option>)}
            </select>
          </div>
        )}
      </Section>

      <div style={{ ...STEP, background: 'var(--color-bg-subtle)' }}>
        <CheckField
          label="Switched on"
          checked={rule.enabled}
          onChange={(next) => update({ enabled: next })}
          hint="A rule that is switched off is kept but does nothing, which is handy while you are still deciding."
        />
        <CheckField
          label="Stop here - skip the rules below this one"
          checked={rule.stopProcessing}
          onChange={(next) => update({ stopProcessing: next })}
          hint="Once this rule has done something to a message, the rules further down the list leave that message alone."
        />
      </div>

      <section aria-label="Try it out" style={{ ...STEP, marginTop: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
          <h5 style={{ margin: 0, fontSize: 'var(--text-sm)', fontWeight: 'var(--font-semibold)' }}>
            What it would have done
          </h5>
          <span className="field" style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: '0.375rem', flexDirection: 'row' }}>
            <span style={{ ...MUTED, fontSize: 'var(--text-sm)' }}>Over the last</span>
            <select
              aria-label="How far back to try it"
              value={previewDays}
              onChange={(e) => setPreviewDays(Number(e.target.value) as (typeof PREVIEW_DAYS)[number])}
              style={{ height: 30, width: 'auto', paddingRight: '1.75rem' }}
            >
              {PREVIEW_DAYS.map((d) => <option key={d} value={d}>{d} days</option>)}
            </select>
          </span>
        </div>
        <PreviewBody preview={previewKey ? preview : { state: 'idle' }} days={previewDays} />
        <p className="field-hint" style={{ margin: '0.75rem 0 0' }}>
          Nothing is changed by looking. Saving the rule puts it to work on mail as it arrives; to tidy up what is already here, use “Run on recent mail” once it is saved.
        </p>
      </section>
    </div>
  )
}

function PreviewBody({ preview, days }: { preview: Preview; days: number }) {
  if (preview.state === 'idle') {
    return <p style={{ ...MUTED, fontSize: 'var(--text-sm)', margin: 0 }}>Finish filling the rule in and a preview appears here.</p>
  }
  if (preview.state === 'loading') {
    return <p style={{ ...MUTED, fontSize: 'var(--text-sm)', margin: 0 }} aria-live="polite">Looking through the last {days} days…</p>
  }
  if (preview.state === 'error') {
    return <p style={{ color: 'var(--color-danger)', fontSize: 'var(--text-sm)', margin: 0 }} role="alert">{preview.text}</p>
  }
  if (preview.matched === 0) {
    return (
      <p style={{ ...MUTED, fontSize: 'var(--text-sm)', margin: 0 }} aria-live="polite">
        None of the {preview.scanned} messages from the last {days} days match. Either nothing like it has arrived lately, or a condition is stricter than you meant.
      </p>
    )
  }
  const acting = preview.matches.filter((m) => m.wouldAct).length
  return (
    <div aria-live="polite">
      <p style={{ fontSize: 'var(--text-sm)', margin: '0 0 0.625rem' }}>
        <strong>{preview.matched}</strong> of {preview.scanned} recent messages match
        {preview.matched > preview.matches.length ? ` - the newest ${preview.matches.length} are below` : ''}.
        {acting < preview.matches.length && ` ${preview.matches.length - acting} of those would be left as they are.`}
      </p>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.375rem' }}>
        {preview.matches.map((m) => (
          <li
            key={m.messageId}
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) auto',
              gap: '0.25rem 0.75rem',
              alignItems: 'center',
              padding: '0.5rem 0.75rem',
              borderRadius: 'var(--radius)',
              border: '1px solid var(--color-border)',
              background: 'var(--color-bg)',
            }}
          >
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 'var(--text-sm)', fontWeight: 'var(--font-medium)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {m.subject || '(no subject)'}
              </span>
              <span className="field-hint" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {m.from ? `${m.from} · ` : ''}{m.outcome || 'would run its steps'}
              </span>
            </span>
            <span className={m.wouldAct ? 'badge badge-success' : 'badge badge-gray'}>{m.wouldAct ? 'Would act' : 'No change'}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

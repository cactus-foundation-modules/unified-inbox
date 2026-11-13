import { headers } from 'next/headers'
import { prisma } from '@/lib/db/prisma'
import { getSessionFromCookie } from '@/lib/auth/session'
import { getSiteTimezone } from '@/lib/config/timezone.server'
import { formatInSiteTimezone } from '@/lib/config/timezone'
import { listMemberThreads } from '@/modules/unified-inbox/lib/member-threads'
import { threadHrefFor } from '@/modules/unified-inbox/lib/notify'

// Contributed to core's members.admin-member-detail extension point: every
// email conversation with this member, newest first, each a link straight into
// the inbox. A server component, laid out as a plain `.card` so it sits in
// core's page without knowing how that page is styled.

const STATUS_BADGE = { open: 'badge-blue', snoozed: 'badge-yellow', done: 'badge-gray' } as const
const STATUS_LABEL = { open: 'Open', snoozed: 'Snoozed', done: 'Done' } as const
const muted = { fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', margin: 0 } as const

export async function unifiedInboxMemberThreadsSection({ memberId }: { memberId: string }) {
  const [user, member] = await Promise.all([
    getSessionFromCookie(),
    prisma.member.findUnique({ where: { id: memberId }, select: { email: true } }),
  ])
  if (!user || !member) return null

  const [adminPath, timezone, { threads, more }] = await Promise.all([
    headers().then((h) => h.get('x-cactus-admin-path') ?? ''),
    getSiteTimezone(),
    listMemberThreads(user, member.email),
  ])
  const inboxBase = `/${adminPath}/inbox`
  const when = (date: Date) => formatInSiteTimezone(date, timezone, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

  return (
    <section className="card" aria-labelledby="uin-member-threads-title">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 'var(--space-3)', marginBottom: 'var(--space-3)', flexWrap: 'wrap' }}>
        <div>
          <h2 id="uin-member-threads-title" className="card-title" style={{ margin: 0 }}>Emails</h2>
          <p style={muted}>
            {threads.length === 0
              ? `No email conversations with ${member.email} that you can open.`
              : `${threads.length}${more ? '+' : ''} ${threads.length === 1 ? 'conversation' : 'conversations'} with ${member.email}, newest first.`}
          </p>
        </div>
      </div>

      {threads.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {threads.map((t, i) => (
            <li key={t.id} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--color-border)' }}>
              <a
                href={threadHrefFor(inboxBase, t.id, t.inboxId)}
                style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-start', justifyContent: 'space-between', padding: 'var(--space-3) 0', textDecoration: 'none', color: 'inherit' }}
              >
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                    {t.unread && <span aria-label="Unread" title="Unread" style={{ flexShrink: 0, width: 8, height: 8, borderRadius: '50%', background: 'var(--color-primary)' }} />}
                    <span style={{ fontWeight: t.unread ? 'var(--font-semibold)' : 'var(--font-medium)', color: 'var(--color-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {t.subject?.trim() || '(no subject)'}
                    </span>
                  </span>
                  {t.preview && (
                    <span style={{ ...muted, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 'var(--space-1)' }}>
                      {t.lastDirection === 'out' ? 'You: ' : ''}{t.preview}
                    </span>
                  )}
                  <span style={{ ...muted, display: 'block', marginTop: 'var(--space-1)', fontSize: 'var(--text-xs)' }}>
                    {[t.inboxName, `${t.messageCount} ${t.messageCount === 1 ? 'message' : 'messages'}`, t.lastMessageAt ? when(t.lastMessageAt) : null].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className={`badge ${STATUS_BADGE[t.status] ?? 'badge-gray'}`} style={{ flexShrink: 0 }}>{STATUS_LABEL[t.status] ?? t.status}</span>
              </a>
            </li>
          ))}
        </ul>
      )}

      {more && (
        <p style={{ ...muted, marginTop: 'var(--space-3)' }}>
          Showing the newest {threads.length}. <a href={`${inboxBase}?tab=unified-inbox&q=${encodeURIComponent(member.email)}`}>Search the inbox</a> for the rest.
        </p>
      )}
    </section>
  )
}

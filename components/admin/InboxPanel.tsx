import { headers } from 'next/headers'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { listInboxes } from '@/modules/unified-inbox/lib/db'
import { visibleInboxIds } from '@/modules/unified-inbox/lib/access'

// The hub's tab in core's Inbox page. At this version it is a standing-room
// placeholder: the inboxes exist and can be configured, but nothing collects
// mail yet, so there is nothing to list. The reading and replying screen
// replaces this wholesale in a later version - the point of it being here now
// is that the tab, its permission and its place in the strip are real.

export async function UnifiedInboxPanel() {
  const user = await getSessionFromCookie()
  if (!user) return null
  if (!await hasPermission(user, 'unifiedinbox.view')) {
    return <div className="alert alert-danger">You do not have permission to view the inbox.</div>
  }

  const adminPath = (await headers()).get('x-cactus-admin-path') ?? ''
  const all = await listInboxes()
  const visible = new Set(await visibleInboxIds(user, all.map((i) => i.id)))
  const inboxes = all.filter((i) => visible.has(i.id))
  const canManage = await hasPermission(user, 'unifiedinbox.manage')

  if (inboxes.length === 0) {
    return (
      <div className="alert alert-info">
        {canManage ? (
          <>
            No inboxes yet. Add the addresses your customers and suppliers write to in{' '}
            <a href={`/${adminPath}/config?tab=unified-inbox`}>Settings &rsaquo; Unified Inbox</a>.
          </>
        ) : (
          <>No inboxes have been shared with you yet. Whoever looks after the site can put you on one.</>
        )}
      </div>
    )
  }

  return (
    <div>
      <div className="alert alert-info" style={{ marginBottom: '1.5rem' }}>
        Your inboxes are set up. Collecting and reading mail arrives in a later version of this module.
      </div>
      <div className="card">
        <div style={{
          fontSize: '0.75rem',
          color: 'var(--color-text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          marginBottom: '0.75rem',
        }}>
          Inboxes
        </div>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.5rem' }}>
          {inboxes.map((inbox) => (
            <li key={inbox.id} style={{ display: 'flex', gap: '0.75rem', alignItems: 'baseline' }}>
              <span style={{ fontWeight: 600 }}>{inbox.name}</span>
              <span style={{ color: 'var(--color-text-muted)', fontSize: '0.875rem' }}>{inbox.address}</span>
              {inbox.isCatchAll && (
                <span style={{ color: 'var(--color-text-muted)', fontSize: '0.75rem' }}>catch-all</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

import { prisma } from '@/lib/db/prisma'
import type { ContextAdapter, ContextItem, ContextQuery, ContextSection } from './types'
import { detailLine, humanStatus, shortDate, toDate } from './format'
import { getSiteTimezone } from '@/lib/config/timezone.server'

// The member account behind the address, if the person has one.
//
// Members are core's rather than a module's, so there is nothing to check for
// installation - the table is there on every site. The permission check still
// applies: a member's status and the date they joined are theirs, and somebody
// who may answer email is not automatically somebody who may read the member
// list.

export const membersAdapter: ContextAdapter = {
  moduleName: 'core',
  permission: 'members.view',
  tables: [],

  async load(query: ContextQuery): Promise<ContextSection | null> {
    const tz = await getSiteTimezone()
    if (query.emails.length === 0) return null

    const rows = await prisma.member.findMany({
      where: { email: { in: query.emails, mode: 'insensitive' } },
      select: {
        id: true,
        email: true,
        username: true,
        fullName: true,
        displayName: true,
        organisation: true,
        status: true,
        createdAt: true,
      },
      take: 3,
    })
    if (rows.length === 0) return null

    const items: ContextItem[] = rows.map((m) => ({
      id: m.id,
      title: m.fullName || m.displayName || m.username,
      detail: detailLine(m.organisation, `joined ${shortDate(m.createdAt, tz)}`),
      status: humanStatus(m.status),
      at: toDate(m.createdAt),
      href: `members/${m.id}`,
    }))

    return {
      moduleName: 'core',
      label: 'Their account',
      items,
      total: items.length,
      moreHref: null,
    }
  },
}

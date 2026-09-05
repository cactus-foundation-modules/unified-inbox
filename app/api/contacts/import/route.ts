import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { importContacts } from '@/modules/unified-inbox/lib/contact-store'
import { isContactField, MAX_IMPORT_ROWS, type ColumnTarget } from '@/modules/unified-inbox/lib/contacts'
import { ContactImportBody } from '@/modules/unified-inbox/lib/validation'

// Bringing an address book in from somewhere else.
//
// The file itself never leaves the browser. It is read and parsed there so the
// mapping step has a header row and a few rows to show, and what is posted here
// is the rows and the decision somebody made about each column - which means
// the server applies exactly what was on screen when they pressed the button,
// rather than re-reading a file and hoping it reads it the same way.
//
// It takes `manage` rather than `reply`. Correcting one contact is the same
// class of act as answering them; adding two thousand in one press is not, and
// an import run against the wrong column mapping is the single easiest way to
// make a mess of an address book.
export const maxDuration = 300

export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const parsed = ContactImportBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That file could not be read.')

  const { columns, rows, updateExisting, categoryName } = parsed.data
  if (rows.length === 0) return errorResponse('There were no rows in that file.')
  if (rows.length > MAX_IMPORT_ROWS) {
    return errorResponse(`That is more than ${MAX_IMPORT_ROWS} rows. Split the file and bring it in in two goes.`)
  }

  // Anything that is not a field this address book has becomes "leave it out",
  // rather than being trusted because it arrived in the request.
  const map: ColumnTarget[] = columns.map((column) =>
    column === 'fullName' || isContactField(column) ? column : '')

  if (map.every((target) => target === '')) {
    return errorResponse('None of the columns were matched to anything, so there was nothing to bring in.')
  }

  const summary = await importContacts(rows, map, { updateExisting, categoryName })
  return NextResponse.json({ ok: true, summary })
}

import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { importContacts } from '@/modules/unified-inbox/lib/contact-store'
import {
  describeImportFault, isContactField, MAX_IMPORT_ROWS, type ColumnTarget,
} from '@/modules/unified-inbox/lib/contacts'
import { ContactImportBody } from '@/modules/unified-inbox/lib/validation'

// Bringing an address book in from somewhere else.
//
// The file itself never leaves the browser. It is read and parsed there so the
// mapping step has a header row and a few rows to show, and what is posted here
// is the rows and the decision somebody made about each column - which means
// the server applies exactly what was on screen when they pressed the button,
// rather than re-reading a file and hoping it reads it the same way.
//
// ONE CHUNK PER REQUEST. It used to be the whole file in one body, which is
// what made a big import fail: a few thousand contacts is megabytes of JSON,
// the platform refuses a body past its own ceiling before any of this code
// runs, and what came back was a parse failure reported as "That file could not
// be read" - a sentence about the file, which was fine, describing a problem
// with the request, which nobody could see. The screen now sends a few hundred
// rows at a time and adds the answers up.
//
// AND WHEN SOMETHING IS STILL REFUSED, IT SAYS WHAT. A schema with a dozen
// bounds on it answering every one of them with the same sentence is a bug
// report nobody can act on, including us.
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

  // Told apart from a body that arrived and did not fit the shape. A body that
  // never arrived at all is almost always one the host refused for being too
  // big, and "check your file" is the wrong place to send somebody for that.
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return errorResponse(
      'That did not reach the site in one piece - usually because too much was sent at once. '
      + 'Try again; if it keeps happening, split the file in two.',
      413,
    )
  }

  const parsed = ContactImportBody.safeParse(body)
  if (!parsed.success) {
    // The offset is read off the raw body rather than the parsed one, which
    // does not exist yet - so a bad cell in the ninth chunk is still named by
    // the line the spreadsheet shows.
    const offset = typeof (body as { rowOffset?: unknown })?.rowOffset === 'number'
      ? (body as { rowOffset: number }).rowOffset
      : 0
    return errorResponse(describeImportFault(parsed.error.issues, offset))
  }

  const { columns, rows, rowOffset, updateExisting, categoryName } = parsed.data
  if (rows.length === 0) return errorResponse('There were no rows in that file.')
  if (rowOffset + rows.length > MAX_IMPORT_ROWS) {
    return errorResponse(`That is more than ${MAX_IMPORT_ROWS.toLocaleString('en-GB')} rows. Split the file and bring it in in two goes.`)
  }

  // Anything that is not a field this address book has becomes "leave it out",
  // rather than being trusted because it arrived in the request.
  const map: ColumnTarget[] = columns.map((column) =>
    column === 'fullName' || isContactField(column) ? column : '')

  if (map.every((target) => target === '')) {
    return errorResponse('None of the columns were matched to anything, so there was nothing to bring in.')
  }

  const summary = await importContacts(rows, map, { updateExisting, categoryName, rowOffset })
  return NextResponse.json({ ok: true, summary })
}

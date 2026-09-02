import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getActiveMediaProvider, isMediaProviderConfigured } from '@/lib/config/env'
import { uploadMedia } from '@/lib/media/upload'
import { outboundUploadKey } from '@/modules/unified-inbox/lib/attachments'
import { recordOutboundUpload } from '@/modules/unified-inbox/lib/db'
import {
  MAX_DROPPED_FILES,
  clampFilename,
  refuseDroppedFile,
  typeForUpload,
} from '@/modules/unified-inbox/lib/uploads'

// A file dragged onto a message being written.
//
// The one place in this module that takes bytes from a browser, and it does not
// send them anywhere: it puts them in storage and hands back a reference of
// exactly the shape the send route already accepts. Sending remains what it
// was - an attachment described by where it lives, never by bytes in a send
// request - so nothing about the send path had to be loosened to make dropping
// a file work.
//
// The permission is the right to reply, not the right to upload media. What is
// being done here is writing an email; the file goes under this module's own
// prefix with no library row, so nobody is being handed the media library by a
// side door, and the reverse is true as well - somebody who may answer the post
// should not need media permission to attach the quote they are answering with.
//
// Access to a particular inbox is deliberately NOT checked. Nothing about these
// bytes is addressed yet: which inbox it leaves from is chosen at Send, and it
// is Send that refuses an inbox this person may not write as (D16). Checking it
// here would mean asking about an inbox the composer has not settled on.
export const maxDuration = 60

export async function POST(request: Request) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.reply')) return errorResponse('Forbidden', 403)

  const provider = await getActiveMediaProvider()
  if (!provider || !isMediaProviderConfigured(provider)) {
    return errorResponse(
      'This site has no file storage set up, so files cannot be attached yet.',
      503,
    )
  }

  // A body that is not a form at all, or one the platform truncated, throws
  // here rather than arriving as an empty list - which would otherwise read as
  // "nothing was dropped" and send somebody looking in the wrong place.
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return errorResponse('That file could not be read. Try dropping it again.', 400)
  }

  const files = form.getAll('file').filter((entry): entry is File => entry instanceof File)
  if (files.length === 0) return errorResponse('No file was sent.', 400)
  if (files.length > MAX_DROPPED_FILES) {
    return errorResponse(`That is more than ${MAX_DROPPED_FILES} files at once.`, 400)
  }

  // Every file is checked before any of them is written, so a refusal leaves
  // nothing behind in storage to tidy up. The browser has already asked the
  // same questions and said the same sentences; this is the half that decides.
  for (const file of files) {
    const refusal = refuseDroppedFile({ name: file.name, type: file.type, size: file.size })
    if (refusal) return errorResponse(refusal, 400)
  }

  const attachments = []
  for (const file of files) {
    const filename = clampFilename(file.name)
    const contentType = typeForUpload(file.name, file.type)
    // The id goes in the key, so the key is unguessable - see outboundUploadKey.
    const key = outboundUploadKey(provider, randomUUID(), filename)
    try {
      const buffer = Buffer.from(await file.arrayBuffer())
      const result = await uploadMedia(buffer, contentType, provider, filename, undefined, false, key)
      await recordOutboundUpload({
        authorUserId: user.id,
        mediaKey: result.key,
        mediaUrl: result.url,
        mediaProvider: provider,
        filename,
        contentType: result.mimeType ?? contentType,
        sizeBytes: result.sizeBytes,
      })
      attachments.push({
        key: result.key,
        url: result.url,
        filename,
        contentType: result.mimeType ?? contentType,
        sizeBytes: result.sizeBytes,
      })
    } catch (err) {
      console.error('[unified-inbox] a dropped file could not be stored', err)
      return errorResponse(
        `"${filename}" could not be saved, so it has not been attached. Try again in a moment.`,
        502,
      )
    }
  }

  return NextResponse.json({ attachments })
}

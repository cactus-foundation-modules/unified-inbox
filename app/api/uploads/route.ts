import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getActiveMediaProvider, isMediaProviderConfigured } from '@/lib/config/env'
import { headMediaSize, isS3Provider, mediaKeyPrefix, uploadMedia } from '@/lib/media/upload'
import { workerUrl } from '@/lib/media/worker-url'
import { signUploadToken, verifyUploadToken } from '@/lib/media/upload-token'
import { ATTACHMENT_FOLDER, outboundUploadKey, safeFilename } from '@/modules/unified-inbox/lib/attachments'
import { recordOutboundUpload } from '@/modules/unified-inbox/lib/db'
import {
  DIRECT_UPLOAD_EXTENSION,
  MAX_DROPPED_FILES,
  MAX_SERVER_UPLOAD_BYTES,
  clampFilename,
  describeBytes,
  refuseDroppedFile,
  typeForUpload,
} from '@/modules/unified-inbox/lib/uploads'

// A file dragged onto a message being written.
//
// Small files still come through this route as a form. Larger ones first ask
// for a signed destination, PUT their bytes straight into storage, then come
// back here with the signed key so the staging row can be written. The latter
// bypasses the hosting platform's 4MB request ceiling without broadening media
// library permissions or putting file bytes in the eventual send request.
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

const DIRECT_CONTENT_TYPE = 'application/octet-stream'

type DirectUploadBody = {
  action?: unknown
  filename?: unknown
  type?: unknown
  sizeBytes?: unknown
  key?: unknown
  token?: unknown
}

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

  if (request.headers.get('content-type')?.startsWith('application/json')) {
    const body = await request.json().catch(() => null) as DirectUploadBody | null
    const action = body?.action
    const filename = typeof body?.filename === 'string' ? clampFilename(body.filename) : ''
    const declaredType = typeof body?.type === 'string' ? body.type : ''
    const sizeBytes = typeof body?.sizeBytes === 'number' ? body.sizeBytes : NaN

    if (!filename || !Number.isFinite(sizeBytes)) return errorResponse('That file could not be read.', 400)
    const refusal = refuseDroppedFile({ name: filename, type: declaredType, size: sizeBytes })
    if (refusal) return errorResponse(refusal, 400)

    const base = workerUrl()
    if (action === 'prepare') {
      if (!base || !isS3Provider(provider)) {
        return NextResponse.json({ available: false, maxSizeBytes: MAX_SERVER_UPLOAD_BYTES })
      }
      const key = `${outboundUploadKey(provider, randomUUID(), filename)}.${DIRECT_UPLOAD_EXTENSION}`
      const { token } = signUploadToken(key)
      return NextResponse.json({
        available: true,
        uploadUrl: `${base}/${key}`,
        key,
        token,
        contentType: DIRECT_CONTENT_TYPE,
      })
    }

    if (action === 'record') {
      const key = typeof body?.key === 'string' ? body.key : ''
      const token = typeof body?.token === 'string' ? body.token : ''
      const expectedPrefix = `${mediaKeyPrefix(provider)}${ATTACHMENT_FOLDER}/outbound/`
      const expectedSuffix = `-${safeFilename(filename)}.${DIRECT_UPLOAD_EXTENSION}`
      if (!base || !isS3Provider(provider) || !key.startsWith(expectedPrefix) || !key.endsWith(expectedSuffix)) {
        return errorResponse('That upload does not belong to this message.', 400)
      }
      if (!token || !verifyUploadToken(key, token)) return errorResponse('That upload has expired. Try attaching the file again.', 403)

      // The browser never gets the final word on size. The object store does.
      const storedSize = await headMediaSize(provider, key)
      if (storedSize === null) {
        return errorResponse(`"${filename}" reached storage, but its size could not be checked. Try attaching it again.`, 502)
      }
      const storedRefusal = refuseDroppedFile({ name: filename, type: declaredType, size: storedSize })
      if (storedRefusal) return errorResponse(storedRefusal, 400)

      const contentType = typeForUpload(filename, null)
      const url = `${base}/${key}`
      await recordOutboundUpload({
        authorUserId: user.id,
        mediaKey: key,
        mediaUrl: url,
        mediaProvider: provider,
        filename,
        contentType,
        sizeBytes: storedSize,
      })
      return NextResponse.json({
        attachments: [{ key, url, filename, contentType, sizeBytes: storedSize }],
      })
    }

    return errorResponse('That upload request was not recognised.', 400)
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
    if (file.size > MAX_SERVER_UPLOAD_BYTES) {
      return errorResponse(
        `"${file.name}" is ${describeBytes(file.size)}. This site's file storage can only take files up to ${describeBytes(MAX_SERVER_UPLOAD_BYTES)} through this page.`,
        413,
      )
    }
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

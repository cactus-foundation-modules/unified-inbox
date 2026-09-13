import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_SERVER_UPLOAD_BYTES } from '@/modules/unified-inbox/lib/uploads'
import { uploadAttachmentFile } from './useAttachmentDrop'

const attachment = {
  key: 'media/unified-inbox/outbound/id-quote.pdf.bin',
  url: 'https://media.example.test/media/unified-inbox/outbound/id-quote.pdf.bin',
  filename: 'quote.pdf',
  contentType: 'application/pdf',
  sizeBytes: MAX_SERVER_UPLOAD_BYTES + 1,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('uploadAttachmentFile', () => {
  it('keeps a file within the host limit on the ordinary one-request path', async () => {
    const file = new File(['quote'], 'quote.pdf', { type: 'application/pdf' })
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ attachments: [{ ...attachment, sizeBytes: file.size }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(uploadAttachmentFile(file, new AbortController().signal)).resolves.toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/m/unified-inbox/uploads')
    expect(fetchMock.mock.calls[0]![1]?.body).toBeInstanceOf(FormData)
  })

  it('puts a file over 4MB straight into storage, then records its signed key', async () => {
    const file = new File(
      [new Uint8Array(MAX_SERVER_UPLOAD_BYTES + 1)],
      'quote.pdf',
      { type: 'application/pdf' },
    )
    const ticket = {
      available: true,
      uploadUrl: attachment.url,
      key: attachment.key,
      token: 'signed-upload',
      contentType: 'application/octet-stream',
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(ticket), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ attachments: [attachment] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(uploadAttachmentFile(file, new AbortController().signal)).resolves.toEqual([attachment])
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[1]![0]).toBe(attachment.url)
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ method: 'PUT', body: file })
    expect(JSON.parse(String(fetchMock.mock.calls[2]![1]?.body))).toMatchObject({
      action: 'record',
      key: attachment.key,
      token: 'signed-upload',
      sizeBytes: file.size,
    })
  })

  it('explains the smaller fallback when this storage provider cannot upload directly', async () => {
    const file = new File(
      [new Uint8Array(MAX_SERVER_UPLOAD_BYTES + 1)],
      'quote.pdf',
      { type: 'application/pdf' },
    )
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ available: false, maxSizeBytes: MAX_SERVER_UPLOAD_BYTES }), { status: 200 }),
    ))

    await expect(uploadAttachmentFile(file, new AbortController().signal)).rejects.toThrow('4.0MB')
  })
})

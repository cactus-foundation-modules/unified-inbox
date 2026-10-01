import { describe, it, expect } from 'vitest'
import {
  MAX_EAGER_BYTES_PER_MESSAGE,
  STORABLE_TYPES,
  sniffStorableType,
  storableAs,
  storableTypesFrom,
  worthFetching,
} from './inbound-file-policy'

// What the site will put in its own media library, unasked, off a stranger's
// email. Every rule here is about not hosting something it should not.

const bytes = (text: string) => new Uint8Array(Buffer.from(text, 'latin1'))
const PDF = bytes('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj')
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
const WANT_PDF = new Set(['application/pdf'])

describe('what may be asked for', () => {
  it('keeps only kinds that can be proved from their bytes', () => {
    expect(storableTypesFrom([' Application/PDF ', 'image/png', 'text/html', 'image/svg+xml',
      'application/x-msdownload', 'application/javascript', 'text/csv', 42, null])).toEqual(['application/pdf', 'image/png'])
    expect(storableTypesFrom('application/pdf')).toEqual([])
    expect(storableTypesFrom(undefined)).toEqual([])
  })

  it('never lists markup, SVG or anything executable as storable', () => {
    for (const type of ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'application/x-msdownload',
      'application/javascript', 'text/javascript', 'application/octet-stream']) {
      expect(STORABLE_TYPES.has(type), type).toBe(false)
    }
  })
})

describe('judging a file by its bytes', () => {
  it('recognises a PDF, including one with blank bytes in front', () => {
    expect(sniffStorableType(PDF)).toBe('application/pdf')
    expect(sniffStorableType(bytes(`\r\n\r\n%PDF-1.4`))).toBe('application/pdf')
  })

  it('recognises the plain picture formats', () => {
    expect(sniffStorableType(PNG)).toBe('image/png')
    expect(sniffStorableType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffStorableType(bytes('GIF89a....'))).toBe('image/gif')
    expect(sniffStorableType(bytes('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
  })

  it('recognises nothing in a web page, an SVG or a program, whatever it is called', () => {
    expect(sniffStorableType(bytes('<!doctype html><script>alert(1)</script>'))).toBeNull()
    expect(sniffStorableType(bytes('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'))).toBeNull()
    expect(sniffStorableType(bytes('MZ\x90\0\x03'))).toBeNull()
    expect(sniffStorableType(new Uint8Array())).toBeNull()
  })

  it('stores a file only as a kind that was asked for and that its bytes prove', () => {
    expect(storableAs(PDF, WANT_PDF, MAX_EAGER_BYTES_PER_MESSAGE)).toBe('application/pdf')
    // A real picture, but nobody asked for pictures.
    expect(storableAs(PNG, WANT_PDF, MAX_EAGER_BYTES_PER_MESSAGE)).toBeNull()
    // A web page carrying the PDF signature further down.
    expect(storableAs(bytes('<html><body>%PDF-1.7</body>'), WANT_PDF, MAX_EAGER_BYTES_PER_MESSAGE)).toBeNull()
  })

  it('stops at what is left of the message’s allowance', () => {
    expect(storableAs(PDF, WANT_PDF, PDF.length - 1)).toBeNull()
    expect(storableAs(PDF, WANT_PDF, PDF.length)).toBe('application/pdf')
  })
})

describe('whether to fetch at all', () => {
  it('fetches only what is labelled as a kind asked for, or labelled nothing in particular', () => {
    expect(worthFetching({ contentType: 'application/pdf; name="a.pdf"', sizeBytes: 10 }, WANT_PDF, 100)).toBe(true)
    expect(worthFetching({ contentType: 'application/octet-stream', sizeBytes: 10 }, WANT_PDF, 100)).toBe(true)
    expect(worthFetching({ contentType: 'text/html', sizeBytes: 10 }, WANT_PDF, 100)).toBe(false)
    expect(worthFetching({ contentType: null, sizeBytes: 10 }, WANT_PDF, 100)).toBe(false)
  })

  it('fetches nothing when nothing was asked for, or when it cannot fit', () => {
    expect(worthFetching({ contentType: 'application/pdf', sizeBytes: 10 }, new Set(), 100)).toBe(false)
    expect(worthFetching({ contentType: 'application/pdf', sizeBytes: 101 }, WANT_PDF, 100)).toBe(false)
  })
})

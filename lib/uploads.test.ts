import { describe, it, expect } from 'vitest'
import {
  MAX_DROPPED_BYTES,
  clampFilename,
  describeBytes,
  extensionOf,
  refuseDroppedFile,
  typeForUpload,
} from './uploads'

// The rules a dropped file is judged by, checked here because they are read
// twice - once in the browser, to refuse a file before it is uploaded, and once
// in the route, which is the half that decides. Both call these functions, so
// the two can only disagree if this file is wrong.

describe('extensionOf', () => {
  it('takes the last extension, lower case', () => {
    expect(extensionOf('Quote.PDF')).toBe('pdf')
    expect(extensionOf('archive.tar.gz')).toBe('gz')
  })

  it('has nothing to say about a name without one', () => {
    expect(extensionOf('Makefile')).toBe('')
    expect(extensionOf('.gitignore')).toBe('')
    expect(extensionOf('trailing.')).toBe('')
  })

  it('reads the name, not the path in front of it', () => {
    expect(extensionOf('C:\\Users\\marcus\\quote.pdf')).toBe('pdf')
  })
})

describe('refuseDroppedFile', () => {
  it('takes an ordinary quote', () => {
    expect(refuseDroppedFile({ name: 'quote.pdf', type: 'application/pdf', size: 200_000 })).toBeNull()
  })

  it('refuses an executable, whatever it is pretending to be', () => {
    const reason = refuseDroppedFile({ name: 'invoice.pdf.exe', type: 'application/pdf', size: 1000 })
    expect(reason).toContain('refuse to deliver')
  })

  it('refuses markup, which is a script wearing a hat', () => {
    expect(refuseDroppedFile({ name: 'page.html', type: 'text/html', size: 1000 })).not.toBeNull()
    expect(refuseDroppedFile({ name: 'logo.svg', type: 'image/svg+xml', size: 1000 })).not.toBeNull()
  })

  it('says folder rather than nought bytes', () => {
    const reason = refuseDroppedFile({ name: 'Invoices', type: '', size: 0 })
    expect(reason).toContain('folder')
  })

  it('sends anything too big for the drop round the other way', () => {
    const reason = refuseDroppedFile({
      name: 'brochure.pdf',
      type: 'application/pdf',
      size: MAX_DROPPED_BYTES + 1,
    })
    expect(reason).toContain('Attach a file')
  })
})

describe('typeForUpload', () => {
  it('believes the browser when it has an answer', () => {
    expect(typeForUpload('quote.pdf', 'application/pdf')).toBe('application/pdf')
  })

  it('fills in the everyday ones when the browser has none', () => {
    // Safari and Windows both hand back an empty string for plenty of these.
    expect(typeForUpload('terms.docx', '')).toContain('wordprocessingml')
    expect(typeForUpload('prices.csv', null)).toBe('text/csv')
  })

  it('falls back to something every mail program understands', () => {
    expect(typeForUpload('drawing.dwg', '')).toBe('application/octet-stream')
  })

  it('drops the parameters a browser sometimes tacks on', () => {
    expect(typeForUpload('notes.txt', 'text/plain; charset=utf-8')).toBe('text/plain')
  })
})

describe('clampFilename', () => {
  it('leaves an ordinary name alone', () => {
    expect(clampFilename('quote.pdf')).toBe('quote.pdf')
  })

  it('keeps the extension when it has to cut', () => {
    const clamped = clampFilename(`${'a'.repeat(400)}.pdf`)
    expect(clamped.length).toBeLessThanOrEqual(200)
    expect(clamped.endsWith('.pdf')).toBe(true)
  })

  it('keeps the name and not the path it arrived with', () => {
    expect(clampFilename('C:\\Users\\marcus\\quote.pdf')).toBe('quote.pdf')
  })
})

describe('describeBytes', () => {
  it('speaks in the units a person uses', () => {
    expect(describeBytes(512)).toBe('512 bytes')
    expect(describeBytes(2048)).toBe('2KB')
    expect(describeBytes(5 * 1024 * 1024)).toBe('5.0MB')
  })
})

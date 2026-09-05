import { describe, expect, it } from 'vitest'
import { hrefFor, splitLinks, trimTrailing } from './linkify'

// Every case here is a sentence somebody has actually written in an email, and
// each one is a way of getting this subtly wrong in front of a reader: an
// address with the full stop swallowed goes to a 404, an address with the
// bracket dropped goes to the wrong Wikipedia page, and a false positive makes
// ordinary prose look pressable.

const links = (text: string) => splitLinks(text).filter((p) => p.kind === 'link').map((p) => p.value)

describe('finding addresses in plain text', () => {
  it('finds the ordinary ones', () => {
    expect(links('See https://deskwell.co.uk for the range.')).toEqual(['https://deskwell.co.uk'])
    expect(links('http://example.com/a/b?c=d#e')).toEqual(['http://example.com/a/b?c=d#e'])
  })

  it('takes a bare www. and points it at https', () => {
    const [piece] = splitLinks('go to www.deskwell.co.uk today').filter((p) => p.kind === 'link')
    expect(piece).toMatchObject({ value: 'www.deskwell.co.uk', href: 'https://www.deskwell.co.uk' })
  })

  it('leaves the sentence its own full stop', () => {
    expect(links('Order at https://deskwell.co.uk/chairs.')).toEqual(['https://deskwell.co.uk/chairs'])
    expect(links('Two: https://a.example, https://b.example.')).toEqual(['https://a.example', 'https://b.example'])
  })

  it('keeps a bracket the address opened, and drops one it did not', () => {
    expect(links('(see https://en.wikipedia.org/wiki/Chair_(furniture))'))
      .toEqual(['https://en.wikipedia.org/wiki/Chair_(furniture)'])
    expect(links('(see https://deskwell.co.uk)')).toEqual(['https://deskwell.co.uk'])
  })

  it('does not turn prose into links', () => {
    expect(links('e.g. that one, Deskwell Ltd.co, and so on')).toEqual([])
    expect(links('Ring us on 0113 496 0123 or ask Emma.')).toEqual([])
    expect(links('files are in C:\\Users\\chris')).toEqual([])
  })

  it('keeps every character of the text, links and all', () => {
    const text = 'Before https://a.example/x middle www.b.example after.'
    expect(splitLinks(text).map((p) => p.value).join('')).toBe(text)
  })

  it('does not offer a scheme with nothing after it', () => {
    expect(links('It was https://. Honestly.')).toEqual([])
    expect(links('www.')).toEqual([])
  })

  it('holds on to a four-hundred character tracking link in one piece', () => {
    const long = `https://click.example/${'a'.repeat(400)}`
    expect(links(`Click ${long} now`)).toEqual([long])
  })
})

describe('the two pure helpers', () => {
  it('trims only what belongs to the sentence', () => {
    expect(trimTrailing('https://a.example/x?y=1')).toBe('https://a.example/x?y=1')
    expect(trimTrailing('https://a.example/x!?')).toBe('https://a.example/x')
    expect(trimTrailing('https://a.example/x(y)')).toBe('https://a.example/x(y)')
  })

  it('only guesses a scheme for a bare www.', () => {
    expect(hrefFor('www.a.example')).toBe('https://www.a.example')
    expect(hrefFor('WWW.A.example')).toBe('https://WWW.A.example')
    expect(hrefFor('http://a.example')).toBe('http://a.example')
  })
})

'use client'

import type { ProductChoice } from '@/modules/unified-inbox/lib/products/types'
import { CloseIcon } from './icons'

// The catalogue items on a message, drawn the way the person who gets the
// message will see them.
//
// They used to be chips on the button strip - a row of little grey tags saying
// "Ergo 24 Task Chair" beside the paperclip. That said which products were
// attached and nothing at all about what the message would look like, so the
// only way to find out was to send one to yourself. The block goes where it
// goes in the email instead: under the writing, above the signature, in the
// same order.
//
// Painted on white with the email's own colours rather than the admin's tokens,
// and deliberately - the same decision the message frame makes for an email
// somebody has received. This is a picture of what leaves the building; a
// preview that quietly repainted itself for dark mode would be a preview of
// something nobody is going to get. The values are the ones in
// lib/products/render.ts, which is what actually prints it, and they are copied
// rather than imported because that file is server code and this is not.
//
// Nothing here decides what the message says. The names and the prices are
// today's, and they are read again on the server when Send is pressed - so a
// price that moves between writing and sending moves in the message too.

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
const TEXT = '#333333'
const MUTED = '#666666'
const RULE = '#e5e5e5'
const THUMB = 64

/** The price as one line: 'From £419.00 + VAT'. The same sentence
 *  lib/products/render.ts prints, so what is on the screen and what arrives
 *  cannot read differently. */
export function priceLine(product: ProductChoice): string {
  if (!product.price) return ''
  const figure = product.priceFrom ? `From ${product.price}` : product.price
  return product.priceSuffix ? `${figure} ${product.priceSuffix}` : figure
}

type Props = {
  products: readonly ProductChoice[]
  /** Takes one back off the message. Keyed the same way the picker compares
   *  them, so the two cannot disagree about which one was meant. */
  onRemove: (key: string) => void
  /** Greyed out while something is in flight: a product cannot be taken off a
   *  message that is already on its way. */
  disabled?: boolean
  /** How each one is keyed - passed in rather than worked out here, so this
   *  file does not become a second opinion on what identifies a product. */
  keyOf: (item: ProductChoice) => string
}

export function ProductPreview({ products, onRemove, disabled = false, keyOf }: Props) {
  if (products.length === 0) return null
  const withImages = products.some((p) => p.imageUrl)

  return (
    <div className="uin-product-preview">
      <p className="uin-recipients uin-product-preview-said">
        On the message, under what you write:
      </p>
      <div className="uin-product-preview-sheet" style={{ fontFamily: FONT, color: TEXT }}>
        {products.map((product, index) => {
          const key = keyOf(product)
          const price = priceLine(product)
          const last = index === products.length - 1
          return (
            <div
              key={key}
              className="uin-product-preview-row"
              style={{ borderBottom: last ? 'none' : `1px solid ${RULE}` }}
            >
              {withImages && (
                product.imageUrl
                  // eslint-disable-next-line @next/next/no-img-element -- media library URLs are arbitrary remote hosts, not a configured next/image loader
                  ? <img
                    src={product.imageUrl}
                    alt=""
                    width={THUMB}
                    height={THUMB}
                    style={{
                      display: 'block',
                      width: `${THUMB}px`,
                      height: `${THUMB}px`,
                      border: `1px solid ${RULE}`,
                      borderRadius: '4px',
                      objectFit: 'cover',
                      flex: 'none',
                    }}
                  />
                  : <span
                    aria-hidden="true"
                    style={{ width: `${THUMB}px`, height: `${THUMB}px`, flex: 'none' }}
                  />
              )}
              <span className="uin-product-preview-words">
                <strong style={{ textDecoration: product.url ? 'underline' : 'none' }}>
                  {product.name}
                </strong>
                {product.options && (
                  <span style={{ color: MUTED, fontSize: '13px' }}>{product.options}</span>
                )}
              </span>
              {price && <span className="uin-product-preview-price">{price}</span>}
              <button
                type="button"
                className="uin-product-preview-off"
                aria-label={`Take ${product.name} off this message`}
                title="Take it off this message"
                disabled={disabled}
                onClick={() => onRemove(key)}
              >
                {CloseIcon}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

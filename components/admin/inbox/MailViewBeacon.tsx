'use client'

import { useEffect } from 'react'
import { openMailView } from '@/modules/unified-inbox/lib/mail-view'

// Renders nothing. Its only job is to say "the mail view is on screen" for as
// long as it is, so the admin-wide mail pulse knows to check at the Settings
// pace rather than the background one - see lib/mail-view.ts.
export function MailViewBeacon() {
  useEffect(() => openMailView(), [])
  return null
}

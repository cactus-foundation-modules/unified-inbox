import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getSettings, updateSettings } from '@/modules/unified-inbox/lib/db'
import { mergeOrder } from '@/modules/unified-inbox/lib/list'
import { ChannelOrderBody } from '@/modules/unified-inbox/lib/validation'

// The order the channels sit in down the rail, saved in one go.
//
// It asks for `manage` for the same reason the addresses do: the order is the
// site's, the same for everybody who opens the inbox, so the person who
// arranges it is the person who looks after the place. Anybody who may only
// read gets the channels as arranged and nothing draggable at all.
//
// What arrives is only the channels the person doing the dragging can SEE - a
// channel is governed by the module that owns it, and two colleagues can be
// looking at two different lists. So the posted order is merged into the one
// already stored rather than replacing it, and a key nobody saw keeps its
// place. That is also why nothing here checks the keys against the installed
// channels: a key naming a channel this site does not have today is harmless,
// and dropping it would lose the place a channel was put in every time its
// module was switched off for an afternoon.
export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!await hasPermission(user, 'unifiedinbox.manage')) return errorResponse('Forbidden', 403)

  const parsed = ChannelOrderBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That is not an order this can save.')

  const keys = parsed.data.keys
  if (new Set(keys).size !== keys.length) return errorResponse('That is not an order this can save.')

  const settings = await getSettings()
  await updateSettings({ channelOrder: mergeOrder(settings.channelOrder, keys) })
  return NextResponse.json({ ok: true })
}

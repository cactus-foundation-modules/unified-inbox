import { PUSH_WORKER_SOURCE } from '@/modules/unified-inbox/lib/push-worker'

// The service worker behind new-mail nudges. See lib/push-worker.ts.
//
// Open to anybody, deliberately: it is the same few lines for every site and
// every visitor, it holds nothing about anybody, and a browser fetching it to
// check for an update is not always carrying the session that registered it.

export const dynamic = 'force-dynamic'

export function GET() {
  return new Response(PUSH_WORKER_SOURCE, {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      // Always asked afresh, so a fix to the worker reaches every browser on
      // its next visit rather than whenever a cache decides.
      'Cache-Control': 'no-cache, max-age=0',
    },
  })
}

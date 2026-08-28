import { z } from 'zod'

// Shared between the create and the edit route, so an inbox cannot be saved
// through one of them with a field the other would have refused.

export const InboxBody = z.object({
  name: z.string().min(1).max(120),
  address: z.string().min(3).max(255),
  connectionId: z.string().nullable().optional(),
  imapFolder: z.string().min(1).max(255).optional(),
  sentFolder: z.string().max(255).nullable().optional(),
  isCatchAll: z.boolean().optional(),
  sendTransport: z.enum(['brevo', 'smtp']).optional(),
  brevoApiKey: z.string().nullable().optional(),
  smtpHost: z.string().max(255).nullable().optional(),
  smtpPort: z.number().int().min(1).max(65535).nullable().optional(),
  smtpUsername: z.string().max(255).nullable().optional(),
  smtpPassword: z.string().nullable().optional(),
  fromName: z.string().max(120).nullable().optional(),
  signatureHtml: z.string().max(20000).nullable().optional(),
  appendToSent: z.boolean().optional(),
  colour: z.string().max(32).nullable().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
})

export const InboxPatchBody = InboxBody.partial()

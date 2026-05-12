// Resend transactional-email integration. Thin REST wrapper used by
// app/lib/email.server.ts. Reads RESEND_API_KEY from env — never hard-code.
// API reference: https://resend.com/docs/api-reference/emails/send-email

import type { Env } from "../../../load-context";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface ResendSendInput {
  from: string;
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

export interface ResendSendResult {
  id: string;
}

export class ResendError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super("Resend API " + status + ": " + body.slice(0, 200));
    this.status = status;
    this.body = body;
  }
}

export async function resendSend(
  env: Pick<Env, "RESEND_API_KEY">,
  input: ResendSendInput,
): Promise<ResendSendResult | null> {
  if (!env.RESEND_API_KEY) {
    console.warn("[resend] RESEND_API_KEY not bound — skipping send to " + JSON.stringify(input.to));
    return null;
  }
  const body = {
    from: input.from,
    to: Array.isArray(input.to) ? input.to : [input.to],
    subject: input.subject,
    html: input.html,
    text: input.text,
    reply_to: input.replyTo,
    headers: input.headers,
  };
  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.RESEND_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new ResendError(res.status, text);
  }
  return JSON.parse(text) as ResendSendResult;
}

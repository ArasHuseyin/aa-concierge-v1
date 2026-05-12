// Outbound transactional email — thin facade over Resend. All feature
// code (subscription dunning, post-purchase review requests) goes through
// sendEmail() here so we have one place to add retries, suppressions,
// per-shop From-overrides, etc.

import type { Env } from "../../load-context";
import { resendSend, ResendError } from "./integrations/resend.server";
import { captureApiError } from "./merchant-qa.server";

export interface SendEmailInput {
  shop: string;
  to: string;
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
  /**
   * Override the From-address. Defaults to env.EMAIL_FROM, falling back
   * to "noreply@<shop>" if unset. Pass an explicit value when the merchant
   * has configured a custom sender in app settings.
   */
  from?: string;
}

export interface SendEmailResult {
  delivered: boolean;
  providerId?: string;
  skippedReason?: "no_api_key" | "invalid_recipient";
}

function defaultFrom(shop: string, fallback?: string): string {
  if (fallback) return fallback;
  return "AA Concierge <noreply@" + shop + ">";
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function sendEmail(env: Env, input: SendEmailInput): Promise<SendEmailResult> {
  if (!EMAIL_RE.test(input.to)) {
    return { delivered: false, skippedReason: "invalid_recipient" };
  }
  if (!env.RESEND_API_KEY) {
    return { delivered: false, skippedReason: "no_api_key" };
  }
  try {
    const result = await resendSend(env, {
      from: input.from ?? defaultFrom(input.shop, env.EMAIL_FROM),
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      replyTo: input.replyTo,
    });
    return { delivered: result !== null, providerId: result?.id };
  } catch (err) {
    const label = err instanceof ResendError ? "resend POST /emails" : "email send";
    await captureApiError(env, label, err);
    throw err;
  }
}

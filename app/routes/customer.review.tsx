// Customer-facing review-submission page. Reached via a one-time
// tokenized link the post-purchase email sends out — NOT an embedded
// admin route, so no App Bridge / JWT auth. Token presence + a single
// SQL lookup are the only auth.

import {
  json,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "@remix-run/cloudflare";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";

import type { Env } from "../../load-context";
import { findRequestByToken, submitReview } from "~/lib/concierge/reviews.server";

export const meta: MetaFunction = () => [
  { title: "Leave a review" },
  { name: "viewport", content: "width=device-width, initial-scale=1" },
];

interface LoaderData {
  token: string;
  productRemoteId: string;
  alreadySubmitted: boolean;
  invalid: boolean;
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<Response> {
  const env = (context.cloudflare?.env ?? {}) as Env;
  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (!token || !env.D1) {
    return json<LoaderData>({ token, productRemoteId: "", alreadySubmitted: false, invalid: true });
  }
  const req = await findRequestByToken(env.D1, token);
  if (!req) {
    return json<LoaderData>({ token, productRemoteId: "", alreadySubmitted: false, invalid: true });
  }
  return json<LoaderData>({
    token,
    productRemoteId: req.productRemoteId,
    alreadySubmitted: Boolean(req.submittedAt),
    invalid: false,
  });
}

interface ActionResult {
  ok: boolean;
  message: string;
}

export async function action({ request, context }: ActionFunctionArgs): Promise<Response> {
  const env = (context.cloudflare?.env ?? {}) as Env;
  if (!env.D1) {
    return json<ActionResult>({ ok: false, message: "Service unavailable." }, { status: 503 });
  }
  const form = await request.formData();
  const token = String(form.get("token") ?? "");
  const rating = Number(form.get("rating") ?? 0);
  const title = String(form.get("title") ?? "").trim() || undefined;
  const body = String(form.get("body") ?? "").trim() || undefined;

  // Photo handling — store URLs the storefront uploads to a CDN, comma-separated
  // in the form. V1 accepts up to 5; richer storage (R2 direct uploads) is a
  // V2 follow-up.
  const photoCsv = String(form.get("photoUrls") ?? "").trim();
  const photoUrls = photoCsv
    ? photoCsv.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 5)
    : undefined;

  const result = await submitReview(env.D1, { token, rating, title, body, photoUrls });
  if (!result.ok) {
    return json<ActionResult>({ ok: false, message: result.reason }, { status: 400 });
  }
  return json<ActionResult>({ ok: true, message: "Thanks — your review has been submitted!" });
}

export default function CustomerReview() {
  const data = useLoaderData<typeof loader>() as LoaderData;
  const actionData = useActionData<typeof action>() as ActionResult | undefined;
  const nav = useNavigation();
  const submitting = nav.state === "submitting";

  if (data.invalid) {
    return (
      <PageShell>
        <h1>Link not found</h1>
        <p>This review link is invalid or has expired.</p>
      </PageShell>
    );
  }
  if (data.alreadySubmitted || actionData?.ok) {
    return (
      <PageShell>
        <h1>Thanks for your review!</h1>
        <p>{actionData?.ok ? actionData.message : "We've recorded your feedback."}</p>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <h1>Leave a review</h1>
      <p style={{ color: "#666" }}>Product: {data.productRemoteId}</p>
      <Form method="post" style={{ display: "grid", gap: "1rem" }}>
        <input type="hidden" name="token" value={data.token} />
        <label>
          <div>Rating</div>
          <select name="rating" required defaultValue="5" style={inputStyle}>
            {[5, 4, 3, 2, 1].map((n) => (
              <option key={n} value={n}>
                {n} {"★".repeat(n)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <div>Title</div>
          <input name="title" type="text" maxLength={120} style={inputStyle} />
        </label>
        <label>
          <div>Your review</div>
          <textarea name="body" rows={5} maxLength={2000} style={inputStyle} />
        </label>
        <label>
          <div>Photo URLs (comma-separated, optional)</div>
          <input
            name="photoUrls"
            type="text"
            placeholder="https://cdn.shopify.com/.../my-photo.jpg, https://..."
            style={inputStyle}
          />
          <small style={{ color: "#666" }}>
            Upload up to 5 photos to your image host and paste the URLs here.
          </small>
        </label>
        {actionData && !actionData.ok ? (
          <p style={{ color: "#b00", margin: 0 }}>Couldn't submit: {actionData.message}</p>
        ) : null}
        <button type="submit" disabled={submitting} style={buttonStyle}>
          {submitting ? "Submitting…" : "Submit review"}
        </button>
      </Form>
    </PageShell>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <main
      style={{
        fontFamily: "system-ui, -apple-system, sans-serif",
        padding: "2rem 1rem",
        maxWidth: 560,
        margin: "0 auto",
      }}
    >
      {children}
    </main>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.5rem 0.75rem",
  border: "1px solid #ccc",
  borderRadius: 4,
  fontSize: 16,
  boxSizing: "border-box",
};

const buttonStyle: React.CSSProperties = {
  padding: "0.75rem 1rem",
  background: "#008060",
  color: "white",
  border: 0,
  borderRadius: 4,
  fontSize: 16,
  cursor: "pointer",
};

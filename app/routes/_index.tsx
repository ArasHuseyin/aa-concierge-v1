import {
  json,
  type ActionFunctionArgs,
  type LinksFunction,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "@remix-run/cloudflare";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import {
  AppProvider,
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  FormLayout,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import polarisTranslations from "@shopify/polaris/locales/en.json";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";

import type { Env } from "../../load-context";
import { authenticate, isValidShop } from "~/lib/shopify.server";
import {
  getAppSettings,
  putAppSettings,
} from "~/lib/db/app-tables.server";
import { listBundles } from "~/lib/concierge/bundles.server";
import { captureSetupStep } from "~/lib/merchant-qa.server";

export const meta: MetaFunction = () => [
  { title: "AA Concierge V1" },
  {
    name: "description",
    content:
      "Product subscriptions, customizable bundles, loyalty points, and post-purchase reviews — in one Polaris admin.",
  },
];

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: polarisStyles },
];

interface ConciergeSettings {
  subscriptionsEnabled: boolean;
  bundlesEnabled: boolean;
  loyaltyEnabled: boolean;
  reviewsEnabled: boolean;
  reviewRequestDelayDays: number;
  pointsPerDollar: number;
  fromEmail: string;
}

const DEFAULT_SETTINGS: ConciergeSettings = {
  subscriptionsEnabled: true,
  bundlesEnabled: true,
  loyaltyEnabled: true,
  reviewsEnabled: true,
  reviewRequestDelayDays: 7,
  pointsPerDollar: 1,
  fromEmail: "",
};

function mergeSettings(raw: Record<string, unknown>): ConciergeSettings {
  return {
    subscriptionsEnabled: typeof raw.subscriptionsEnabled === "boolean" ? raw.subscriptionsEnabled : DEFAULT_SETTINGS.subscriptionsEnabled,
    bundlesEnabled: typeof raw.bundlesEnabled === "boolean" ? raw.bundlesEnabled : DEFAULT_SETTINGS.bundlesEnabled,
    loyaltyEnabled: typeof raw.loyaltyEnabled === "boolean" ? raw.loyaltyEnabled : DEFAULT_SETTINGS.loyaltyEnabled,
    reviewsEnabled: typeof raw.reviewsEnabled === "boolean" ? raw.reviewsEnabled : DEFAULT_SETTINGS.reviewsEnabled,
    reviewRequestDelayDays: typeof raw.reviewRequestDelayDays === "number" ? raw.reviewRequestDelayDays : DEFAULT_SETTINGS.reviewRequestDelayDays,
    pointsPerDollar: typeof raw.pointsPerDollar === "number" ? raw.pointsPerDollar : DEFAULT_SETTINGS.pointsPerDollar,
    fromEmail: typeof raw.fromEmail === "string" ? raw.fromEmail : DEFAULT_SETTINGS.fromEmail,
  };
}

interface LoaderData {
  mode: "embedded" | "landing";
  shop: string | null;
  host: string | null;
  apiKey: string | null;
  settings: ConciergeSettings;
  status: {
    d1: "ok" | "warning";
    queue: "ok" | "warning";
    email: "ok" | "warning";
  };
  bundleCount: number;
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<Response> {
  const env = (context.cloudflare?.env ?? {}) as Env;
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const host = url.searchParams.get("host");

  if (!shop) {
    return json<LoaderData>({
      mode: "landing",
      shop: null,
      host: null,
      apiKey: env.SHOPIFY_API_KEY ?? null,
      settings: DEFAULT_SETTINGS,
      status: { d1: "warning", queue: "warning", email: "warning" },
      bundleCount: 0,
    });
  }
  if (!isValidShop(shop)) {
    throw new Response("Invalid shop", { status: 400 });
  }

  let settings = DEFAULT_SETTINGS;
  let bundleCount = 0;
  if (env.D1) {
    settings = mergeSettings(await getAppSettings<Record<string, unknown>>(env.D1, shop));
    const list = await listBundles(env.D1, shop);
    bundleCount = list.length;
  }
  return json<LoaderData>({
    mode: "embedded",
    shop,
    host,
    apiKey: env.SHOPIFY_API_KEY ?? null,
    settings,
    status: {
      d1: env.D1 ? "ok" : "warning",
      queue: env.CONCIERGE_QUEUE ? "ok" : "warning",
      email: env.RESEND_API_KEY ? "ok" : "warning",
    },
    bundleCount,
  });
}

interface ActionResult {
  ok: boolean;
  message: string;
}

export async function action({ request, context }: ActionFunctionArgs): Promise<Response> {
  const { shop } = await authenticate.admin(request, context);
  const env = (context.cloudflare?.env ?? {}) as Env;
  if (!env.D1) {
    return json<ActionResult>({ ok: false, message: "D1 binding missing — settings not persisted." }, { status: 503 });
  }
  const form = await request.formData();
  const settings: ConciergeSettings = {
    subscriptionsEnabled: form.get("subscriptionsEnabled") === "on",
    bundlesEnabled: form.get("bundlesEnabled") === "on",
    loyaltyEnabled: form.get("loyaltyEnabled") === "on",
    reviewsEnabled: form.get("reviewsEnabled") === "on",
    reviewRequestDelayDays: Math.max(1, Math.min(30, Number(form.get("reviewRequestDelayDays") ?? 7))),
    pointsPerDollar: Math.max(1, Math.min(100, Number(form.get("pointsPerDollar") ?? 1))),
    fromEmail: String(form.get("fromEmail") ?? ""),
  };
  await putAppSettings(env.D1, shop, settings as unknown as Record<string, unknown>);
  await captureSetupStep(env, "concierge_settings_saved", {
    shop,
    subscriptions: String(settings.subscriptionsEnabled),
    bundles: String(settings.bundlesEnabled),
    loyalty: String(settings.loyaltyEnabled),
    reviews: String(settings.reviewsEnabled),
  });
  return json<ActionResult>({ ok: true, message: "Settings saved." });
}

export default function Index() {
  const data = useLoaderData<typeof loader>() as LoaderData;
  const actionData = useActionData<typeof action>() as ActionResult | undefined;
  const nav = useNavigation();
  const saving = nav.state === "submitting" || nav.state === "loading";

  if (data.mode === "landing") {
    return (
      <main style={{ fontFamily: "system-ui", padding: "2rem", maxWidth: 720 }}>
        <h1 style={{ marginTop: 0 }}>AA Concierge V1</h1>
        <p>
          All-in-one merchandising suite: product subscriptions with pause/skip/cancel
          and dunning emails, customizable bundles, customer loyalty points with
          tier-based redemption, and post-purchase review requests with photo uploads.
        </p>
        <p>
          This page must be opened from inside the Shopify admin to access the
          embedded dashboard.
        </p>
      </main>
    );
  }

  const s = data.settings;

  return (
    <AppProvider i18n={polarisTranslations}>
      <Page title="AA Concierge" subtitle={data.shop ?? undefined}>
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Status overview</Text>
                <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
                  <StatusTile label="Data store (D1)" tone={data.status.d1 === "ok" ? "success" : "warning"}>
                    {data.status.d1 === "ok" ? "Connected" : "Not bound"}
                  </StatusTile>
                  <StatusTile label="Job queue" tone={data.status.queue === "ok" ? "success" : "warning"}>
                    {data.status.queue === "ok" ? "Connected" : "Not bound"}
                  </StatusTile>
                  <StatusTile label="Email (Resend)" tone={data.status.email === "ok" ? "success" : "warning"}>
                    {data.status.email === "ok" ? "Configured" : "Missing RESEND_API_KEY"}
                  </StatusTile>
                </InlineGrid>
                <InlineStack gap="200">
                  <Badge tone="info">{data.bundleCount + " bundle(s)"}</Badge>
                  <Badge tone={s.subscriptionsEnabled ? "success" : undefined}>
                    {s.subscriptionsEnabled ? "Subscriptions on" : "Subscriptions off"}
                  </Badge>
                  <Badge tone={s.loyaltyEnabled ? "success" : undefined}>
                    {s.loyaltyEnabled ? "Loyalty on" : "Loyalty off"}
                  </Badge>
                  <Badge tone={s.reviewsEnabled ? "success" : undefined}>
                    {s.reviewsEnabled ? "Reviews on" : "Reviews off"}
                  </Badge>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <Form method="post" id="concierge-settings-form">
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">Feature settings</Text>
                  <FormLayout>
                    <Checkbox
                      label="Product subscriptions (pause/skip/cancel + dunning)"
                      name="subscriptionsEnabled"
                      checked={s.subscriptionsEnabled}
                    />
                    <Checkbox
                      label="Customizable bundles with bundle-only pricing"
                      name="bundlesEnabled"
                      checked={s.bundlesEnabled}
                    />
                    <Checkbox
                      label="Loyalty points with tier-based redemption"
                      name="loyaltyEnabled"
                      checked={s.loyaltyEnabled}
                    />
                    <Checkbox
                      label="Post-purchase review requests (with photo uploads)"
                      name="reviewsEnabled"
                      checked={s.reviewsEnabled}
                    />
                    <Select
                      label="Send review request after"
                      name="reviewRequestDelayDays"
                      options={[
                        { label: "3 days", value: "3" },
                        { label: "7 days", value: "7" },
                        { label: "14 days", value: "14" },
                        { label: "21 days", value: "21" },
                        { label: "30 days", value: "30" },
                      ]}
                      value={String(s.reviewRequestDelayDays)}
                    />
                    <TextField
                      label="Points per dollar spent"
                      name="pointsPerDollar"
                      type="number"
                      min={1}
                      max={100}
                      value={String(s.pointsPerDollar)}
                      autoComplete="off"
                    />
                    <TextField
                      label="From-address for outbound email"
                      name="fromEmail"
                      type="email"
                      value={s.fromEmail}
                      autoComplete="off"
                      helpText="Leave blank to default to noreply@<shop-domain>."
                    />
                  </FormLayout>
                  {actionData ? (
                    <Box paddingBlockStart="200">
                      <Text as="p" tone={actionData.ok ? "success" : "critical"}>
                        {actionData.message}
                      </Text>
                    </Box>
                  ) : null}
                  <InlineStack align="end">
                    <Button submit variant="primary" loading={saving}>Save settings</Button>
                  </InlineStack>
                </BlockStack>
              </Form>
            </Card>
          </Layout.Section>
        </Layout>
        {data.apiKey ? (
          <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" data-api-key={data.apiKey} />
        ) : null}
      </Page>
    </AppProvider>
  );
}

function StatusTile({
  label,
  tone,
  children,
}: {
  label: string;
  tone: "success" | "warning";
  children: React.ReactNode;
}) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
        <Badge tone={tone}>{String(children)}</Badge>
      </BlockStack>
    </Card>
  );
}


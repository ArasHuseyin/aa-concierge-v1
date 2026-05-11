# Reviewer quick start for AA Concierge V1

Use this file as the Partner Dashboard review note source.

## Smoke test

- Install on a clean development store and complete OAuth.
- Confirm the app loads on its selected surface: embedded-admin.
- Exercise the primary merchant workflow described in the listing.
- Confirm GDPR webhooks, support, privacy, data-retention, status, health, and version endpoints.
- Plus-only checkout instructions are not required for this app surface.

## Scope justification

| Scope | Justification |
|---|---|
| `read_products` | This app uses `read_products` to read product catalog data used by the selected app features. |
| `write_products` | This app uses `write_products` to write product updates requested by merchant workflows. |
| `read_orders` | This app uses `read_orders` to read order data for fulfillment, analytics, or post-purchase automation. |
| `write_orders` | This app uses `write_orders` to write order updates required by merchant workflows. |
| `read_customers` | This app uses `read_customers` to read customer records needed for personalization or support. |
| `write_customers` | This app uses `write_customers` to write customer records or metafields for the configured feature set. |
| `write_metaobjects` | This app uses `write_metaobjects` to write metaobject data managed by app workflows. |

## Webhooks

- Mandatory GDPR webhooks are still required and must verify HMAC signatures.

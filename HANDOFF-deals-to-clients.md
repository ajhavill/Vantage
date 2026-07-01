# Handoff — link Deals into the Clients hub (Phase 2)

**From:** the Clients-hub work (`session/clients-hub`)
**To:** the Deals session (owner of `deals.html`, `dealflow*.sql`, `deal-*` functions)
**Status:** the Clients-hub side is **already built and verified**; it needs one endpoint + a link column from the Deals side to go live.

---

## Context

The Clients hub gives each client one page that aggregates their questionnaires,
packages, and comps — keyed by **HubSpot company id** (HubSpot Companies are the
client roster's source of truth). Its detail page has a **"Proposals & leases"**
section that already calls an endpoint and renders the result. That endpoint
doesn't exist yet — building it is this handoff.

The Clients hub does **not** touch `deals.html`, `dealflow*.sql`, or `deal-*`
functions (per the multi-session ownership split) — those are yours. This is a
pure interface contract.

## The shared key

**`hs_company_id` (text)** — the HubSpot company id. Same bridge the
tenant-intelligence layer and the Clients hub already use. Every deal that
belongs to a client should carry it; that's what ties a deal to a client.

## What the Clients hub already does (the contract to build to)

On a client's detail page it sends:

```
POST /.netlify/functions/deal-client-list
{ "token": "<supabase access token>", "hsCompanyId": "<HubSpot company id>" }
```

and renders `response.deals[]`. Expected shape (extra fields ignored, optional
fields may be omitted):

```jsonc
{
  "deals": [
    {
      "id": "…",                        // your deal id (required)
      "name": "Brightwork HQ — 2425 Olympic",
      "kind": "lease" | "proposal" | "deal",   // drives the row badge
      "stage": "Executed",              // optional label
      "building": "The Water Garden",   // optional
      "rsf": 10000,                     // optional number
      "execution_date": "2026-01-15",   // optional (leases)
      "status": "executed",             // optional
      "url": "deals.html?d=<id>"        // optional deep link — row becomes clickable
    }
  ]
}
```

If the endpoint 404s or errors, the hub shows a graceful placeholder, so
**partial / later delivery is safe** — nothing breaks in the meantime.

## Asks (Deals session)

1. **Schema** (in `dealflow.sql` or a new `deal-*.sql` — never `schema.sql`):
   ```sql
   alter table public.deals add column if not exists hs_company_id text;
   create index if not exists deals_org_hs_company_idx on public.deals(org_id, hs_company_id);
   ```

2. **Stamp `hs_company_id`** when a deal is created/edited — from the deal's
   associated HubSpot company, or a client picker in `deals.html`. Deals without
   it simply won't appear in the hub (acceptable).

3. **Read endpoint `deal-client-list.js`** (`deal-*` = your namespace):
   - Auth via the Supabase token (`userFromToken`), org scope from the broker's
     profile — exact same pattern as `tenant-snapshot.js` / `comps.js`.
   - Select the org's deals where `hs_company_id = body.hsCompanyId`, map to the
     shape above, return `{ deals: [...] }`. Honor RLS / org scope.

## Coordination notes

- **Two "deal" concepts exist:** your Vantage `deals` pipeline (`deals.html`) and
  HubSpot deals (which the **comps** sync reads to auto-create comps). Decide
  whether `hs_company_id` on a Vantage deal comes from a linked HubSpot deal's
  associated company or is set directly — either works here; just be consistent.
- **Tenant portal (Phase 3):** later a client-facing variant of this endpoint
  will need redaction (hide commission, etc.), like the comps client mode. Not
  needed now.
- **Financial analysis (Phase 3):** the hub has a labeled placeholder; no ask yet.

## When you ship it

Nothing further is needed from the Clients hub — it already calls
`deal-client-list` with the client's `hs_company_id` and renders the response, so
it lights up automatically. Ping me if you'd like to adjust the response shape.

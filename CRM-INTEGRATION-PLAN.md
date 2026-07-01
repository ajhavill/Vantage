# Vantage — CRM integration: architecture & plan

**Goal:** when Vantage is licensed to other brokerages, each firm connects **their
own** CRM (HubSpot, Salesforce, or others). Vantage then (a) **pulls** the company,
contact, and deal data they already have so brokers don't re-type it, and (b) **pushes**
deal progress, proposal terms, and stage changes back so the firm's CRM stays current
without double-entry. Per-firm, isolated, secure.

> **Update (Tenants module — native HubSpot, built now):** the general *deal/contact*
> CRM sync described below is still deferred to licensing era. Separately, the **Tenants
> intelligence layer** ships now against **HubSpot natively** (not a unified API), because
> Havill's tenant book already lives in HubSpot as Companies and there's a concrete need
> today. Scope: HubSpot Companies are the tenant system of record (no tenant store in
> Vantage); a private-app token (`HUBSPOT_PRIVATE_APP_TOKEN`) is read server-side by the
> `tenants-*` / `hubspot-bootstrap` Netlify Functions; the only Vantage-side storage is a
> headcount **snapshot timeseries** (`supabase/tenant-intel.sql`) HubSpot can't provide.
> This is a deliberate, contained exception to the "unified API first" recommendation in
> §3 — it does not change the plan for full deal/contact sync. See the module files:
> `_hubspot.js`, `_propensity*.js`, `tenants-list.js`, `tenant-get.js`, `tenant-snapshot.js`,
> and `public/tenants.html`.

This is a **licensing-era feature** — there's nothing to sync to while Vantage is
Havill-only. This document is the *design* so the foundation is right; the *build*
happens when a real licensee asks. The expensive groundwork (the multi-tenant `org_id`
model that lets each firm hold its own private CRM connection) is **already done** — see
[PORTAL-PLAN.md](PORTAL-PLAN.md) and `supabase/schema.sql`.

---

## 1. Why this is the licensing keystone

A brokerage's CRM is their system of record. A tool that *ignores* it creates double-entry
and gets abandoned; a tool that *syncs* with it slots into how they already work and gets
adopted. For Vantage-as-a-product, "works with your CRM" is the difference between a demo
and a signed contract. So it's worth designing correctly even though we build it later.

---

## 2. The two directions of sync (build both, but phase them)

| Direction | What it does | Who loves it |
|---|---|---|
| **Inbound** (CRM → Vantage) | Start a deal → import the client company + contacts + deal from their CRM → fields pre-fill. *This is the "auto-populate what they already have."* | Brokers (less typing) |
| **Outbound** (Vantage → CRM) | Deal stage moves (Touring → Proposals → Executed), a proposal is finalized, a client link is shared → push that back to the CRM record. | Managers / principals (their system of record stays live without chasing brokers) |

Inbound is the obvious ask; **outbound is what actually sells it** to the person who signs
the license, because the brokers' field activity shows up in the CRM automatically.

---

## 3. The key decision: unified API vs. native (build-vs-buy)

You do **not** have to build HubSpot, then Salesforce, then Pipedrive, then the next one,
each as a separate integration that you maintain forever. Two paths:

### Option A — Unified CRM API provider (recommended starting point)
Services like **Merge.dev**, **Nango**, or **Paragon** give you **one** integration that
normalizes *dozens* of CRMs behind a single interface. You build the connector once; your
customers connect whatever CRM they use. The provider also **holds the OAuth tokens** for
you (a real security win — see §6).
- **Pros:** one build covers many CRMs; they handle token refresh, API quirks, and new CRMs; faster time-to-first-licensee.
- **Cons:** a monthly cost (often per connected account); a third-party dependency; less deep/custom than native.

### Option B — Native, per-CRM
Build directly against HubSpot's and Salesforce's APIs.
- **Pros:** full control, deepest integration, no per-connection middleware fee.
- **Cons:** one build *and ongoing maintenance* per CRM; you store and refresh tokens yourself.

### Recommendation
**Start with a unified API (Option A)** so day-one licensees can connect *any* CRM with one
build. Add a **native** integration (Option B) only for the single CRM your biggest
licensees all use and want deep, custom behavior with. This keeps a lean team from drowning
in N separate integrations.

> Practical note: this is a paid capability with real vendor cost (unified-API fee or dev
> time). Price CRM sync as a **premium tier / add-on** in the license — it's exactly the
> kind of feature firms pay more for.

---

## 4. Data model additions (proposed — apply when building)

These hang off the existing `orgs` and `deals` tables. They're **additive and safe**, but
there's no reason to run them until you pursue licensing — they're documented here so the
shape is settled. (When built, these live in a new `supabase/integrations.sql` owned by the
deal-flow module, **not** in `schema.sql`.)

```sql
-- One row per (firm, CRM). The firm's connection to their CRM.
create table if not exists public.org_integrations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  provider text not null,                 -- 'hubspot' | 'salesforce' | 'merge' | ...
  status text not null default 'disconnected'
    check (status in ('disconnected','connected','error')),
  external_account_id text,               -- the CRM account/portal id
  account_label text,                     -- e.g. "Acme Realty — HubSpot (Production)"
  token_ref text,                         -- REFERENCE to the secret store / Merge account
                                          -- token — NEVER the raw OAuth secret (see §6)
  config jsonb not null default '{}'::jsonb,  -- field mappings, sync direction, toggles
  last_sync_at timestamptz,
  last_error text,
  connected_by uuid references public.profiles(id),
  connected_at timestamptz,
  created_at timestamptz not null default now()
);
-- one active connection per provider per firm
create unique index if not exists org_integrations_unique
  on public.org_integrations(org_id, provider);

-- Contacts on a deal (the people). Vantage's deal model is thin today; CRM sync needs
-- real contacts to map CRM Contacts onto. External refs let each map 1:1 to a CRM record.
create table if not exists public.deal_contacts (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.deals(id) on delete cascade,
  name text, email text, phone text, title text, company text,
  is_primary boolean not null default false,
  external_source text,                   -- 'hubspot' | 'salesforce' | ...
  external_id text,                       -- the CRM contact id
  created_at timestamptz not null default now()
);

-- External-reference columns so a Vantage deal maps 1:1 to a CRM deal/opportunity.
-- (Adding these EARLY is the one genuinely "cheap now / painful later" bit — it lets you
--  match records without a messy backfill once a firm connects.)
alter table public.deals add column if not exists external_source text;   -- 'hubspot' | ...
alter table public.deals add column if not exists external_id text;       -- CRM deal id
alter table public.deals add column if not exists external_url text;       -- deep link to the CRM record
alter table public.deals add column if not exists external_synced_at timestamptz;

-- Optional: an audit trail of syncs (helpful for debugging + showing firms what happened).
create table if not exists public.crm_sync_log (
  id bigint generated always as identity primary key,
  org_id uuid references public.orgs(id) on delete cascade,
  deal_id uuid references public.deals(id) on delete set null,
  direction text check (direction in ('inbound','outbound')),
  entity text,                            -- 'company' | 'contact' | 'deal'
  ok boolean, detail text,
  created_at timestamptz not null default now()
);
```

**RLS (isolation):** an `org_integrations` row is visible/editable only to that firm's
`org_admin` and the `platform_admin` (you) — **never** another firm, and brokers see only
*connection status*, not credentials. `deal_contacts` / external refs follow the existing
`can_access_deal()` rule. Tokens are never returned to the browser at all.

---

## 5. Field mapping — where the real work is

The API calls are the easy part. The hard part: **every firm customizes their CRM.** One
firm's "Deal Value" is another's "Estimated Rent"; Salesforce shops rename and add fields
heavily. So mapping **must be configurable per firm**, stored in `org_integrations.config`.

Default mappings to ship, then let firms adjust:

| CRM concept | → Vantage |
|---|---|
| Company / Account | the deal's client (`deals.client_name`) + `deal_contacts.company` |
| Contact | a `deal_contacts` row (name, email, phone, title) |
| Deal / Opportunity | a `deals` row (+ **stage mapping**: their pipeline stages ↔ our `touring/proposals/negotiation/executed`) |
| Deal amount / close date | surfaced on the deal; proposal economics can push back as a note/field |

Stage mapping is the fiddly bit — provide a simple "their stage → our stage" picker in the
mapping UI.

---

## 6. Security & isolation (do not cut corners here)

This is firms' real client data and live CRM credentials — get it right or it's a dealbreaker.

- **Per-firm isolation** is already enforced by `org_id` + RLS — a firm can never see or
  touch another firm's connection or synced data. (This is the part we already built.)
- **Tokens never live in the browser, and never in plain Postgres.** Either:
  - the **unified-API provider holds the OAuth tokens** (you store only their account token / reference) — *simplest and safest*; or
  - if native, store tokens **encrypted at rest** (pgcrypto / a secrets manager), decrypted only inside server-side functions.
- **All CRM calls run server-side** in Netlify Functions using the service-role key — same
  pattern as the deal-client and commute functions. The front end never holds a CRM token.
- **Token refresh, rate limits, and revocation** handled server-side (the unified provider
  does most of this for you).
- **Audit** every sync (`crm_sync_log`) so a firm can see exactly what was read/written.

---

## 7. Front-end experience (what the firm actually sees)

1. **Settings → Integrations** (org-admin only): a "Connect HubSpot / Salesforce / other"
   button → OAuth popup → returns to a green **"Connected — Acme Realty (HubSpot)"** status
   card with last-sync time and a "Disconnect" / "Field mapping" link.
2. **New deal → "Import from CRM"**: search the firm's CRM companies/deals → pick one →
   the deal form pre-fills (client, contacts, building if mapped). Broker confirms and saves.
3. **On the deal**: a small "Synced with HubSpot ↗" chip linking to the CRM record; stage
   changes and finalized proposals quietly push back (if outbound is enabled).
4. **Connection health**: if a token expires or a sync errors, the org-admin sees a banner
   to reconnect — never a silent failure.

Brokers experience it as "less typing + my CRM is magically up to date." Admins experience
it as one connect-button and a mapping screen.

---

## 8. Phased rollout (when you pursue licensing)

- **Phase 0 — Foundation (cheap, optional, now):** the §4 scaffolding can be applied
  anytime (zero rows, nothing wired). The only piece worth adding *early* is the external-ref
  columns on `deals`, so existing deals can be matched to CRM records later without a backfill.
- **Phase 1 — Connect + inbound:** pick the unified-API provider; build the OAuth connect
  flow + "Import from CRM" pre-fill. *Licensees can now pull their data in.*
- **Phase 2 — Outbound:** push stage changes + finalized proposals back to the CRM
  (configurable; some firms want one-way).
- **Phase 3 — Depth:** configurable field-mapping UI, scheduled + webhook **auto-sync**
  (real-time), and a **native** integration for the top CRM that wants it.

---

## 9. What we do NOW vs. defer

| Now (design-time, cheap) | Defer to first licensee |
|---|---|
| This plan documented ✓ | Register apps with HubSpot/Salesforce *or* sign up for a unified-API provider |
| `org_id` multi-tenant foundation ✓ (done) | The OAuth connect flow + token storage |
| (Optional) add external-ref columns to `deals` | The connectors (read/write) + sync engine |
| Server-side-function pattern proven ✓ (commute/deal-client) | The field-mapping UI + stage mapping |

**Bottom line:** the architecture is settled and the multi-tenant + server-side-function
foundations are already in place, so when a licensee asks "does it work with our Salesforce?"
the answer is "yes — we designed for it from day one," and it's a *module to build*, not a
*re-architecture*. Don't build it before you have a licensee who needs it; do keep this plan
current as the product evolves.

# Vantage — multi-broker login portal: design & plan

**Goal:** turn Vantage from a single shared tool into a private portal where each
Havill & Co. broker (6–15 people) logs in, has their own workspace, creates client
packages, sees their own engagement, and saves reports — with you (Andrew) as admin
able to oversee everyone. Prospects still open client links with **just a passcode**
(no login) — nothing changes for them.

This is the biggest build so far and a real architecture step. This document is the
plan to approve **before** any code is written.

---

## 1. What this fixes / adds
- **Privacy:** today the Cockpit has no login — anyone with the URL can open your
  internal tool. A portal makes it private (login required).
- **Per-broker workspaces:** each broker sees only *their* clients, packages, and
  engagement — not everyone else's.
- **Saved reports:** save a configured shortlist (buildings + priorities + filters) and
  reload it later, instead of rebuilding each time.
- **Admin oversight:** you can see all brokers' activity and manage who has access.

## 2. The two new foundations (and why)
1. **Authentication (login).** We will **not** hand-roll passwords/sessions — that's
   security-sensitive and easy to get wrong. We use a managed provider.
2. **A real database.** Today data lives in Netlify Blobs (key-value) + your browser's
   localStorage. With users + saved reports + "show me all my clients," we need a
   database that can answer ownership/queries. This is the moment to graduate.

### Recommended stack: **Supabase**
One service gives us **login + a Postgres database + file storage**, has a free tier
that comfortably covers 6–15 people, and — key for us — works from a plain `<script>`
tag, so it fits the current no-build, vanilla-JS setup. Per-broker data isolation is
enforced at the database layer (Row-Level Security), so a broker *cannot* see another
broker's data even by accident.
- *Alternative considered:* Clerk (best login UX) — but it's auth-only and still needs a
  database. Supabase is the cleaner single foundation. Auth0/Firebase: heavier / less fit.

## 3. What changes vs. what stays
| Piece | Change? |
|---|---|
| Building/market data (`vantage-data.json`) | **Stays** static & shared (firm-wide, read-only) |
| Client Viewer (`client.html`) | **Same experience** — still passcode-only, no login for prospects |
| Cockpit (`index.html`) | Gains a **login gate**; features become per-broker |
| `BROKER_SECRET` | **Goes away** — being a logged-in broker is what authorizes creating packages |
| Client packages + engagement storage | **Moves** from Netlify Blobs → Supabase (owned by a broker, queryable) |
| Commute function | **Stays** (still holds the Google key server-side) |
| Hosting | **Stays** on Netlify; add a Supabase project alongside |

Migration is cheap because we're early — only a few throwaway test packages exist today,
so we essentially start clean in the database.

## 4. Data model (Supabase / Postgres)
- **profiles** — one per user: name, email, `role` (`broker` | `admin`), active flag.
- **packages** — `slug`, `owner_id`, client name/logo, hashed passcode + salt, the scoped
  buildings, baked commute, created_at. Owner-scoped; public read only via a server
  function (for the passcode-gated viewer).
- **package_events** — append-only engagement: `package_id`, type (`open`/`view`),
  building, timestamp. (Postgres handles concurrent inserts natively — this is a *better*
  home for tracking than Blobs, and the source of that race bug we fixed.)
- **saved_reports** — `owner_id`, name, `config` (shortlist + priorities + filters).
- **clients** *(Phase 3, optional)* — lightweight per-broker client list + notes.

**Roles & access:** brokers see/own only their rows (`owner_id = you`); admin (Andrew)
can see all and manage users. Enforced by database Row-Level Security policies.

## 5. Phased rollout (each phase ships something usable)
- **Phase 0 — Setup:** create the Supabase project, tables, security policies; make
  Andrew the admin; wire Supabase into the Cockpit. *(No visible change yet.)*
- **Phase 1 — Login + accounts:** login gate on the Cockpit; you invite the brokers by
  email; the internal tool is now private. Package creation tied to the logged-in user.
- **Phase 2 — Per-broker data:** packages + engagement live in the database, scoped per
  broker. Each broker's Activity dashboard shows their own clients (replaces the
  per-browser localStorage + Blobs).
- **Phase 3 — Saved reports + admin:** save/reload reports (shortlist + priorities),
  a simple client list, and an admin view for you (all brokers' activity, user management).

## 6. Cost
- **Supabase:** free tier likely covers 6–15 brokers (auth + ~500MB DB is plenty here).
  If you outgrow it, Supabase Pro is ~$25/mo.
- **Netlify:** stays ~$9/mo.
- **Net:** ~$9/mo now; ~$34/mo only if/when you outgrow Supabase's free tier. Modest.

## 7. Decisions needed from you (these shape the build)
1. **Login method:** Do your brokers use **Google Workspace** email (e.g. a havill.co or
   westroyalproperties.com Google account)? If so, **"Sign in with Google"** is smoothest
   (one click, no passwords to manage). Otherwise: email + password, or magic-link email.
2. **Custom domain:** A firm portal deserves a branded URL like **app.havill.co** or
   **vantage.havill.co** (vs. the netlify.app address). Want one? Do you own a domain?
3. **Confirm Supabase** as the foundation (vs. Clerk).
4. **Confirm** dropping `BROKER_SECRET` in favor of login.

## 8. What I'll need you to do (after you approve)
- Create a free **Supabase** account (like we did GitHub/Netlify — I'll guide every click).
- Decide the login method (#1 above).
- Later: hand me the list of broker emails to invite.

## 9. Honest expectations
This is a multi-session build (4 phases), not an afternoon. We'll do it phase by phase,
verifying each on the live site like we have been, so it's never a risky big-bang change.
The current tool keeps working throughout — we layer the portal on, we don't tear down.

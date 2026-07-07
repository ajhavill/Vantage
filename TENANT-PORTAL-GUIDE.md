# Vantage tenant portal — broker's guide

The tenant portal is the **client-facing login side of Vantage**: your client signs in
at `havill-vantage.netlify.app/portal.html` and sees everything you've shared with
them across the whole engagement — deals (tour schedule, proposals with the full
side-by-side analysis, documents, lease abstract with critical dates), their
interactive building shortlists, and their questionnaire.

**Nothing new to manage.** The portal reads through the exact same visibility
controls you already use: the "Shown / Hidden to client" toggles in Deals, and
draft rounds never leave your side. Share something the way you always have, and
the portal updates.

---

## One-time setup (already scripted)
1. Run `supabase/client-portal.sql` in Supabase (or `node tools/run-sql.js supabase/client-portal.sql`).
2. In Supabase → Authentication → URL Configuration, add
   `https://havill-vantage.netlify.app/portal.html` to **Redirect URLs**.

## Onboarding a client (2 minutes)
1. Open their deal in **Deals** → click **Portal** (next to "Share with client").
   - If the deal isn't linked to a HubSpot company yet, the sheet asks you to pick
     one first — that link is what ties everything together.
2. Enter their **email** (and name) → **Invite**. They get a branded email, click
   the link, set a password, and land in their portal.
   - Invite as many people at the company as you like — the CEO, CFO, office
     manager each get their own login. Revoke any one of them without affecting
     the others.
3. Optional: **attach an options package** in the same sheet, so their interactive
   shortlist (dossiers, maps, compare, commute) lives behind the same login.
4. You can also do all of this from the client's page in **Clients** — same
   controls, plus a **Preview** button.

## Day-to-day
- **Sharing:** exactly as before — toggle buildings / tours / proposals /
  documents "Shown to client", mark rounds Final. That IS the portal sync.
- **Telling them:** after sharing something, open the Portal sheet → optional
  note → **Notify client**. Every active portal user at that company gets one
  email pointing at their portal. Nothing ever sends automatically.
- **Seeing it their way:** **👁 Preview** (Portal sheet or Clients hub) opens
  their portal exactly as they see it. Previews are never counted in engagement.
- **Who's engaging:** the deal header now shows portal activity **by person**
  ("jane@client.com 3× (2h ago)") — passcode links only ever showed anonymous
  opens.
- **Excel:** the proposal comparison exports to .xlsx from both your compare view
  and the client's — same net-effective math as on screen.

## Passcode links still work
Portal and passcode links coexist. Keep using quick passcode links for early
prospects; save portal invites for engaged/won clients. Same data, same
visibility rules, one difference: the portal knows who's who.

## Security model (the short version)
- Client accounts are **role `client` with no firm membership** — every
  org-scoped database rule fails closed for them. They can't see comps, tenant
  intel, other clients, or anything of yours.
- Everything they *can* see is served by server functions that filter to
  `client_visible` + final rounds — the same code path the passcode viewers use.
- Documents are served via short-lived signed URLs (private storage bucket).
- A client signing in on the Cockpit or Deals pages is bounced to the portal.

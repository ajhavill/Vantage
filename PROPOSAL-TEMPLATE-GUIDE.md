# Vantage — Letterhead proposal template guide

**Goal:** your firm's Word proposal — *your exact letterhead, fonts, logo, and formatting* —
fills itself with each deal's specifics when you click **"Download in our letterhead."**

You do this by putting small **merge tags** in your Word document wherever a deal-specific
value should go. The app swaps each tag for the real value and hands you a finished `.docx`
that looks 100% like your template.

---

## How to add a tag in Word

1. Open your proposal in **Microsoft Word**.
2. Where a value should appear, type the tag **exactly**, including the curly braces, as
   **plain text** — e.g. type `{client}`.
3. Important: type the braces yourself. Don't insert a "Field" or "Content Control"; it must
   be plain typed text. (If Word "autocorrects" the braces or splits them, retype them.)
4. Tags are **case-sensitive** and have **no spaces inside** — `{base_rent}`, not `{ Base Rent }`.
5. Save as a normal `.docx`.

That's it. You only do this once to your template.

---

## The tags you can use

Put any of these anywhere in your document. Leave out any you don't want — unused values
just come through blank.

| Tag | Fills in | Example |
|---|---|---|
| `{date}` | today's date | June 29, 2026 |
| `{broker}` | the signed-in broker | andrew@westroyalproperties.com |
| `{client}` | the client / company name | Northpoint Analytics, Inc. |
| `{tenant}` | same as `{client}` (alias) | Northpoint Analytics, Inc. |
| `{building}` | the building (or proposal title) | The Water Garden |
| `{rent_structure}` | the rent basis | FSG |
| `{base_rent}` | starting base rent (per SF/yr) | $5.25 |
| `{opex}` | opex / NNN load (per SF/yr) | $12.00 |
| `{gross_rent}` | base + opex (per SF/yr) | $17.25 |
| `{size_sf}` | size | 9,500 |
| `{term_months}` | lease term, months | 60 |
| `{term_years}` | lease term, years | 5.0 |
| `{escalation}` | annual escalation | 3.0% |
| `{free_rent}` | free rent, months | 4 |
| `{ti}` | TI allowance (per SF) | $65.00 |
| `{notes}` | the round's notes | — |
| `{proposal_body}` | the **full AI-written proposal text** (multi-paragraph) | — |

> The values come straight from the **proposal round** you're viewing (plus the deal's
> client and building). So whatever you entered — or the AI filled — on that round is what
> lands in the document.

---

## Two ways to build your template

**A) Your standard language, with tags for the blanks (recommended).**
Keep your firm's standard proposal wording and letterhead, and replace just the variable
bits with tags. For example:

> Dear `{client}`,
>
> On behalf of the Landlord, we are pleased to present this proposal for **`{building}`**
> (`{size_sf}` RSF) on the following terms:
>
> - Term: `{term_months}` months
> - Base Rent: `{base_rent}`/SF/yr, `{rent_structure}`, with `{escalation}` annual increases
> - Free Rent: `{free_rent}` months
> - Tenant Improvement Allowance: `{ti}`/SF
>
> Sincerely, `{broker}`

This gives you a fully on-brand, ready-to-send proposal every time.

**B) Letterhead + the AI's whole write-up.**
If you'd rather the AI write the entire body, put just `{proposal_body}` where the content
should go, under your letterhead. The AI's full draft (from "Draft with AI") drops in there.
(Formatting inside that block is basic; option A gives the most polished result.)

---

## Using it

1. On a proposal, open the draft (**"view proposal"**).
2. Click **⬇ Download in our letterhead**.
3. The first time, you'll pick your `.docx` template — it's remembered on that computer
   after that ("change letterhead" lets you swap it).
4. You get a finished Word doc in your letterhead, ready to review and send.

---

## Send Andrew your template and he'll wire it

Easiest path: **send the `.docx` letterhead** and the team can place the tags for you (and,
if you'd like, set it as the firm default so no one has to pick it). Either way the engine is
already built and tested — it just needs your document.

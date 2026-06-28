# Vantage — deploy & test the client-sharing system

This adds a **Client Viewer** (`client.html`) and a **"Client package"** builder in the
Cockpit (`index.html`). Clients only ever receive their own scoped buildings — the full
market (`vantage-data.json`) is never sent to the viewer, and there is no endpoint that
lists packages or buildings.

---

## 1. Files added / changed

**New — backend (Netlify Functions):**
- `site/netlify/functions/create-package.js` — broker-gated; stores a scoped package in
  Netlify Blobs; passcode stored **hashed** (PBKDF2 + salt); returns the share link.
- `site/netlify/functions/get-package.js` — returns one package only if the passcode
  matches; strips the hash/salt; **no list mode**.
- `site/package.json` — declares `@netlify/blobs` so Netlify installs it for the functions.

**Changed — backend:**
- `site/netlify/functions/commute.js` — now **auth-gated**: callers must send either the
  broker secret OR a valid `{slug, passcode}`; anonymous calls get 401.

**New — front end (shared, one source of truth):**
- `site/public/assets/vantage.css` — the design system, extracted from `index.html`.
- `site/public/assets/vantage-view.js` — the shared dossier / amenity-map / commute engine.
- `site/public/client.html` — the passcode-gated, co-branded, read-only Client Viewer.

**Changed — front end:**
- `site/public/index.html` — now links `assets/vantage.css`; adds the **"Client package"**
  button + builder modal (scoped multi-select up to 15, client name/logo, passcode,
  broker secret remembered locally → creates the link).

---

## 2. Environment variables (Netlify → Site settings → Environment variables)

| Variable | Value | Used by |
|---|---|---|
| `GOOGLE_ROUTES_KEY` | your Google key (Routes + Geocoding APIs enabled) | commute |
| `BROKER_SECRET` | any long random string **you** choose | create-package, and to authorize commute from the Cockpit |

- The **broker secret** is whatever you set here. You'll type the same value into the
  Cockpit's "Client package" form (it's remembered in your browser after the first time).
- Keep a **daily quota cap** on the Google key in Google Cloud as a cost backstop.
- ⚠️ The Google key you pasted in chat should be **regenerated** in Google Cloud — only the
  new value goes in `GOOGLE_ROUTES_KEY`. Never put a key in the code.

---

## 3. Netlify Blobs

Nothing to enable manually. On a current Netlify site, **Blobs works automatically** for
deployed functions — `getStore("client-packages")` just works. (Blobs only runs on the
deployed site, not in local file preview.)

---

## 4. Deploy (functions need a build, so a drag-drop of files alone won't install them)

### Recommended — GitHub + Netlify (auto-deploys on every push)
1. Create an **empty** repo at https://github.com/new (e.g. `vantage`, private).
2. In a terminal in this folder, connect and push (the local commit already exists):
   ```
   git remote add origin https://github.com/<you>/vantage.git
   git branch -M main
   git push -u origin main
   ```
3. In Netlify: **Add new site → Import an existing project → GitHub →** pick the repo.
4. Set **Base directory = `site`** (important — that's where `netlify.toml`/`package.json` live).
   Leave build command empty; publish stays `public`. Deploy.
5. Add the two **environment variables** (section 2), then **Trigger deploy → Deploy site**.

### Alternative — Netlify CLI (no GitHub)
From this folder:
```
npm i -g netlify-cli
netlify login
netlify deploy --build --prod --dir site/public --functions site/netlify/functions
```
(Then set the env vars in the Netlify dashboard and redeploy.)

---

## 5. Test it (as you, then as a client)

1. Open your deployed Cockpit: `https://<your-site>.netlify.app/`
2. Click **"Client package"** (top right).
3. Tick a few buildings, enter a **Client name**, set a **Passcode**, and enter your
   **Broker secret** (the `BROKER_SECRET` value). Click **Create link**.
4. Copy the **link** and the **passcode**.
5. Open the link in a **private/incognito window** (to prove no prior state leaks).
   - Enter the **wrong** passcode → it's rejected.
   - Enter the **right** passcode → you see **only** the buildings you picked, co-branded
     "Prepared for <Client name>".
6. Open a building → the read-only dossier (spaces, tenants, neighborhood + amenity map).
7. Go to **Commute**, paste a couple of home addresses, **Calculate** → drive times per
   building (this confirms the guarded commute function accepts the viewer's slug+passcode).

If the commute step errors with "can't reach server", you're testing the file preview, not
the deployed site — commute only runs on Netlify.

---

## Security model (as built)
- The viewer is scoped **by data**, not by hidden UI: its package contains only the chosen
  buildings. It never loads `vantage-data.json`.
- No endpoint lists packages or buildings.
- Passcodes are stored hashed (PBKDF2 + per-package salt), compared in constant time.
- `create-package` requires the broker secret; `commute` requires broker secret OR a valid
  slug+passcode. Keys/secrets live only in Netlify env vars.

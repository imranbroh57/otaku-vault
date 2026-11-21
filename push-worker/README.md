# Otaku Vault — Push Helper (Cloudflare Worker)

A tiny free server that makes Otaku Vault's **push notifications** work. Once a
day it checks AniList for the shows each subscriber is watching; when a new
episode has aired it sends a Web Push to their phone — even when Otaku Vault
is closed.

The in-app bell (🔔) does **not** need this. This helper is only for real
phone notifications, and only the **website** can receive them (the HopWeb app
cannot, so the app uses the bell only).

Everything here runs on Cloudflare's free tier. One-time setup, about 10
minutes.

## What you need first

1. A free Cloudflare account (cloudflare.com).
2. A VAPID key pair (step 1 below) — this is how the push services know the
   notifications really come from your site.

## Step 1 — Generate a VAPID key pair

Pick ONE way:

- **Easiest (online):** open a free VAPID generator, e.g.
  https://vapidkeys.com — it shows a **Public Key** and a **Private Key**.
- **Or with Node.js on any computer/Termux:**
  `npx web-push generate-vapid-keys`
  It prints the same two keys.

Keep the private key secret — never put it in the website code or in GitHub.

## Step 2 — Create the KV namespace

In the Cloudflare dashboard: **Storage & Databases → KV → Create namespace**,
name it `otaku-vault-subs`. Copy its **ID**.

(Or with wrangler: `npx wrangler kv namespace create SUBS` and copy the id.)

## Step 3 — Create the Worker

1. Dashboard: **Workers & Pages → Create → Create Worker**, name it
   `otaku-vault-push`, deploy the starter.
2. Open **Edit code**, delete the starter code, paste in all of `worker.js`
   from this folder, and deploy again.
3. Worker → **Settings → Variables and Secrets**, add:
   - `VAPID_PUBLIC_KEY` — **Text** — the public key from step 1.
   - `VAPID_PRIVATE_KEY` — **Secret** — the private key from step 1.
   - `VAPID_SUBJECT` — **Text** (optional) — e.g. `mailto:you@example.com`.
4. Worker → **Settings → Bindings → Add → KV namespace**:
   variable name `SUBS`, namespace `otaku-vault-subs` (from step 2).
5. Worker → **Settings → Triggers → Cron Triggers → Add**: `0 3 * * *`
   (runs the episode check once a day at 03:00 UTC).

> Using wrangler instead? Edit `wrangler.toml` in this folder (paste the KV
> namespace id into it), set the private key with
> `npx wrangler secret put VAPID_PRIVATE_KEY`, add the two plain variables in
> the dashboard, then run `npx wrangler deploy`.

Your Worker URL will look like:
`https://otaku-vault-push.<your-subdomain>.workers.dev`
Open it in a browser — it should say "Otaku Vault push worker is running."

## Step 4 — Paste two values into the website

Open `index.html` (repo root), find the **Push config** block near the top of
the main script, and replace the two placeholders:

```js
const VAPID_PUBLIC_KEY = 'PASTE_VAPID_PUBLIC_KEY_HERE';   // <- your VAPID public key
const PUSH_WORKER_URL = 'https://your-worker.example.com'; // <- your Worker URL
```

Upload the updated `index.html` to GitHub as usual. Done!

## Step 5 — Turn it on (each phone, once)

1. Open the Otaku Vault website on the phone.
2. ⚙️ Settings → **Push Notifications → Enable** → allow notifications.
3. From then on, new episodes of shows in **Watching** trigger a push once a
   day when the check runs. The phone re-sends its watching list to the
   helper whenever the site is opened, so new shows are picked up
   automatically.

## Notes & limits

- The check runs **once a day**, so a push can arrive up to a day after an
  episode airs. The in-app bell is always up to date the moment you open the
  app.
- Up to 50 watching titles per subscriber are checked.
- If a phone's push subscription expires, the helper deletes it by itself;
  just tap **Enable** again in Settings.
- No personal data is stored: only the push subscription (an anonymous
  endpoint given by the browser) and AniList title IDs.

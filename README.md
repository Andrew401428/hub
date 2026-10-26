# Hub

Calendar + checklists + wishlist in one page. Works on phone and desktop, free, syncs between them.

- `index.html` is the whole app (vanilla JS, no build step). `sw.js` + `manifest.webmanifest` make it installable.
- Data lives in the browser (localStorage) and, once connected, in a `hub_docs` table in Supabase.
- `pricebot/price_check.py` finds the cheapest trusted-store price for wishlist items (runs on GitHub Actions).

## One-time setup (about 15 minutes)

### 1. Host it (GitHub Pages, free, unlimited deploys)
1. Create a public GitHub repo called `hub`, push this folder to branch `main`.
2. Repo > Settings > Pages > Deploy from a branch: `main`, folder `/ (root)`. Every push republishes in about a minute.
3. The app is then at `https://<you>.github.io/hub/`.

Nothing private is in the repo: sync keys are typed into Settings on each device and stay in that device's storage.

### 2. Sync (own Cloudflare worker, see worker/README.md; Supabase still works as a fallback)
1. Supabase > SQL editor > paste `supabase/setup.sql`, replace both `CHANGE-ME` with your own secret word, run it.
2. Project Settings > API: copy the Project URL and the `anon` key.
3. In Hub > Settings > Sync enter URL, anon key, secret word > Connect. Do this on every device.

Edits upload within a second and other devices pick them up within 5 s while open.

### 3. Install on devices
- iPhone: open the URL in Safari > Share > **Add to Home Screen**. Opens full screen, notifications allowed once added.
- Desktop: open in Chrome/Edge > address bar install icon (or menu > "Install Hub"). It becomes its own window.

### 4. Price bot (optional)
1. Get a free SerpApi key (serpapi.com, 100 searches/month).
2. Repo > Settings > Secrets and variables > Actions, add: `HUB_URL` (the worker address), `HUB_SECRET`, `SERPAPI_KEY`.
3. The `price bot` workflow (`.github/workflows/prices.yml`) wakes every 15 minutes once those secrets exist (GitHub sometimes delays
   scheduled runs, and pauses schedules after 60 days without a push). It can also be run by hand from the Actions tab.
4. In Hub > Settings > Price bot you set the re-check interval in minutes, searches per run, the monthly search budget
   (the bot stops for the month when it is used up, so the free tier is never exceeded), tax rate and trusted stores.

Run locally instead: put the four values in `pricebot/.env` and `python pricebot/price_check.py` (`--dry` to only print).

## Reminders, honestly
Browsers cannot fire a scheduled notification while the app is closed. So:
- While Hub is open (desktop window, or phone app in foreground), it fires a notification + toast at the reminder time.
- For guaranteed phone alerts press **Google Calendar** on an event (one tap, adds it with the repeat rule) or download the `.ics` once and import it. Google then reminds you everywhere.

## Updating
Edit `index.html`, bump `APP_VERSION` and add a `CHANGELOG` line, push. Pages redeploys in about a minute; installed copies pick it up on next open (network-first service worker).

## Data model
Every record is a doc `{id, data}`: `list:<id>` `{title, items:[{id,text,done}]}`, `wish:<id>` `{name, by, qty, budget, note, query, done}`,
`event:<id>` `{title, date, start, end, loc, note, remind, repeat, until, cat}`, `price:<wishId>` (bot output), `settings:pricebot`, `meta:pricebot`.
Deleting writes `{deleted:true}` so other devices drop it too. Settings > Data exports/imports the whole set as JSON.

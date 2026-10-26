# Hub sync worker

Tiny document store on Cloudflare Workers + D1 (free plan, no download charges).

One-time setup (Claude runs 1, 2, 3 and 5 once you are logged in):

1. `npx wrangler login`
2. `npx wrangler d1 create hub` and paste the database_id into wrangler.toml
3. `npx wrangler d1 execute hub --remote --file=schema.sql`
4. `npx wrangler secret put HUB_SECRET` (you type your secret word at the prompt)
5. `npx wrangler deploy` prints the address, e.g. https://hub-sync.<you>.workers.dev

Then in Hub > Settings > Sync enter that address and the secret word on every device.
For the price bot add repo secrets HUB_URL (the address) and HUB_SECRET.

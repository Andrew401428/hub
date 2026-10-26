"""Hub price bot.

Reads wishlist items from Supabase, searches Google Shopping (via SerpApi, free tier
100 searches/month), keeps only offers from trusted stores, adds estimated sales tax and
the listed shipping, and writes the cheapest offers back as price:<wishId> docs that the
Hub app shows under each wishlist item.

Env vars (GitHub Actions secrets or a local .env):
  SUPABASE_URL, SUPABASE_ANON_KEY, HUB_SECRET, SERPAPI_KEY
Optional: MAX_SEARCHES (per run, default 3) to stay inside the free tier.

Usage:  python price_check.py            # normal run
        python price_check.py --dry      # search but do not write
        python price_check.py --force    # ignore recheck_days
"""
import json, os, re, sys, time, urllib.parse, urllib.request
from datetime import datetime, timezone, timedelta

DRY = "--dry" in sys.argv
FORCE = "--force" in sys.argv

def env(k, default=None):
    v = os.environ.get(k, default)
    if v is None:
        sys.exit(f"missing env {k}")
    return v

# .env support for local runs
if os.path.exists(os.path.join(os.path.dirname(__file__), ".env")):
    for line in open(os.path.join(os.path.dirname(__file__), ".env"), encoding="utf-8"):
        if "=" in line and not line.strip().startswith("#"):
            k, v = line.strip().split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"'))

SUPA = env("SUPABASE_URL").rstrip("/")
KEY = env("SUPABASE_ANON_KEY")
SECRET = env("HUB_SECRET")
SERP = env("SERPAPI_KEY")
MAX_SEARCHES = int(os.environ.get("MAX_SEARCHES", "3"))

DEFAULT_STORES = ["Amazon.com", "Walmart", "Target", "Best Buy", "Costco", "Home Depot", "Lowe's", "B&H Photo",
                  "Newegg", "Micro Center", "REI", "Dick's Sporting Goods", "Apple", "Staples", "Office Depot",
                  "Kohl's", "Macy's", "Nike", "Adidas", "GameStop", "Chewy", "Petco", "Sam's Club",
                  "Academy Sports", "Backcountry"]


def supa(path, method="GET", body=None, prefer=None):
    headers = {"apikey": KEY, "Authorization": "Bearer " + KEY, "x-hub-secret": SECRET, "Content-Type": "application/json"}
    if prefer:
        headers["Prefer"] = prefer
    req = urllib.request.Request(SUPA + "/rest/v1/" + path, method=method, headers=headers,
                                 data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=30) as r:
        t = r.read().decode()
        return json.loads(t) if t else None


def upsert(doc_id, data):
    if DRY:
        print("  [dry] would write", doc_id, json.dumps(data)[:200])
        return
    supa("hub_docs?on_conflict=id", "POST", [{"id": doc_id, "data": data}], prefer="resolution=merge-duplicates,return=minimal")


def norm(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def store_ok(source, stores):
    s = norm(source)
    for t in stores:
        n = norm(t)
        if not n:
            continue
        if s == n or s.startswith(n) or (len(n) >= 5 and n in s):
            return True
    return False


def parse_ship(text):
    """'Free delivery' -> 0.0, '$5.99 delivery' -> 5.99, unknown -> None."""
    if not text:
        return None
    t = text.lower()
    if "free" in t:
        return 0.0
    m = re.search(r"\$\s*(\d+(?:\.\d+)?)", t)
    return float(m.group(1)) if m else None


def search(query):
    q = urllib.parse.urlencode({"engine": "google_shopping", "q": query, "gl": "us", "hl": "en", "num": 40, "api_key": SERP})
    with urllib.request.urlopen("https://serpapi.com/search.json?" + q, timeout=40) as r:
        return json.loads(r.read().decode())


def offers_for(item, cfg):
    query = (item.get("query") or item.get("name") or "").strip()
    if not query:
        return None, []
    res = search(query)
    tax = float(cfg.get("tax_pct", 7.5)) / 100
    stores = cfg.get("stores") or DEFAULT_STORES
    qty = max(1, int(item.get("qty") or 1))
    out = []
    for r in res.get("shopping_results", []) + res.get("inline_shopping_results", []):
        price = r.get("extracted_price")
        src = r.get("source") or r.get("seller") or ""
        if price is None or not store_ok(src, stores):
            continue
        ship = parse_ship(r.get("delivery") or r.get("shipping"))
        unit_tax = round(price * tax, 2)
        total = round((price + unit_tax) * qty + (ship or 0), 2)
        out.append({"store": src, "title": r.get("title", "")[:120], "price": price, "ship": ship, "tax": unit_tax,
                    "total": total, "qty": qty, "link": r.get("product_link") or r.get("link") or "",
                    "rating": r.get("rating"), "reviews": r.get("reviews"), "ship_known": ship is not None})
    # cheapest first; offers with unknown shipping sort after known ones at the same total
    out.sort(key=lambda o: (o["total"], not o["ship_known"]))
    # one offer per store, top 5
    seen, top = set(), []
    for o in out:
        k = norm(o["store"])
        if k in seen:
            continue
        seen.add(k)
        top.append(o)
        if len(top) == 5:
            break
    return query, top


def main():
    rows = supa("hub_docs?select=id,data&or=(id.like.wish:*,id.like.price:*,id.eq.settings:pricebot)")
    docs = {r["id"]: r["data"] for r in rows}
    cfg = docs.get("settings:pricebot") or {}
    recheck = timedelta(days=float(cfg.get("recheck_days", 3)))
    now = datetime.now(timezone.utc)
    wishes = [(k, v) for k, v in docs.items() if k.startswith("wish:") and not v.get("deleted") and not v.get("done")]
    # soonest need-by first, then oldest check first
    def prio(kv):
        k, v = kv
        p = docs.get("price:" + k[5:]) or {}
        return (v.get("by") or "9999-99-99", p.get("checked_at") or "")
    wishes.sort(key=prio)
    print(f"{len(wishes)} open wishlist items, max {MAX_SEARCHES} searches")
    searched = 0
    for k, v in wishes:
        if searched >= MAX_SEARCHES:
            break
        p = docs.get("price:" + k[5:]) or {}
        if not FORCE and p.get("checked_at"):
            last = datetime.fromisoformat(p["checked_at"].replace("Z", "+00:00"))
            if now - last < recheck and p.get("query") == (v.get("query") or v.get("name")):
                print(f"- {v.get('name')}: checked {p['checked_at'][:16]}, skip")
                continue
        try:
            query, top = offers_for(v, cfg)
        except Exception as e:  # keep going on one bad search
            print(f"- {v.get('name')}: search failed: {e}")
            continue
        searched += 1
        best = top[0] if top else None
        print(f"- {v.get('name')}: {len(top)} trusted offers" + (f", best {best['store']} ${best['total']}" if best else ""))
        upsert("price:" + k[5:], {"query": query, "offers": top, "checked_at": now.isoformat(), "title": best["title"] if best else ""})
        time.sleep(1)
    upsert("meta:pricebot", {"ran_at": now.isoformat(), "note": f"{searched} searched, {len(wishes)} open"})


if __name__ == "__main__":
    main()

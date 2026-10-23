# Edge Mode: Cloudflare Workers

Edge mode is for **BYO CDN on Cloudflare** only (the Adobe-managed CDN runs no custom code). It is an
upgrade on top of client mode, which stays installed. It decides `rules`, `api` and `split`
sections before the HTML leaves the CDN and renders the variant into the section, so nothing is
hidden or swapped in the browser: the right place for a personalized **first section** (LCP).
`target` sections and site-registered providers always stay in the browser. Like the pipeline, it
needs Section Metadata rendered as section attributes (rendering v2, `authoring-model.md`).

## Generate

```bash
node scripts/install-edge.mjs <project> \
  [--dir cdn/cloudflare-worker] [--name <worker>] [--origin main--<repo>--<owner>.aem.live] \
  [--route www.example.com/*] [--account <cloudflare account id>] [--dry-run]
```

- `src/aem-worker.mjs`: official `adobe/aem-cloudflare-prod-worker`, vendored **unchanged**
  (Apache-2.0, `LICENSE_APACHE`). Upgrade by re-vendoring, never edit.
- `src/index.mjs`: wrapper that adds the decision route and post-processes HTML.
- `src/personalization/`: `personalize.js`, `html.js` (skill); `rules.js`, `section-spec.js`,
  `contract.js`, `context.js`, `provider-api.js`, `sources/api.js`, `sources/split.js` (copied
  unchanged from `scripts/personalization/`: re-run install-edge after updating them);
  `edge-config.js` (site-owned).
- `src/index.mjs` builds `fetchFragment(path)` on the official worker
  (`aemWorker.fetch` of `<path>.plain.html`, same host), so fragments use the same origin, auth and
  cache settings as pages.
- `wrangler.toml` from the template: `name` after the repo, `workers_dev = true`, `ORIGIN_HOSTNAME`
  inferred from the git remote; `route` and `account_id` stay commented out until given.
- The worker dir's top folder is added to `.hlxignore` so it is not served by EDS.

**Existing worker** (`--existing <dir>`): only `src/personalization/` is added and the wrap
instructions are printed. Apply the wrap to the entry point and show the diff in the summary:

```js
import config from './personalization/edge-config.js';
import { handleApiRoute, personalizeResponse } from './personalization/personalize.js';

// inside fetch(request, env, ctx), before the origin fetch:
const routed = await handleApiRoute(request, env, config);
if (routed) return routed;
// after the existing logic produced `response`; originFetch = the worker's own origin fetch
const fetchFragment = (path) => originFetch(new URL(`${path}.plain.html`, request.url));
return personalizeResponse(request, response, { config, env, cf: request.cf, ctx, fetchFragment });
```

Without `fetchFragment`, sections that would show a variant are left to the browser (sections
decided to the default still work).

## Request flow

1. `POST /pzn/decide` (configurable `apiRoute`) is proxied to `PZN_API_ENDPOINT` with
   `Authorization: Bearer $PZN_API_KEY`. Only same-origin v1 requests with the `pzn-consent`
   cookie are forwarded, as a body rebuilt from contract fields; `edge-config.js` adapters then
   translate it. Errors: 405 non-POST, 503 not configured, 403 cross-origin or no consent, 429
   rate limited (`PZN_RATE_LIMITER` binding, see `wrangler.toml`), 413 > 16 KB, 400 not a v1
   request, 502 `{ "decisions": {} }` when the engine fails. Point the browser
   `config.api.endpoint` here, with no browser adapters, so the key never reaches the browser.
2. Everything else goes through the official worker (origin fetch, **cache key unchanged**).
3. HTML 200 GET responses (not `.plain.html`) with personalized sections are post-processed:
   - context: `cf.country` / `cf.regionCode`, cookies (`pzn-seen`, `pzn-vs`, `pzn-consent`,
     `pzn-split`), URL params; device, state and audiences are unknown at the edge;
   - one engine call for the page's `api` sections (300 ms budget, only with the
     `pzn-consent` cookie unless `sendWithoutConsent`), cached in the Cache API when the response is
     `cacheable` with `ttl > 0`;
   - each `rules` / `api` / `split` section is decided with `section-spec.js` (engine answer →
     Rule rows → authored content; `split`: the `pzn-split` cookie or a new draw). A variant's
     `.plain.html` is fetched within `fragmentTimeout` (1000 ms), its sections' children (without
     its Section Metadata) replace the section's children, and relative `src` / `srcset` / `href`
     are rewritten against the fragment path. The section gets
     `data-pzn-source="edge" data-pzn-variant data-pzn-fragment data-pzn-status="applied"`; a
     default decision keeps the authored content and is marked the same way;
   - left to the browser: invalid sections, `target` and provider sections, sections already
     carrying `data-pzn-source`, sections whose first possibly-matching rule needs
     device/state/audience, `api` sections with no engine answer and no matching rule, and any
     section whose fragment fails or times out;
   - a new split assignment is sent as `Set-Cookie: pzn-split=…; Path=/; SameSite=Lax; Secure`;
   - `<meta name="pzn-geo">` is injected when any rule uses geo, so the browser agrees for deferred
     sections;
   - headers: `Cache-Control: private, no-cache`, `ETag` and `Content-Length` removed,
     `x-pzn: edge | deferred`.
4. Bots (`cf.botManagement.verifiedBot` or a UA match, including Lighthouse/PSI) get the authored
   content, with no engine call and no split cookie.
5. Requests with preview overrides (`?pzn…`, except `?pzn-debug`) leave everything to the browser
   (when `edge-config.overrides` allows them; default `never`).
6. Any processing error serves the origin HTML unchanged.

The browser runtime sees `data-pzn-source="edge"` on a section, shows it at once and never decides
it again in that page view (a `split` section still reports the RUM `experiment` checkpoint).
Deferred sections are decided in the browser as usual.

## Configuration

`edge-config.js`: `fragmentPrefixes`, `botsGetDefault`, `overrides`, `fragmentTimeout` (1000),
`api` (`endpoint`, `timeout` 300, `sendWithoutConsent`, `headers(env)`, `mapRequest`,
`mapResponse`), `apiRoute` (`/pzn/decide`). Keep prefixes and bot policy identical to `config.js`. `wrangler.toml` `[vars] PZN_API_ENDPOINT` overrides
`api.endpoint`. Secrets only via `wrangler secret put`.

## Local test

```bash
# Edge logic over any HTML (preview or local), faking request.cf and the UA:
node scripts/simulate.mjs https://main--<repo>--<owner>.aem.page/<page> --edge --country IN
node scripts/simulate.mjs content/<page>.html --edge --repo <project> --country US --region CA --cookie "pzn-seen=1"
node scripts/simulate.mjs https://main--<repo>--<owner>.aem.page/<page> --edge --ua Googlebot

# The real worker (origin must be main--*--*.aem.live, so use https locally):
cd <project>/cdn/cloudflare-worker
npx wrangler dev --local-protocol https
curl -sk -D - -o /dev/null https://localhost:8787/
curl -sk -XPOST https://localhost:8787/pzn/decide -d '{}'     # 503 until PZN_API_ENDPOINT is set, then 403 (no Origin)
curl -sk -XPOST https://localhost:8787/pzn/decide -H 'origin: https://localhost:8787' \
  -H 'cookie: pzn-consent=1' -d '{"version":"1","placeholders":[{"id":"offer","candidates":["default"]}],"context":{"consent":{"personalization":true}}}'
npx wrangler deploy --dry-run --outdir /tmp/pzn-worker           # bundle check, no upload
```

Pages only reach `aem.live` after publish, so before publish rely on `simulate.mjs --edge` (with
`--repo`, local `content/` serves the fragments). Expected: `x-pzn: edge` with the right
`data-pzn-variant` per section, the Googlebot run shows the authored content, a split run sets
`pzn-split`, `cache-control: private, no-cache`.

## Deploy handoff (never run without an explicit request)

Log in first: a non-interactive `wrangler login` always fails. Hand the user an interactive login
(in Claude Code, `! npx wrangler login`) or have them set `CLOUDFLARE_API_TOKEN` (and
`CLOUDFLARE_ACCOUNT_ID`) up front. Uncomment `route` and `account_id` in `wrangler.toml`.

```bash
npx wrangler secret put PZN_API_KEY          # only with a decision engine
npx wrangler secret put ORIGIN_AUTHENTICATION  # only for protected sites
npx wrangler deploy
```

Then follow the AEM BYO CDN Cloudflare setup (route, push invalidation, `X-Forwarded-Host`) and
verify on production with a non-bot browser and with `curl -A Googlebot`.

# Decision Engine API Contract (v1)

Used by sections with `Personalization Source | api`. One batched request per page in the browser
(`sources/api.js`, every api section of the page) or per response at the edge. Implemented by `contract.js` (shared),
`provider-api.js` (transport and session cache) and `personalize.js` (edge transport).

```
| Section Metadata               |                                                  |
| Personalization                | promo                                            |
| Personalization Source         | api                                              |
| Personalization Variants       | /fragments/personalization/promo/festive         |
|                                | /fragments/personalization/promo/clearance       |
| Personalization Rule Festive   | param: utm_campaign=diwali     (fallback, optional) |
```

The Variants are the engine's allowlist; Rule rows are optional and only decide when the engine
cannot (error, no consent, no answer). The section's authored content is the control.

## Request

```http
POST <endpoint>
Content-Type: application/json

{
  "version": "1",
  "page": { "path": "/home", "locale": "en-IN" },
  "placeholders": [
    { "id": "home-hero", "candidates": ["india", "na-mobile", "default"] }
  ],
  "context": {
    "geo": { "country": "IN", "region": "KA" },
    "device": "mobile",
    "visitor": "returning",
    "state": { "quiz-persona": "cn" },
    "params": { "utm_campaign": "diwali" },
    "consent": { "personalization": true }
  },
  "mode": "client"
}
```

- `candidates`: the section's listed variant names (with or without a Rule row) plus `default`.
- `params`: only `utm_*` and keys referenced by `param:` rules; other URL params are never sent.
- Without consent: `state` is dropped, and `visitor` is dropped unless a rule uses it. By default
  the engine is **not called at all** without consent (`sendWithoutConsent: false`).
- `mode`: `client` or `edge`. At the edge `device`, `state` and audiences are unknown.
- No PII: never add emails, names or IDs to the context in an adapter.

## Response

```json
{
  "decisions": {
    "home-hero": { "variant": "india", "tracking": { "activity": "A123", "experience": "B" } },
    "promo": { "fragment": "/fragments/personalization/promo/engine-pick" },
    "banner": { "variant": null }
  },
  "ttl": 300,
  "cacheable": true
}
```

| Field | Meaning |
|---|---|
| `variant: "<name>"` | Must name a listed variant (or `default`) |
| `fragment: "<path>"` | Must be a listed variant's path |
| `variant: null` | Control: the authored content (exposure still tracked, source `api`) |
| unlisted variant / fragment | Sections: authored content, `data-pzn-source="fallback"`, reason `not listed: <x>` |
| id missing | The Rule rows decide, then the authored content |
| `tracking` | Opaque object passed to `personalization:applied` / data layer |
| `ttl` | Seconds, default 300, capped at 1800 |
| `cacheable` | Edge only: response may be cached in the Cache API for identical contexts |

## Timeouts and fallback

| Where | Budget | On failure |
|---|---|---|
| Browser, first section | 800 ms (`budgets.eager`), decision **and** fragment | Non-2xx, bad JSON, no endpoint, no consent: the Rule rows, else the authored content (`fallback`, reason e.g. `HTTP 500`). Budget exceeded: the authored content (`timeout`) |
| Browser, other sections | 2000 ms (`budgets.lazy`) | Same |
| Edge | 300 ms (`edge-config.api.timeout`) | The Rule rows at the edge; when no rule matched either, the section is left to the browser, which may still ask the engine |
| Edge route `/pzn/decide` | 2000 ms | 502 `{ "decisions": {} }` → browser fallback; 400 non-v1, 403 cross-origin or no consent, 429 rate limited |

The browser request itself is aborted at the largest budget of the batch + 250 ms, so a slow engine
ends at `timeout` for sections; only a failing engine reaches the Rule rows. Every path ends at the
authored content. Nothing waits indefinitely.

## Caching

- Browser: sessionStorage (`pzn-decisions:<hash>`), keyed by page, placeholders and context,
  for `ttl` seconds, only with consent.
- Edge: Cache API keyed by a SHA-256 of the same key, only when `cacheable: true`.
- The page HTML is never cached per visitor (`Cache-Control: private, no-cache` at the edge).

## Endpoint and secrets

The browser endpoint should be **same-origin**: the edge route (`/pzn/decide`) or a CDN proxy
path. It avoids a second-origin connection before LCP and keeps API keys off the client. A public,
keyless, CORS-enabled engine URL works but costs LCP; say so.

The edge route is reachable by anyone, so it forwards only: same-origin requests (`Origin` /
`Sec-Fetch-Site`), with the `pzn-consent` cookie and `consent.personalization: true` (unless
`sendWithoutConsent`), and bodies that are v1 requests, rebuilt from contract fields (≤ 16 KB, ≤ 20
placeholders). Scripts can fake headers, so add the `PZN_RATE_LIMITER` binding for production.

## Adapters for non-v1 engines

Both `config.js` (browser) and `edge-config.js` (edge) accept the adapters, but use them in one
place per path: when the browser calls the edge route, it speaks v1 and the adapters live in
`edge-config.js` only (the route answers v1 and rejects non-v1 requests with 400). Browser
adapters are for a CDN proxy or a direct engine URL.

```js
api: {
  endpoint: '/api/orchestrator',
  // v1 request -> { url?, init?, body }. init merges into fetch init (method, headers).
  mapRequest: (v1) => ({
    body: {
      slots: v1.placeholders.map((p) => p.id),
      country: v1.context.geo?.country,
      utm: v1.context.params,
    },
  }),
  // engine JSON -> v1 response
  mapResponse: (json) => ({
    decisions: Object.fromEntries((json.slots || []).map((s) => [s.id, { fragment: s.path, tracking: s.meta }])),
    ttl: json.maxAge ?? 300,
  }),
},
```

- A `GET` engine: return `{ url: `${endpoint}?…`, init: { method: 'GET' } }`; the body is dropped.
- Generate adapters from the user's **sample request and response**, then check them offline:
  `mapResponse(sample)` must pass `parseResponse` (from `contract.js`) and produce the expected
  variants. Keep vendor shapes out of `rules.js` and the runtime.

## Testing with the mock

Two ways, same tables (`mock-engine.js`):

- In the browser, for demos on aem.page and for `verify-preview.mjs --faults`: set
  `config.mock = { api: <decisions.json content> }` with a non-empty `api.endpoint`; the in-browser
  mock answers that path (`?pzn-mock-latency=3000`, `?pzn-mock-fail` on preview hosts).
- A local server:

```bash
node scripts/mock-decision-api.mjs --port 4100 --decisions decisions.json [--latency 3000] [--fail 500] [--invalid] [--ttl 60] [--cacheable]
```

`decisions.json` maps each section id to conditions in the authoring grammar (or `"*"`), checked in
order against the request context; the value is a variant name, `null` (control) or a decision
object. A section with no match is left out of the answer (so its Rule rows decide):

```json
{ "ttl": 60, "cacheable": true,
  "placeholders": { "promo": { "param: utm_campaign=diwali": "festive", "geo: US": null } } }
```

`GET /requests` returns the bodies received (check consent and param filtering), `DELETE /requests`
clears them, `GET /health` checks liveness. Use `simulate.mjs --api-decisions decisions.json` and
`verify-preview.mjs --api-decisions decisions.json` for the same expectations.

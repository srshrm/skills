# Preview and Testing

## Preview overrides

Enabled when `config.overrides` is `preview` (default: `*.aem.page`, `*.hlx.page`, localhost) or
`always`. They win over bot detection, so headless test browsers can see variants.

| Param | Effect |
|---|---|
| `?pzn=home-hero:india,offer:default` | Force variants per section (any source: a `target` offer is shown without calling Target, a `split` variant without an assignment). `default` = the authored content |
| `?pzn-geo=IN` / `US-CA` | Fake geo |
| `?pzn-device=mobile` | Fake device class |
| `?pzn-visitor=returning` | Fake visitor |
| `?pzn-state=quiz-persona:cn,step:2` | Fake state |
| `?pzn-audience=logged-in,vip` | Force custom audiences to match |
| `?pzn-consent=1` / `0` | Fake the CMP's answer: storage, engine and Target calls behave as with/without consent |
| `?pzn-mock-latency=3000` | With `config.mock`: delay every mocked answer (default 250 ms) |
| `?pzn-mock-fail` | With `config.mock`: mocked answers are HTTP 500 |
| `?pzn-debug` | Console table: id, variant, source, reason, ms, popup status, notifications. Logging only: not an override, so edge decisions and bot detection stay as visitors get them |

At the edge, any `pzn…` param except `pzn-debug` (when `edge-config.overrides` allows them;
default `never`) makes the worker leave every section to the browser.
`window.hlx.personalization.decisions` holds the same rows as the debug table.

## Local preview

`aem up` (aem-cli 16.21+) serves the local `content/` tree first and proxies the rest: a page is
`http://localhost:3000/<page>` from `content/<page>.html`, and fragments resolve at their real
paths (`/fragments/personalization/<id>/<variant>.plain.html` from
`content/fragments/personalization/<id>/<variant>.html`), so a variant renders before anything is
uploaded. Restart `aem up` when a new file is not picked up.

Section Metadata becomes `data-personalization*` attributes only through the pipeline (rendering
v2) or an `aem.js` that reads it client-side (`authoring-model.md` § Rendering prerequisite). If
`verify-preview.mjs` reports `section not found`, check the hooks and how the site renders
Section Metadata before anything else.

## Scripts

| Script | Purpose |
|---|---|
| `validate-placeholders.mjs [files\|dirs] --repo . [--base-url] [--json]` | Renders source content as the pipeline does, then checks: grammar, unique ids, repeated rows (only the last value survives; number rules: `Rule India 2`), multi-paragraph rule cells, experimentation overlap, fragment prefixes and existence, nesting, `TODO:` copy, H1 vs the authored content, registered audiences, source config (empty `api.endpoint` / `target.clientCode` without `mock`; providers read from `config.js`), first-section LCP. Info: split weights, popup trigger, browser-only criteria, state keys. Exit 1 on errors |
| `simulate.mjs <page> [--matrix] [--api-decisions] [--target] [--consent] [--page-url] [--json]` | Expected outcome per section and case, with the `?pzn…` URL that reproduces it: `rules` from the Rule rows; `api` from the mock table, else the Rule rows (no consent); `split` the `allowed` variants; `target` the mock activities, else the authored content (`waiting for consent` for popups). One forced case per variant and a bot case for every section. `--api-decisions` / `--target` add `pzn-consent=1` to those cases; `--consent` to every non-bot case |
| `simulate.mjs <page\|url> --edge [--country --region --cookie --ua --api-endpoint --repo]` | Edge worker output and headers; source content is rendered first, fragments come from local `content/` (`--repo`) or the origin |
| `verify-preview.mjs --page <url> [--file\|--cases] [--matrix] [--api-decisions] [--target] [--consent] [--faults] [--split-runs N] [--baseline] [--revisit] [--screenshots] [--ignore-console] [--repo] [--json]` | Playwright, per case (below). Exit 1 fail, 2 usage / no Playwright |
| `mock-decision-api.mjs [--port 4100] [--decisions] [--target] [--latency] [--fail] [--invalid] [--ttl] [--cacheable]` | `POST /decide` (v1 engine) and `POST /rest/v1/delivery` (Target Delivery API, client from the query); `GET`/`DELETE /requests`, `GET /health` |

Playwright loads from this skill's folder or `~/.cache/aem-eds-personalization/playwright`
(`PZN_PLAYWRIGHT_DIR` overrides), **never from the site**: an install there prunes the
site's devDependencies and breaks its lint. If `verify-preview.mjs` exits 2, run the command it
prints once: `npm i --prefix ~/.cache/aem-eds-personalization/playwright playwright && npx --prefix ~/.cache/aem-eds-personalization/playwright playwright install chromium`.

## What verify-preview checks

Every case opens the page with its query in a fresh browser context:

- **Sections**: none left `pzn-pending` / `pzn-waiting`; the expected variant (or one of `allowed`)
  and source; the content shown is the variant fragment's (its heading) or the authored content
  (its text); no new console errors; CLS within budget. Inline `target` offers send one `display`
  notification once seen.
- **Bots**: the authored content, no decision or Target call, no `pzn-split` assignment.
- **Popups**: closed with the page scrolled 20 points below the trigger, open 2 points past it;
  modal and labelled; `display` notified; Escape closes; no reopen in the page view. Without
  consent: `waiting for consent`.
- **Splits**: the assignment stays across two reloads and a new tab; `--split-runs N` draws N fresh
  visitors and reports the distribution (fails when an allowed variant is never drawn with ≥ 10
  draws per variant, or an excluded one is).
- **`--faults`** (needs `config.mock`): per `api` / `target` section, `?pzn-mock-fail` must end at
  the fallback (Rule rows or authored content; popups: status `error…`) and
  `?pzn-mock-latency=3000` at `timeout`.
- Console errors also present on the no-context or baseline run (and not about personalization)
  are reported as pre-existing, not failed. `--baseline <url>` fails on a CLS regression;
  `--revisit` loads twice with cookies kept (returning visitor; needs consent).

## Default matrix

Without `--matrix`, each section gets: no context, bot, one case per rule (or mock engine /
activity condition) satisfying its positive clauses, and a forced case per variant plus
`default`. A shared matrix looks like:

```json
[
  { "name": "india mobile returning", "geo": "IN", "device": "mobile", "visitor": "returning" },
  { "name": "diwali campaign", "params": { "utm_campaign": "diwali" } },
  { "name": "quiz cn", "state": { "quiz-persona": "cn" } },
  { "name": "vip", "audiences": ["vip"] },
  { "name": "crawler", "bot": true }
]
```

## Recipes

```bash
# Rules: expectations, then the browser
node scripts/simulate.mjs content/home.html --page-url http://localhost:3000/home
node scripts/verify-preview.mjs --page http://localhost:3000/home --file content/home.html --screenshots /tmp/pzn-shots

# LCP/CLS against the page before the change (e.g. the original page saved as content/home-before.html)
node scripts/verify-preview.mjs --page http://localhost:3000/home --file content/home.html --baseline http://localhost:3000/home-before

# Returning visitor (requires hasConsent to grant consent in the test setup)
node scripts/verify-preview.mjs --page http://localhost:3000/home --file content/home.html --revisit

# api / target with the in-browser mock (config.mock = { api: <decisions.json>, target: <activities.json> })
node scripts/simulate.mjs content/home.html --api-decisions decisions.json --target activities.json
node scripts/verify-preview.mjs --page http://localhost:3000/home --file content/home.html \
  --api-decisions decisions.json --target activities.json --faults --ignore-console "status of 5\\d\\d|ERR_"

# api with the mock server instead (api.endpoint = http://localhost:4100/decide for the test only)
node scripts/mock-decision-api.mjs --decisions decisions.json &
node scripts/verify-preview.mjs --page http://localhost:3000/home --file content/home.html --api-decisions decisions.json
node scripts/mock-decision-api.mjs --port 4101 --fail 500 &   # point api.endpoint at :4101/decide
node scripts/verify-preview.mjs --page http://localhost:3000/home --file content/home.html --consent --ignore-console "status of 5\\d\\d|ERR_"

# Split: stickiness and distribution
node scripts/verify-preview.mjs --page http://localhost:3000/home --file content/home.html --split-runs 30
```

Engines and Target are only called with consent. `--api-decisions` / `--target` grant it per case
with `?pzn-consent=1`; for failure runs against a server pass `--consent` so the browser really
calls the failing engine. Without `--api-decisions` the expectations are the Rule rows, which is
what a failing engine must produce. Check `GET /requests` on the mock server (or
`window.hlx.personalizationMock.requests`) to confirm calls were made. Stop background mocks when
done and revert `config.mock`, `api.endpoint`, `target.endpoint` and any test-only `hasConsent`
change.

## Live state

Check a quiz-driven swap in the browser (or a Playwright snippet):

```js
await window.hlx.personalization.setState('quiz-persona', 'cn');
document.querySelector('[data-personalization="quiz-reco"]').dataset.pznVariant; // the cn variant
```

Sections that do not use the key (and have no `audience:` rules) keep their variant.

## Skill tests

`npm test` in `skills/personalize` (`node --test scripts/test/*.test.mjs`) runs the suites: grammar,
rules, sources, contract, context, HTML reader, edge worker, one per CLI, API transport; the
browser-runtime suites need Playwright resolvable (skill folder or cache) and skip otherwise.

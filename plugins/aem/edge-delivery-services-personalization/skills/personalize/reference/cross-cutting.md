# Cross-Cutting Concerns

## Fallback

Every failure ends at the section's **authored content**: invalid Section Metadata, timeout,
engine or Target error, unlisted answer, missing fragment, runtime exception
(`data-pzn-source` = `fallback` / `timeout` / `error`, `data-pzn-reason` says why). An `api`
section's Rule rows decide first when the engine fails or is not called. Keep the authored content
meaningful: it is also what bots and visitors without consent see.

## SEO and bots

- Crawlers and performance tools (Googlebot, Bingbot, Lighthouse, PageSpeed Insights, GTmetrix,
  HeadlessChrome) get the **authored content** in the browser and at the edge
  (`botsGetDefault: true`): no engine or Target call, no split assignment, no popup.
  Lighthouse/PSI scores therefore measure the authored content; measure variants with
  `verify-preview.mjs`.
- Variants must be **semantically equivalent** to the authored content (same topic, different
  emphasis or locale). Personalized content that contradicts what crawlers see is cloaking.
- Fragments are `noindex` (bulk metadata `/fragments/**`, `da-content.md`).
- Keep the H1 in the authored content and every variant; the validator warns when a variant's H1
  differs from it.

## Privacy and consent

- `config.hasConsent(category)` is called with `'personalization'` (default: always false). Wire
  it to the CMP, e.g. OneTrust:
  ```js
  hasConsent: () => /(^|,)C0003(,|$)/.test(window.OnetrustActiveGroups || ''),
  ```
  and call `window.hlx.personalization.refresh()` from the CMP's consent-change callback (or
  dispatch a window `consent.update` event; the runtime refreshes when the answer changed).
- Without consent: no `pzn-seen` / `pzn-vs` cookies (all visitors are `new`), no persisted state,
  no decision cache, no decision engine or Target call (unless `sendWithoutConsent`), no Target
  visitor id. `api` sections fall back to their Rule rows, inline `target` sections show the
  authored content, popups wait.
- `split` needs no consent: the assignment lives in sessionStorage and a session cookie
  (`pzn-split`) and identifies no one.
- The runtime mirrors consent into the `pzn-consent` cookie so the edge applies the same policy;
  revoking consent clears `pzn-consent`, `pzn-seen` and `pzn-vs` and deletes what was stored with
  consent (localStorage `pzn-state`, `pzn-tnt-id`).
- Geo comes from the CDN or IP per request and is never stored by the runtime.
- Only `utm_*` and rule-referenced URL params reach the engine. Never add PII in adapters.

## Analytics and martech

On every applied decision:
- `personalization:applied` CustomEvent on the section (bubbles): `{ id, variant, source, tracking }`.
- `window.adobeDataLayer.push({ event: 'personalization:applied', personalization: {...} })`
  (`analytics.dataLayer`). The array is created if missing, so Launch/Tealium loaded in the
  delayed phase still receive earlier pushes.
- RUM (`analytics.rum`): `sampleRUM('experiment', …)` for `split` sections (also when decided at the
  edge) and `sampleRUM('audience', …)` otherwise, with `{ source: <id>, target: <variant> }`, the
  checkpoints aem-experimentation uses.
- `personalization:notified` `{ id, variant, type }` after a Target `display` / `click` notification.
- Personalized sections carry `data-personalization` (id) and `data-pzn-variant` for click
  attribution.

For Tealium: map the data layer event, or listen for `personalization:applied` and call `utag.link`.

## Adobe Target / Web SDK

`Personalization Source | target` sections let Target pick the fragment through the Delivery API
or the Web SDK (`target.md`). The skill never creates Target activities, audiences or offers, and
never sets up AJO journeys. If detect reports at.js or alloy auto-rendering
(`integrations.atjs`, `websdk`, `launch`, `target`), which regions those own is a choice (default:
none of the requested ones); never put a personalized section in a region they modify.

## Experimentation compatibility

- `split` sections are A/B tests inside a page (`split.md`); aem-experimentation runs page-level
  experiments with its own metadata. The grammar rejects a section carrying both;
  `detect-project.mjs` reports `content.pagesWithExperiments`.
- Custom audiences use the aem-experimentation function signature; one registry can serve both.
- Override params do not collide: `?pzn…` here, `?audience=` / `?experiment=` there.

## CDN

- Client mode works on any CDN, including Adobe-managed.
- Edge mode: BYO Cloudflare. Origin cache and its key are unchanged; the personalized response is
  `private, no-cache`, so shared caches never store a variant. Fragments stay publicly cacheable.
- Pages without personalized sections or blocks pass through untouched (no `x-pzn` header).

## Launch checklist

- [ ] Section Metadata reaches the page as `data-personalization*` attributes (rendering v2 or
      a client-side `aem.js`); the hooks are on `main`
- [ ] `hasConsent` wired to the CMP and `refresh()` on consent change
- [ ] Fragments `noindex`; variants equivalent to the authored content; same H1 structure
- [ ] No held first section in client mode, or the LCP cost accepted (edge, a later section, or a popup)
- [ ] Analytics consumes `personalization:applied` (data layer / Tealium / RUM); split results have an owner
- [ ] `overrides` is `preview` (or `never`) in `config.js`; `never` in `edge-config.js`
- [ ] `config.mock` is `false`; `api.endpoint` is the production same-origin path and
      `target.endpoint` empty or the production proxy (mock URLs reverted)
- [ ] `target.clientCode` / `propertyToken` set and the Target activities live, on mboxes named
      after the section ids, with JSON `{ "fragment" }` offers
- [ ] Engine key only as a Worker secret; worker deployed by the site owner
- [ ] `PZN_RATE_LIMITER` bound when the browser uses `/pzn/decide`; no browser-side adapters
- [ ] Target, Web SDK and experimentation regions are disjoint from personalized sections
- [ ] Content previewed and published in DA, including all fragments
- [ ] `verify-preview.mjs` passes on `*.aem.page`; edge checked with a browser and `curl -A Googlebot`

# Client Mode

The browser runtime is always installed: it decides on Adobe-managed CDNs, on `aem.page` preview
and for everything the edge worker leaves to the browser (`target`, browser-only criteria,
overrides).

## Installed files

| Path | Owner | Notes |
|---|---|---|
| `scripts/personalization/sections.js` | skill | Section runtime: hold, decide, reveal, popups |
| `scripts/personalization/section-spec.js` | skill | Section grammar and decisions; shared with the edge worker |
| `scripts/personalization/visitor.js` | skill | Context, consent, bots, state, overrides, tracking, `window.hlx.personalization` |
| `scripts/personalization/sources/{rules,api,split,target,target-websdk}.js` | skill | Decision sources (providers); `api.js` and `split.js` are shared with the edge worker |
| `scripts/personalization/popup.js` | skill | Target popup (`<dialog>`) and triggers |
| `scripts/personalization/mocks.js`, `mock-engine.js` | skill | In-browser decision API / Target mocks, loaded only with `config.mock` |
| `scripts/personalization/rules.js`, `contract.js`, `context.js`, `provider-api.js` | skill | Condition engine, v1 contract, context readers, engine transport; shared with the edge worker |
| `scripts/personalization/config.js` | site | Created once, never overwritten |
| `styles/target-popup.css` | site | Popup styles (reduced-motion aware); created once |
| `blocks/fragment/fragment.js` | site | Stock `loadFragment`, only added when missing (the runtime needs `loadFragment(path)`) |

Re-running `install-runtime.mjs` updates skill-owned files and keeps site-owned ones. Its report
lists `created`, `updated`, `unchanged`, `kept`, `warnings`, and `hooks.{sections,lazy}`,
each `{ status, patch }` with status `installed`, `pending`, `applied` or `not-found`, plus an
overall `hook`.

## The `scripts.js` hooks

`install-runtime.mjs --apply-hook` (the skill always passes it) inserts them and prints the patch;
a page without personalized sections pays one `querySelector` per hook and loads nothing.

In `loadEager`, right **after** `decorateMain(main);`, so sections are held before the first one
loads:

```js
    decorateMain(main);
    if (main.querySelector(':scope > .section[data-personalization]')) {
      const { personalizeSections } = await import('./personalization/sections.js');
      await personalizeSections(main);
    }
```

The `await` matters only when the first section is personalized: `loadEager` then continues once
that section shows (within `budgets.eager`), so the header, footer and later sections cannot
appear first and shift when it does. Otherwise it returns at once and every section is decided in
the background.

In `loadLazy`, right after `await loadSections(main);` (arms `target` popups):

```js
    await loadSections(main);
    if (main.querySelector(':scope > .section[data-personalization]')) {
      const { personalizeSectionsLazy } = await import('./personalization/sections.js');
      personalizeSectionsLazy(main);
    }
```

A `not-found` hook (a `scripts.js` without these anchors) is placed by hand at the equivalent
spot: after sections are decorated and before the first one loads; after all sections loaded.
Show the diff in the summary (no approval needed). `detect-project.mjs` reports
`scriptsJs.sectionsHookInstalled`, `lazyHookInstalled` and `loadSectionsInLoadLazy`.

## Lifecycle

1. `personalizeSections(main)` reads every `.section[data-personalization]`. Invalid sections show
   their authored content (`data-pzn-status="invalid"`). Sections the edge already decided
   (`data-pzn-source="edge"`) are final: tracked with source `edge` (a `split` section with
   `tracking: { split }`) and never decided again.
2. Every section to decide (all but `target` popups) gets `data-section-status="pzn-pending"`, so
   `aem.js` `loadSection` skips it and it stays hidden. Every section below the first held one gets
   `pzn-waiting`.
3. One request per source for all of its sections (`rules`, `api`, `split`, `target`, providers).
   Popup sections of a source already being asked ride along in that request, so a page makes
   one Target call.
4. Each section races its decision **and** its fragment against its budget. A variant replaces the
   section's children with the fragment's content (`authoring-model.md` § Variants); the authored
   content is kept in memory and restored if a later decision is the default.
5. A decided section becomes `pzn-ready` and is revealed with `loadSection` **in page order**: a
   section appears only once every section above it has, as `aem.js` `loadSections` does, so
   nothing shifts above the reader. Reveal also waits for a section `aem.js` is still loading (the
   first section waits for its LCP image) and resumes when its status changes.
6. `personalizeSectionsLazy(main)` arms popups (`target.md`).
7. Failsafe: at `max(budgets.eager, budgets.lazy) + 2000` ms any section still pending shows its
   authored content (`timeout`, reason `failsafe`, console error). Budgets normally decide first;
   this only guards against a runtime fault.

Decision order per section: `?pzn=` override (preview hosts) → bot (authored content, no call) →
the source's answer (only listed variants) → for `api`, the Rule rows → the authored content.

| Outcome | `data-pzn-source` / reason |
|---|---|
| Source error (HTTP, bad JSON, no endpoint, no consent) | Rule rows of an `api` section (`rule`, with the reason), else `fallback` |
| No answer for the section | Same, reason `no decision` |
| Answer names an unlisted variant or fragment | `fallback`, `not listed: <x>` |
| Variant fragment fails to load or is empty | `fallback`, `fragment failed: <path>` |
| Budget exceeded | `timeout` (authored content) |
| Exception | `error` |

## Budgets, LCP and CLS

- `config.budgets`: `eager` 800 ms (the first section) and `lazy` 2000 ms (the others). The budget
  covers the decision and the fragment. The source call itself is aborted at the largest budget of
  its batch + 250 ms (or `config.<source>.timeout`, e.g. `target.timeout` 3000).
- **LCP**: a held first section stays hidden until decided. On preview hosts and with `?pzn-debug`
  the runtime warns: `section "<id>" is the first section (LCP) and stays hidden until decided`;
  the validator warns too. Decide it at the edge (`edge-cloudflare.md`: never hidden there) or
  personalize a later section; `target` is browser-only, so use a popup or a later section.
- The first section's variant image is loaded `eager` with `fetchpriority="high"`.
- **CLS**: decisions happen while sections are hidden and sections are revealed in order, so first
  render does not shift. The price: sections below a held section wait for it (up to its
  budget). Measure with `verify-preview.mjs --baseline <url before the change>`; if LCP regresses
  more than 500 ms, recommend edge mode or a later section.
- Live swaps after `setState()` follow user input.

## Providers

A source is a provider module (default export or the module itself):

```js
export default {
  requiresConsent: true,             // skip without config.hasConsent() unless config.<name>.sendWithoutConsent
  // entries: [{ id, spec, section }]; context: { geo, device, visitor, params, state, consent }
  async decide(entries, context, { config, audiences, fetch, timeout }) {
    return { decisions: { [id]: { variant: 'name' | null, fragment: '/fragments/...', tracking, data } } };
    // or { error: 'message' }; a decision may also carry { error }
  },
  // optional: exposure; event = { type: 'display' | 'click', id, spec, decision }
  async notify(event, { config, fetch, consent }) {},
};
```

Register or replace one in `config.js`; its name becomes a valid `Personalization Source` value:

```js
providers: {
  optimizely: () => import('./sources/optimizely.js'),
  target: () => import('./sources/target-websdk.js'),   // Target over an existing Web SDK
},
```

`fetch` is `window.fetch`, or the in-browser mock when `config.mock` is set. `notify` runs for
sections and popups showing a fragment whose decision has `data`: `display` once 25% of the section
is visible (immediately for a popup), `click` on the first link click inside it.

## Public API (`window.hlx.personalization`)

Defined in `visitor.js`:

```js
await window.hlx.personalization.setState('quiz-persona', 'cn'); // re-decides dependent sections
window.hlx.personalization.getState('quiz-persona');             // 'cn'
await window.hlx.personalization.setState('quiz-persona', null); // remove
await window.hlx.personalization.refresh();                       // re-decide all, e.g. after consent
window.hlx.personalization.decisions;                             // rows of the ?pzn-debug table
```

Also importable from a block: `import { setState } from '../../scripts/personalization/visitor.js'`.

- `setState` re-decides held sections with a `state:` rule on that key and every held section with
  `audience:` rules; others keep their variant. State persists in localStorage (`pzn-state`) only
  with consent; otherwise it lives for the page view.
- `refresh()` re-decides every held section and asks again for popups that were waiting for
  consent. The runtime also listens to a window `consent.update` event and refreshes when
  `hasConsent()` changed; otherwise call `refresh()` from the CMP's consent-change callback.
- A newer decision for a section wins; an older one that resolves later leaves the DOM alone.
  Re-deciding to the variant already shown changes nothing and tracks nothing.
- Edge-decided sections are final for the page view.

## Events and analytics

| Event | Target | `detail` |
|---|---|---|
| `personalization:applied` | the section (bubbles) | `{ id, variant, source, tracking }` |
| `personalization:notified` | the section (bubbles) | `{ id, variant, type }` after a `display` / `click` notification |
| `personalization:state-changed` | `document` | `{ key, value }` |

With `analytics.dataLayer`, every applied decision is also pushed as
`window.adobeDataLayer.push({ event: 'personalization:applied', personalization: detail })`. With
`analytics.rum`, RUM gets `sampleRUM(checkpoint, { source: id, target: variant })` where
`checkpoint` is `experiment` for `split` sections (also when decided at the edge) and `audience`
otherwise, as aem-experimentation reports them. Popups track when they open.

`?pzn-debug` prints a `console.table` of the decisions (id, variant, source, reason, ms, popup
status, notifications); `window.hlx.personalization.decisions` holds the same rows.

## Configuration (`config.js`)

Every option is commented in the file:

| Key | Default | Purpose |
|---|---|---|
| `fragmentPrefixes` | `['/fragments/']` | Fragments a section may show |
| `budgets` | `{ eager: 800, lazy: 2000 }` | Per-section budget (decision + fragment) |
| `devices` | mobile / tablet / desktop media queries | `device:` values, first match wins |
| `geo` | `{ endpoint: '', timeout: 500 }` | Opt-in geo lookup when no edge meta or cookie |
| `api` | `{ endpoint: '', sendWithoutConsent: false, mapRequest: null, mapResponse: null }` | `decision-api-contract.md` |
| `target` | `{ clientCode: '', propertyToken: '', endpoint: '', timeout: 3000, sendWithoutConsent: false }` | `target.md` |
| `providers` | `{}` | Extra or replacement sources |
| `mock` | `false` | Demos/tests only: `{ api: <decisions.json>, target: { <mbox>: activity } }` answered in the browser |
| `audiences` | `{}` | `audience:` functions (`criteria.md`) |
| `hasConsent(category)` | `() => false` | Called with `'personalization'`; wire it to the CMP |
| `overrides` | `'preview'` | `?pzn…` params on aem.page/localhost (`'always'`, `'never'`) |
| `botsGetDefault` | `true` | Crawlers get the authored content |
| `analytics` | `{ dataLayer: true, rum: true }` | Exposure tracking |

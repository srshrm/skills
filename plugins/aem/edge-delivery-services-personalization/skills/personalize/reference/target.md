# Target Sections

`Personalization Source | target` lets Adobe Target choose a section's variant. The section's id
is the **mbox**; Target's offer names the fragment. The skill wires the page to Target; it never
creates Target activities, audiences or offers (that stays with the Target user, and AJO journeys
are out of scope).

```
| Section Metadata          |                                                    |
| Personalization           | plan-offer                                         |
| Personalization Source    | target                                             |
| Personalization Variants  | /fragments/personalization/plan-offer/free-trial   |
|                           | /fragments/personalization/plan-offer/demo         |
| Personalization Trigger   | scroll: 60%         (optional: makes it a popup)   |
| Personalization Display   | popup | inline      (optional)                     |
```

## Inline or popup

| Rows | Display | Behaviour |
|---|---|---|
| No Trigger, no Display | inline | The section is held (hidden) until Target answers within its budget; the offer's content replaces the section's content, as for any variant |
| `Trigger` (any) | popup | The section shows its authored content at once; the offer opens in a modal dialog when the trigger fires |
| `Display \| popup`, no Trigger | popup | Trigger `scroll: 70%` |
| `Display \| inline` + `Trigger` | inline | The Trigger is ignored (warning) |

Triggers: `scroll: N%` (share of the page seen, `(scrollY + innerHeight) / scrollHeight`, checked
on scroll events only, so a short page never opens it without the visitor scrolling), `view` (25%
of the section visible), `load` (as soon as the offer is ready). A popup opens at most once per
page view.

The popup (`popup.js`) is a native `<dialog class="target-popup">` opened with `showModal()`:
labelled by the offer's first `h1`–`h4`, else `aria-label` = the activity name (`activity.name`
response token) or `Offer`; a `.target-popup-close` button labelled "Close"; Escape and a backdrop
click close it, and the dialog is removed. Styles: `styles/target-popup.css`, site-owned, created
once, with a `prefers-reduced-motion` rule.

## Variants

Listed Variants are an allowlist: an offer naming any other fragment is not shown
(`offer not listed: …` for popups, `fallback` / `not listed: …` inline). A target section may list
no Variants: it then accepts any fragment under `fragmentPrefixes`. Rule and Split rows are
ignored. Variant fragments follow `authoring-model.md` (content only, `TODO:` copy until the user
supplies it).

## What the Target user sets up

- An activity (XT, A/B, Auto-Target…) on the **mbox named after the section id** (`plan-offer`).
- **JSON offers** shaped `{ "fragment": "/fragments/personalization/plan-offer/free-trial" }`. An
  HTML or other offer is an error (`offer is not JSON`), and no qualifying experience means the
  authored content (inline) or no popup.
- Audiences may use the mbox parameters the page sends, `device` (`config.devices` name) and
  `visitor` (`new` / `returning`), plus Target's own (URL, geo, profile…).
- A workspace property token, if the activities use one: `config.target.propertyToken`.

## Transport: Delivery API (built in)

`sources/target.js` calls `https://<clientCode>.tt.omtrdc.net/rest/v1/delivery?client=<clientCode>&sessionId=<id>`
(or `config.target.endpoint`, relative allowed, e.g. a same-origin proxy or the local mock):

- One **prefetch** request per page for every target section (inline and popup), each mbox with
  `parameters: { device, visitor }`, plus `context` (`channel: web`, URL, referrer, screen,
  window) and the property token. Prefetch never counts as a visit.
- A **`display` notification** when the visitor sees the offer (25% of an inline section visible,
  or immediately when the popup opens) and a **`click` notification** on the first link click in
  it, both with the offer's event tokens and `keepalive`, so a click survives the navigation.
- Session id: sessionStorage `pzn-tnt-session`. Later requests go to the edge host Target answered
  from (sessionStorage `pzn-tnt-edge`) unless `endpoint` is set. Target visitor id (`tntId`):
  localStorage `pzn-tnt-id`, read and written **only with consent**.
- `config.target`: `{ clientCode, propertyToken, endpoint, timeout: 3000, sendWithoutConsent: false }`.
  Without `clientCode` the source answers an error and the authored content shows.

## Transport: Web SDK (provider swap)

Sites that already load alloy (directly or through Launch) can swap the transport:

```js
providers: { target: () => import('./sources/target-websdk.js') },
```

It sends `alloy('sendEvent', { renderDecisions: false, personalization: { decisionScopes } })`
with the section ids as scopes, reads JSON content items
(`https://ns.adobe.com/personalization/json-content-item`) whose `content.fragment` is the variant,
and reports display / click as `decisioning.propositionDisplay` / `decisioning.propositionInteract`.
alloy owns the visitor id and its own consent; the runtime still waits for `config.hasConsent`.
**Unverified against a live datastream** (unit-tested with a stub): check one page with the Adobe
Experience Platform Debugger before relying on it. Do not run at.js or alloy auto-rendering on the
same region.

## Consent, bots, budgets, edge

- `requiresConsent`: without `hasConsent()` (and without `sendWithoutConsent`) no request is sent.
  Inline sections show the authored content (`fallback`, `no consent`); popups wait
  (`waiting for consent`) and are asked again on `refresh()` or a `consent.update` event.
- Bots: no request, authored content, no popup.
- Inline target sections are held within `budgets.eager` / `budgets.lazy` like any section (the
  request itself times out at `target.timeout`). A held **first section** costs LCP, and the edge
  never decides target sections: personalize a later section or use a popup.
- The edge worker leaves target sections to the browser.

## Preview and tests

- `?pzn=plan-offer:free-trial` forces an offer without calling Target; `?pzn=plan-offer:default`
  forces the authored content / no popup.
- Mock activities (`mock-engine.js`), `activities.json`: mbox → activity; experiences are checked
  in order and the first whose audience matches wins (`null` matches everyone). Audiences use the
  condition syntax over the mbox parameters and the page's URL params:

  ```json
  { "plan-offer": { "name": "Plan offer (XT)", "experiences": [
      { "name": "Enterprise", "audience": "param: utm_campaign=enterprise", "offer": "/fragments/personalization/plan-offer/demo" },
      { "name": "Everyone", "audience": null, "offer": "/fragments/personalization/plan-offer/free-trial" } ] } }
  ```

- `simulate.mjs content/<page>.html --target activities.json` gives the offer per case (override
  URLs add `pzn-consent=1`; without `--target` the expectation is the authored content, as without
  consent).
- In the browser either set `config.mock = { target: <activities> }` (answered in the browser;
  needed for `--faults` and on aem.page) or run
  `node scripts/mock-decision-api.mjs --target activities.json` and point `config.target.endpoint`
  at `http://localhost:4100/rest/v1/delivery` for the test only.
- `verify-preview.mjs --target activities.json` checks inline offers (variant, content, one
  `display` once seen) and popups (closed 20 points below the scroll trigger, open past it, modal
  and labelled, `display` notified, Escape closes, no reopen). `--faults` (needs `config.mock`) adds
  a mock failure run (popup status `error…`; inline: `fallback` or the authored content) and, for
  inline sections, a 3000 ms latency run that must end at `timeout`.
- Revert `config.mock` / `target.endpoint` before launch.

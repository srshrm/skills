# aem-eds-personalization

Section-based personalization for AEM Edge Delivery Services pages authored in DA.

Authors personalize a **section** with `Personalization` rows in its Section Metadata. The section's
authored content is the default (what bots, failures, timeouts and visitors without consent see);
variants are EDS fragments chosen by rules, a decision engine, an A/B split or Adobe Target.

```
| Section Metadata               |                                                |
| Personalization                | home-hero                                      |
| Personalization Source         | rules   (default) | api | split | target       |
| Personalization Variants       | /fragments/personalization/home-hero/india     |
|                                | /fragments/personalization/home-hero/na-mobile |
| Personalization Rule India     | geo: IN                                        |
| Personalization Rule NA Mobile | geo: US, CA & device: mobile                   |
```

| Source | Decides |
|---|---|
| `rules` | First matching `Personalization Rule <Variant>` row: geo, device, new/returning visitor, URL/UTM param, app or quiz state, custom audiences |
| `api` | A decision engine (v1 contract or adapters), the rule rows as fallback |
| `split` | A/B(/n) test against the authored content, weighted by `Personalization Split`, sticky per session |
| `target` | Adobe Target (Delivery API or Web SDK); inline, or a popup on scroll/view/load |

## Install

```bash
/plugin marketplace add adobe/skills
/plugin install aem-eds-personalization@adobe-skills
```

Then, in an EDS project:

```
/aem-eds-personalization:personalize geo hero on /home: India, US, Europe; TODO copy
/aem-eds-personalization:personalize A/B test the closing CTA section on /home 50/50
```

## Skills

| Skill | Description |
|-------|-------------|
| `personalize` | Installs the client runtime and `scripts.js` hooks, authors Section Metadata and variant fragments, validates (grammar, simulator, project lint, Playwright check including popups, splits and fault injection) and delivers to DA. Optional Cloudflare edge worker that decides `rules`, `api` and `split` sections before the HTML leaves the CDN (no hiding, LCP-safe). |

## Scope

- DA projects only; xwalk and document-based projects stop at preflight.
- Section Metadata must reach the page as section attributes: the pipeline's rendering v2, or an
  `aem.js` that still reads Section Metadata client-side.
- Not for creating Target activities, audiences or offers, AJO journeys, or text-token replacement
  (placeholders sheet). Page-level experiments stay with aem-experimentation.
- Works on any EDS site, and on top of a migration (for example after the `stardust` plugin's
  `deploy`) when the use case needs it. Nothing in another plugin chains it.
- The edge worker is generated and tested locally; `wrangler deploy` and secrets are always handed
  off to the site owner, never run by the agent.

## Requirements

- Node 22+, `@adobe/aem-cli` 16.21+ (`aem up`) for local preview
- Playwright with Chromium in the skill folder or `~/.cache/aem-eds-personalization/playwright`
  for `verify-preview` (never installed into the site)
- `wrangler` only for edge mode
- A `DA_TOKEN` (see the `da-auth` skill in `aem-edge-delivery-services`) or a DA MCP server for
  delivery

## Layout

```
skills/personalize/
├── SKILL.md         workflow (preflight → choices → install → author → configure → validate → edge → deliver)
├── reference/       authoring model, criteria, client and edge modes, split, Target, API contract, testing, DA
├── assets/          content templates, client runtime, popup styles, Cloudflare worker
└── scripts/         detect, install, validate, simulate, verify, mock API/Target (+ tests)
evals/personalize/   task.md and criteria.json (seven runs on a DA sandbox)
```

## Tests

```bash
cd plugins/aem/edge-delivery-services-personalization/skills/personalize && npm test
```

The browser runtime tests run when Playwright resolves from the skill folder or the cache, and are
left out otherwise.

---
name: personalize
description: Personalize sections of AEM Edge Delivery Services (DA) pages with Section Metadata. The authored content is the default; Personalization rows pick an EDS fragment variant per visitor from rules (geo, device, new/returning visitor, URL/UTM param, quiz/app state, custom audiences), a decision-engine API, an A/B split, or Adobe Target (inline or as a scroll/view popup). Installs a client runtime and an optional LCP-safe Cloudflare edge worker, validates with a simulator and Playwright. Use for "personalize this section", "different hero for visitors from <country>", "returning visitor banner", "only on mobile", "swap this section on the quiz result", "connect our decision engine", "A/B test this section", "let Target pick this offer", "edge personalization", or `/aem-eds-personalization:personalize`. Not for creating Target activities or audiences, AJO journeys, or text tokens (placeholders sheet). DA projects only (xwalk and document-based stop at preflight).
license: Apache-2.0
compatibility: Requires Node 22+, an AEM Edge Delivery Services project authored in DA whose Section Metadata reaches the page as section attributes (rendering v2, or an aem.js that reads it), @adobe/aem-cli 16.21+ for local preview, and Playwright with Chromium in this skill's folder or ~/.cache/aem-eds-personalization/playwright for verify-preview (never installed into the site); wrangler only for edge mode.
---

# personalize — sections → fragments

A personalized section is an authored section plus `Personalization` rows in its Section Metadata.
Its content is the default; a variant is an EDS fragment whose content replaces it for the chosen
visitors. One grammar (`section-spec.js`) runs unchanged in the browser, the edge and the scripts.

```
| Section Metadata               |                                                |
| Personalization                | home-hero                                      |
| Personalization Source         | rules   (default) | api | split | target       |
| Personalization Variants       | /fragments/personalization/home-hero/india     |
|                                | /fragments/personalization/home-hero/na-mobile |
| Personalization Rule India     | geo: IN                                        |
| Personalization Rule NA Mobile | geo: US, CA & device: mobile                   |
```

`split` adds `Personalization Split | 40, 30` (A/B, rest to the default); for `target` the id is the
mbox, and `Personalization Trigger | scroll: 60%` makes a popup. Grammar: `reference/authoring-model.md`.

## When to Use

- Show a different section per country/region, device, new vs returning visitor, URL/UTM param,
  quiz or app state, or a custom audience function
- Let a decision engine choose the variant, with the section's rules as fallback
- A/B(/n) test a section against its authored content (`split`)
- Let Adobe Target pick a section's offer, inline or as a popup on scroll/view/load (`target`)
- Decide at the CDN edge (Cloudflare) for above-the-fold sections

**Do NOT use for:**
- Creating Target activities, audiences or offers, or AJO journeys → decline; the skill only wires
  sections to activities the Target user creates (`reference/target.md`)
- Replacing text tokens such as `{name}` → placeholders sheet
- Page-level experiments run with aem-experimentation → keep them there; migrating the page itself
  → migrate it to EDS first (for example `page-import`, or the stardust plugin)

## Critical Rules

- `scripts/` and `assets/` below are **this skill's directories**: resolve them against the folder
  holding this SKILL.md (a plugin install keeps them outside the project; use absolute paths). Run
  them from the project root. Every script answers `--help`.
- **The authored section content is the default: never delete, rewrite or reorder it.** Personalization
  adds Section Metadata rows, variant fragments and, when needed, a section break or a new section.
- **Never touch** `scripts/aem.js`, existing block code or the vendored `aem-worker.mjs`.
- **Choices, not gates:** ask only where there is a real choice (Step 2), always with its default.
  No reply, or hands-off (`--hands-off`, "no approval gates", a non-interactive run): take the
  defaults and list them as named assumptions in the summary. Never ask a yes/no confirmation
  (hooks, mode, H1, worker wrap).
- **Delivery is on by default:** pushing the code branch and the DA upload, preview and publish run
  once every gate passes (Step 8).
- **Off unless chosen:** `wrangler deploy` / `wrangler secret put`, overrides on production, a
  third-party geo endpoint, `config.mock` outside tests. Hand off those commands.
- **Never:** invent marketing copy (variants are `TODO:` scaffolds unless the user gives copy), put
  API keys in browser code, send PII to an engine, list a variant named `default`.

## Step 1: Preflight

```bash
node scripts/detect-project.mjs <project>
```

| Result | Action |
|---|---|
| `projectType: da` | Continue |
| `xwalk` / `doc` (exit 3) | Stop: "personalize supports DA projects only for now." |
| `sectionMetadata.renderedBy` | `pipeline`: needs rendering v2 (Step 6 proves it); `aem.js`: works as is |
| `content.pagesWithExperiments`, `integrations.experimentation` | Never personalize a section that runs an experiment |
| `integrations.atjs` / `websdk` / `launch` / `target` | Step 2 choice: regions Target owns (default: none of the requested ones); Web SDK sites may use the alloy provider |
| `edge.cloudflare` | Default mode becomes client + edge |
| `fragmentBlock.exportsLoadFragment: false` | The installer adds the stock fragment block when missing; warn if one exists without `loadFragment` |

## Step 2: Choices

Take what the prompt already says. Ask the rest in **one grouped list**, each with its default; no
reply or hands-off takes the defaults. Nothing else is asked.

| Choice | Default |
|---|---|
| Page and section | The section the prompt names; if only a page, its first section (the hero) |
| Source per section | `rules`; `api` when the prompt names an engine (ask endpoint + sample request/response); `split` for "A/B", "50/50", "split test"; `target` when Target should pick |
| Display (`target` only) | `inline`; `popup` with a trigger when the prompt says popup/modal/scroll (`scroll: 70%`) |
| Variant content | `TODO:` scaffolds copied from the section (user copy only when given) |
| Consent | No CMP: `hasConsent` denies, so `visitor:` rules, persisted state, engine and Target calls stay off (`split` needs none) |
| Mode | Client + edge when `edge.cloudflare` or the prompt says so; otherwise client. A first section decided in the browser is hidden up to 800 ms: recommend edge, a later section or a popup |
| Geo source | Edge meta / `pzn-geo` cookie when present, `?pzn-geo=` in preview; no third-party endpoint |
| Target / experimentation regions | None of the requested sections |
| DA delivery | On: push, upload, preview; publish once `main` serves the runtime; `preview only` / `no upload` when asked |

Criteria: `reference/criteria.md`; sources: `split.md`, `target.md`, `decision-api-contract.md`.

## Step 3: Install the Runtime

```bash
node scripts/install-runtime.mjs <project> --apply-hook
```

- Copies `scripts/personalization/*` (sections runtime, sources, popup, mocks) and, if missing,
  the site-owned `config.js`, `styles/target-popup.css` and `blocks/fragment/fragment.js`
  (never overwritten).
- `--apply-hook` adds `await personalizeSections(main)` after `decorateMain(main)` in `loadEager`
  and `personalizeSectionsLazy(main)` after `await loadSections(main)` in `loadLazy`. Report:
  `hooks.{sections,lazy}.status`. A `not-found` hook is placed by hand (`reference/client-mode.md`);
  show the diff in the summary.

## Step 4: Author Section Metadata and Fragments (local first)

For each section, in `content/<page>.html` (`reference/authoring-model.md`, `reference/da-content.md`):
1. Add the `Personalization …` rows to the section's Section Metadata (create the block at the
   end of the section if needed). Unique id. Leave the section's content exactly as authored.
   Part of a section: split it, copy its `Style` row. Content only some visitors see (a banner):
   a new section with no content, only the rows.
2. One fragment per variant at `content/fragments/personalization/<id>/<variant>.html`,
   **scaffolded from the section's content**: same blocks, images and CTAs, copy swapped for
   `TODO:`. The variant name is the last path segment, unique, never `default`.
3. Rules: one condition per row; repeat a variant with `Personalization Rule <Variant> 2` (two
   rows with the same name keep only the last value).

Keep the H1 in the authored content and every variant (semantically equivalent). All local until Step 8.

## Step 5: Configure `config.js`

`scripts/personalization/config.js` (site-owned, `reference/client-mode.md` § Configuration):
- `hasConsent` wired to the CMP (default denies); custom `audiences`.
- `api`: same-origin `endpoint`, adapters from the user's sample checked offline (contract doc).
- `target`: `clientCode`, `propertyToken`; `providers.target` for the Web SDK (`reference/target.md`).
- `mock`: only for tests and demos, reverted before handover. Keep `overrides: 'preview'`.

## Step 6: Validate

With `aem up` running (`reference/preview-and-testing.md`), in order; every script prints
✓ PASS / ❌ FAIL. Fix and re-run until all pass.

```bash
node scripts/validate-placeholders.mjs content --repo <project>
node scripts/simulate.mjs content/<page>.html --page-url http://localhost:3000/<page>
npm run lint
node scripts/verify-preview.mjs --page http://localhost:3000/<page> --file content/<page>.html
```

Per source, add to `simulate` and `verify-preview`:
- `api`: `--api-decisions decisions.json` (mock table), and `--faults` with `config.mock` to prove
  failure → Rule rows / authored content and slowness → `timeout`.
- `target`: `--target activities.json` (mock activities); popups are checked at their trigger.
- `split`: `verify-preview --split-runs 30` (stickiness and distribution).
- First-section or layout changes: `--baseline <url before>`; `visitor:` rules: `--revisit`.

`section not found` from verify-preview: the hooks are missing or Section Metadata is not rendered
as attributes (rendering v2, `reference/authoring-model.md` § Rendering prerequisite).

## Step 7: Edge Worker (only if chosen)

`node scripts/install-edge.mjs <project> [--route <host>/*] [--account <id>]` (or `--existing <dir>`
and apply the printed wrap, `fetchFragment` included), then `reference/edge-cloudflare.md`: it
decides `rules` / `api` / `split` sections, never `target`. Check with
`simulate.mjs content/<page>.html --edge --repo <project> --country IN` and `--ua Googlebot`, then
`npx wrangler dev --local-protocol https`. Deploy and secrets are handed off.

## Step 8: Deliver

Deliver once every gate passes (`reference/da-content.md`). DA content is shared by every
branch and `aem.live` always runs `main`'s code:
1. Commit the runtime, hooks, config and styles; push the code branch.
2. Upload and preview the personalized pages and their variant fragments only: the DA Source API
   with a `DA_TOKEN`, or a DA MCP server's source and preview tools.
3. Verify on `<branch>--<repo>--<owner>.aem.page` (`verify-preview.mjs`).
4. Publish only once `https://main--<repo>--<owner>.aem.live/scripts/personalization/sections.js`
   answers 200. Until then stay at preview and say why.

No DA access (token or MCP), or a push that fails: deliver nothing and hand off the commands.

## Summary

Report files changed, the `scripts.js` diff, per-variant `?pzn=<id>:<variant>` preview URLs,
named assumptions (every Step 2 default, the mode and its reason), every `TODO:`, and the
**launch checklist** (`reference/cross-cutting.md`).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Section never personalizes | Hooks missing, rows not rendered as `data-personalization*` (rendering v2), code not on the branch |
| Always the authored content | Overrides ignored (not a preview host), no geo source, no consent (`visitor`, api, target), rule order, `data-pzn-reason` |
| A rule disappeared | Two rows with the same name: number them (`Rule India 2`) |
| First section blank for a moment | Held for its decision (LCP): edge mode, a later section, or a popup |
| Popup never opens | No consent (`waiting for consent`), no offer, trigger beyond the page, `?pzn-debug` status |
| Variant 404 locally | Fragment missing under `content/fragments/...`, or `aem up` not restarted |
| Worker 500 locally | Run `wrangler dev --local-protocol https`; origin must be `main--<repo>--<owner>.aem.live` |

`?pzn-debug` prints the decisions table; hand back the page URL and that table for anything else.

## References

- `reference/authoring-model.md`: grammar, sources, pipeline rendering, placement, variants and fragments
- `reference/criteria.md`: condition syntax, built-in criteria, custom audiences
- `reference/client-mode.md`: hooks, lifecycle, budgets, LCP/CLS, providers, public API, events
- `reference/split.md`: A/B sections, weights, stickiness, reporting
- `reference/target.md`: Target sections, popups, Delivery API and Web SDK, mocks
- `reference/decision-api-contract.md`: v1 contract, timeouts, caching, adapters, mock engine
- `reference/edge-cloudflare.md`: worker generation, request flow, caching, bots, local test, deploy handoff
- `reference/cross-cutting.md`: fallback, SEO/bots, consent, analytics, Target and experimentation, launch checklist
- `reference/preview-and-testing.md`: overrides, local preview, scripts, verify-preview checks, recipes
- `reference/da-content.md`: local content, DA upload, preview, publish on `main`, noindex
- `scripts/`: `detect-project`, `install-runtime`, `install-edge`, `validate-placeholders`, `simulate`, `verify-preview`, `mock-decision-api` (`.mjs`), `lib.mjs`

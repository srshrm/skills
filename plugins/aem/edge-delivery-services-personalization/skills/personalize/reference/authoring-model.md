# Authoring Model

## Personalized sections

Authors personalize a **whole section** with rows in its Section Metadata. The section's authored
content is the **default**: it stays where the author wrote it and is what bots, failures, timeouts,
visitors without consent and visitors no rule matches see. A variant is an EDS fragment whose
content replaces the section's content for the visitors it is chosen for. Nothing authored is ever
moved or deleted.

One grammar (`scripts/personalization/section-spec.js`) is shared unchanged by the browser
runtime, the edge worker and this skill's scripts, so every environment reads and decides a
section alike.

```
| Section Metadata               |                                                     |
| Style                          | highlight                       (any other rows stay) |
| Personalization                | home-hero                                           |
| Personalization Source         | rules                           (default; api, split, target) |
| Personalization Variants       | /fragments/personalization/home-hero/india          |
|                                | /fragments/personalization/home-hero/na-mobile      |
| Personalization Rule India     | geo: IN                                             |
| Personalization Rule NA Mobile | geo: US, CA & device: mobile                        |
| Personalization Rule India 2   | param: utm_campaign=diwali                          |
```

In the content document (`content/<page>.html`, what DA stores), the rows are a `section-metadata`
block inside the section, one link per paragraph in the Variants cell
(`assets/content/section-metadata.html` is the template):

```html
<div>
  <h1>Original hero</h1>
  <p>Authored copy: the default.</p>
  <div class="section-metadata">
    <div><div><p>Personalization</p></div><div><p>home-hero</p></div></div>
    <div><div><p>Personalization Variants</p></div><div>
      <p><a href="/fragments/personalization/home-hero/india">/fragments/personalization/home-hero/india</a></p>
      <p><a href="/fragments/personalization/home-hero/na-mobile">/fragments/personalization/home-hero/na-mobile</a></p>
    </div></div>
    <div><div><p>Personalization Rule India</p></div><div><p>geo: IN</p></div></div>
    <div><div><p>Personalization Rule NA Mobile</p></div><div><p>geo: US, CA &amp; device: mobile</p></div></div>
  </div>
</div>
```

## Grammar

| Row | Value | Rules |
|---|---|---|
| `Personalization` | The section's id, e.g. `home-hero` | Required. `^[a-z0-9][a-z0-9_-]*$` (case-insensitive), unique per page. Used by `?pzn=`, the engine, analytics; for `target` it is the mbox name |
| `Personalization Source` | `rules` \| `api` \| `split` \| `target` | Optional, default `rules`. Names registered in `config.providers` are accepted too |
| `Personalization Variants` | Links (or paths) to fragments | Under `fragmentPrefixes` only (default `/fragments/`). The **variant name is the last path segment**. A variant named `default`, two fragments with the same last segment, or a text item that is not a fragment path (e.g. a condition) are errors. Required except for `target` |
| `Personalization Rule <Variant>` | A condition (`criteria.md`) | Decides `rules` sections and is the fallback of `api` sections; ignored in `split` and `target`. First match wins, in row order. `<Variant>` names a listed variant; `Rule India 2`, `Rule India 3` add more rules for the same variant (an exact variant name wins over the numbered reading). A rule naming no listed variant is an error |
| `Personalization Split` | `40, 30` | `split` only: percent per variant in Variants order, the rest to the authored default. Omitted: even split across the default and every variant. More values than variants, or a total over 100, are errors |
| `Personalization Trigger` | `scroll: 70%`, `scroll 70`, `view` or `load` | `target` only: the offer opens as a popup when it fires |
| `Personalization Display` | `popup` \| `inline` | `target` only. Default: `popup` with a Trigger row, else `inline` |

Validation and warnings:

- A `rules` section needs at least one Rule row. A variant without a rule only shows through a
  `?pzn=` preview (warning).
- Ignored with a warning: Trigger/Display outside `target`, Split outside `split`, Rule rows in
  `split` and `target` sections, an unknown `Personalization <something>` row, a Trigger with
  `Display | inline`.
- `Display | popup` without a Trigger uses `scroll: 70%`.
- A section that also carries aem-experimentation metadata (`Experiment`, `Campaign`,
  `Audience: …`) is an error: personalize or experiment on a section, not both.
- A section with errors shows its authored content (`data-pzn-status="invalid"`, console warning).
- Variant names and rule keys compare loosely: case, spaces, `_` and `-` are equal
  (`Persona_A` = `persona-a`), because the pipeline keeps `_` in keys while older `aem.js` turns it
  into `-`.

## Sources

| Source | Who decides | Consent | Details |
|---|---|---|---|
| `rules` (default) | The Rule rows, in the browser or at the edge | Only for `visitor` cookies and persisted state | `criteria.md` |
| `api` | A decision engine, one batched call per page; the Rule rows are the fallback | Required (unless `config.api.sendWithoutConsent`) | `decision-api-contract.md` |
| `split` | A sticky random draw: an A/B(/n) test against the authored default | Not needed | `split.md` |
| `target` | Adobe Target (Delivery API, or Web SDK through a provider); inline or popup | Required (unless `config.target.sendWithoutConsent`) | `target.md` |
| custom | A provider registered in `config.providers` | Provider's `requiresConsent` | `client-mode.md` § Providers |

Only listed variants are ever shown (a `target` section without Variants accepts any fragment under
`fragmentPrefixes`). An engine answer naming anything else falls back (`not listed: …`).

## Variants and fragments

- Variant fragments live at `/fragments/personalization/<id>/<variant>` by convention; anything
  under `fragmentPrefixes` (`config.js` and `edge-config.js`, keep them equal) is allowed. URLs
  are reduced to their path, so a fragment always loads from the site itself.
- A variant contributes **content only**: the children of every section of the fragment,
  flattened into the host section. The host section keeps its classes (`Style`), id and data
  attributes; the fragment's own Section Metadata is dropped.
- Scaffold every variant from the section's authored content (same blocks, images, CTAs, heading
  level), swapping only the copy for `TODO:` unless the user gave it: a bare heading drops the
  layout and costs CLS/LCP. `assets/content/fragment.html` is the bare scaffold for when there is
  nothing to copy.
- In the first section, the variant's first image gets `loading="eager"` and
  `fetchpriority="high"`.
- Fragments must be `noindex` (bulk metadata, `da-content.md`) and must not hold a personalized
  section (no nesting; the validator rejects it).

## What the page shows

After the decision the section carries `data-pzn-variant` (`default` for the authored content),
`data-pzn-status="applied"`, `data-pzn-source` and, for fallbacks, `data-pzn-reason`:

| `data-pzn-source` | Meaning |
|---|---|
| `rule` / `default` | A Rule row matched / none did (rules source, or an api section's fallback) |
| `api`, `split`, `target` | The source's answer |
| `edge` | Rendered by the edge worker (final; the browser does not decide again) |
| `override` | `?pzn=` on a preview host |
| `bot` | Crawler: the authored content, no decision call |
| `fallback` | The source failed or answered an unlisted variant, or the fragment failed; `data-pzn-reason` says why (`no consent`, `HTTP 500`, `not listed: x`, `fragment failed: /path`, `no decision`) |
| `timeout` | The budget ran out (`data-pzn-reason="failsafe"` for the runtime's last-resort guard) |
| `error` | A runtime exception |

## Rendering prerequisite

The rows only reach the runtime as `data-personalization*` attributes of the section:

- **Pipeline (rendering v2)**: the Helix pipeline turns Section Metadata into section attributes
  when the site renders with version 2 or later (sites created on or after 2026-05-01 do by
  default). Row names pass through `toMetaName`: characters outside `[0-9a-zA-Z:_-]` become `-`,
  then lowercase (`Personalization Rule NA Mobile` → `data-personalization-rule-na-mobile`;
  `Audience: Mobile` → `data-audience:-mobile`). Link cells become their absolute URLs (link text is
  dropped), images their src, text is split on commas, trimmed and re-joined with `,`; several
  paragraphs in one cell are joined with `,`. A repeated row keeps its first position but takes
  the **last** value, so two `Personalization Rule India` rows silently lose one: number them.
  `Style` becomes classes, `Id` the section id.
- **Older `aem.js`** whose `decorateSections` still reads the `section-metadata` block client-side
  produces the same attributes before the hook runs; this works too.

`detect-project.mjs` reports which one renders the site (`sectionMetadata.renderedBy`: `pipeline` or
`aem.js`). `validate-placeholders.mjs` renders local content the way the pipeline does and flags
repeated rows and multi-paragraph rule cells. `verify-preview.mjs` fails with a rendering-v2 hint
when it finds no personalized section on the page.

## Placement

- One personalized section per region; keep the rest of the page as authored. Split a section
  in two when only part of it should change (`Style` rows can be copied to the new section).
- Content only some visitors should see (a welcome-back banner): a new section holding only its
  Section Metadata. Its authored content is empty, so everyone else, bots included, sees nothing.
- The **first section holds the LCP**: in the browser a held first section stays hidden until
  decided (up to `budgets.eager`). Prefer the edge worker for it (`rules`, `api`, `split` are
  decided there, never hidden), or personalize a later section. `target` is browser-only: use a
  popup or a later section.
- Avoid personalizing the H1 or main SEO copy; if the user insists, keep the H1 in the default
  and every variant and keep variants semantically equivalent (`cross-cutting.md`).
- Text tokens (`{name}`) are not sections: use the placeholders sheet.

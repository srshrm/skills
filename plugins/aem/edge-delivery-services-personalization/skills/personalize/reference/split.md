# Split Sections (A/B tests)

`Personalization Source | split` runs an A/B(/n) test on a section: each visitor is assigned the
authored content (the control) or one of the variants at random, and keeps that assignment for the
browser session.

```
| Section Metadata          |                                              |
| Personalization           | hero-message                                 |
| Personalization Source    | split                                        |
| Personalization Variants  | /fragments/personalization/hero-message/speed |
|                           | /fragments/personalization/hero-message/team  |
| Personalization Split     | 40, 30          (optional)                   |
```

## Weights

- `Personalization Split` gives the percent of visitors per variant, in Variants order; the
  authored default gets the rest. `40, 30` → speed 40%, team 30%, default 30%. `0, 100` sends
  everyone to `team` (a rollout).
- Omitted: an even split across the default and every variant (two variants → a third each).
- Values may carry `%`. More values than variants, a total over 100, or a non-number are errors.
- Rule rows are ignored in a split section (warning); Trigger and Display are ignored too.

## Assignment

- First visit in a session: a weighted random draw (`sources/split.js`). Stored in sessionStorage
  `pzn-split:<id>` and mirrored in the session cookie
  `pzn-split=<id>:<variant>,<id>:<variant>; path=/; SameSite=Lax; Secure` (URL-encoded), so new tabs
  and the edge worker see it.
- Later page views in the session keep the assignment if the variant is still listed; a removed
  variant is redrawn.
- No consent is needed: nothing outlives the browser session and no visitor id is stored.
- Bots are never assigned: they get the authored content and no storage is written.
- `?pzn=hero-message:team` forces a variant on preview hosts without assigning one.

## Edge

The edge worker decides split sections too: it reads the `pzn-split` cookie or draws with the same
code, renders the variant into the section (`data-pzn-source="edge"`) and sets the cookie with
`Set-Cookie: pzn-split=…; Path=/; SameSite=Lax; Secure`. No hiding, no flicker, so a split on the
first section belongs at the edge. Bots get the authored content and no cookie.

## Reporting

Every assignment shown fires `personalization:applied` with `source: 'split'` (or `'edge'`) and
`tracking: { split: [40, 30] | 'even' }`, pushes the same detail to `adobeDataLayer`, and records
the RUM `experiment` checkpoint `{ source: <id>, target: <variant> }`, the checkpoint
aem-experimentation uses, also when the edge decided. The skill sets up the split; reading the
results (RUM, Analytics) and deciding the winner stay with the site team.

## Split or aem-experimentation

A split section tests one section inside a page with fragments as variants. aem-experimentation
covers page-level experiments and its own metadata (`Experiment`, `Campaign`, `Audience`); use it
when the site already runs it or needs those. Never both on one section: the grammar rejects a
section that carries experimentation metadata, and `detect-project.mjs` reports
`content.pagesWithExperiments`.

## Tests

- `validate-placeholders.mjs` prints the split it read (`A/B test: 40% / 30% to the variants, the
  rest to the authored content; sticky per session, no consent needed`).
- `simulate.mjs` lists the variants the weights allow (`allowed`; one for `0, 100`).
- `verify-preview.mjs` checks the assignment stays the same over two reloads and a new tab, that it
  is an allowed variant, and that bots get no assignment. `--split-runs 30` also draws 30 fresh
  visitors and reports the distribution; with at least 10 draws per allowed variant it fails when
  one was never drawn, and always when an excluded variant was.

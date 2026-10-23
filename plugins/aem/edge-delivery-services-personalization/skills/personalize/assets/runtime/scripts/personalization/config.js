/*
 * Site configuration for personalization. This file belongs to the site:
 * install-runtime never overwrites it once it exists.
 */

export default {
  // Fragments a section may show. Anything else is rejected.
  fragmentPrefixes: ['/fragments/'],

  // Budget in ms per personalized section (decision plus fragment).
  // Still undecided after it, the authored content shows. "eager" applies to
  // the first section, which holds the LCP: prefer the edge worker there.
  budgets: { eager: 800, lazy: 2000 },

  // `device:` values, checked in order; the first matching media query wins.
  devices: {
    mobile: '(max-width: 599px)',
    tablet: '(min-width: 600px) and (max-width: 899px)',
    desktop: '(min-width: 900px)',
  },

  // Optional geo lookup for client mode, used only when neither the edge worker
  // nor a CDN cookie provides geo. A second origin before LCP: opt in knowingly.
  // Must answer { "country": "IN", "region": "KA" }.
  geo: { endpoint: '', timeout: 500 },

  // Decision engine, for `Personalization Source | api` sections. Use a
  // same-origin path fronted by the CDN; never put API keys here.
  api: {
    endpoint: '',
    // The engine is only called with consent, unless this is true.
    sendWithoutConsent: false,
    // Adapters for engines that do not speak the canonical v1 contract:
    // mapRequest(v1Request) -> { url?, init?, body }, mapResponse(json) -> v1Response
    // Leave both null when endpoint is the edge route (/pzn/decide): the
    // route speaks v1 and applies edge-config.js adapters itself.
    mapRequest: null,
    mapResponse: null,
  },

  // Adobe Target, for `Personalization Source | target` sections: the
  // section id is the mbox, offers are JSON { "fragment": "/fragments/..." }.
  // Delivery API, prefetch plus display/click notifications; only with
  // consent unless sendWithoutConsent is true.
  target: {
    clientCode: '',
    // Workspace property token (at_property), when activities use one.
    propertyToken: '',
    // Delivery API URL override, e.g. the local mock server; empty for Target.
    endpoint: '',
    timeout: 3000,
    sendWithoutConsent: false,
  },

  // Decision sources by Personalization Source name. rules, api, split and
  // target are built in; add an adapter for another engine (an object with
  // decide(entries, context, options) and optionally notify(event, options)),
  // or use the Web SDK when the site already loads alloy:
  //   target: () => import('./sources/target-websdk.js'),
  providers: {},

  // Demos and tests only: answer the decision API and Target in the browser
  // (mocks.js) from these tables, so a demo works on aem.page. Keep false in
  // production. Shape: { api: <decisions.json>, target: { <mbox>: activity } }.
  mock: false,

  // Custom audiences for `audience: <name>` rows. Same signature as
  // aem-experimentation: name -> (context) => boolean | Promise<boolean>.
  audiences: {
    // 'logged-in': () => document.cookie.includes('login-token='),
  },

  // Consent for storage (returning visitor, persisted state) and for sending
  // context to the decision engine. Wire this to the site's CMP.
  // Privacy-safe default: no consent until the site says otherwise.
  // eslint-disable-next-line no-unused-vars
  hasConsent: (category) => false,

  // Preview overrides (?pzn=, ?pzn-geo=, ...): 'preview' = aem.page and
  // localhost only, 'always', or 'never'.
  overrides: 'preview',

  // Crawlers always get the default variant (no cloaking).
  botsGetDefault: true,

  // Exposure tracking.
  analytics: { dataLayer: true, rum: true },
};

/* eslint-disable no-console */
/*
 * Browser glue for the section runtime (sections.js) and its sources: preview
 * overrides, consent, bot check, visitor context, app state, exposure
 * tracking, the debug log and the one public API, window.hlx.personalization.
 */

import config from './config.js';
import {
  parseCookies, readGeo, parseGeo, getDevice, getVisitor, syncConsentCookie, isBot,
  readParams, overridesEnabled, readOverrides, loadState, saveState,
} from './context.js';

const search = new URLSearchParams(window.location.search);

// Preview hosts (aem.page, localhost) by default; see config.overrides.
export const previewHost = overridesEnabled(config.overrides, window.location.hostname);
export const overrides = readOverrides(previewHost ? search : new URLSearchParams());
export const debug = search.has('pzn-debug');

// One row per decision or offer, shown as a table with ?pzn-debug.
export const decisions = [];
let debugTimer;

/**
 * Records a decision for ?pzn-debug and window.hlx.personalization.decisions.
 * @param {object} row
 * @returns {object} the row, which may be updated later (call log again to reprint)
 */
export function log(row) {
  if (!decisions.includes(row)) decisions.push(row);
  if (debug) {
    clearTimeout(debugTimer);
    debugTimer = setTimeout(() => console.table(decisions), 100);
  }
  return row;
}

/**
 * @returns {boolean} personalization consent, honoring the ?pzn-consent override
 */
export function hasConsent() {
  if (overrides.consent !== undefined) return overrides.consent;
  try {
    return !!config.hasConsent('personalization');
  } catch (e) {
    return false;
  }
}

/**
 * Crawlers get the authored content. Preview overrides win, since headless
 * test browsers look like bots.
 * @returns {boolean}
 */
export function isCrawler() {
  return config.botsGetDefault !== false && !overrides.any && isBot(navigator.userAgent);
}

// App state (quiz answers, app state), shared by every runtime on the page.
const state = {};
let stateLoaded = false;

// Persisted state, read only with consent; values set on this page win.
function mergeStorage() {
  if (hasConsent()) Object.assign(state, { ...loadState(window.localStorage), ...state });
}

/**
 * The shared state object: persisted state, then ?pzn-state overrides, then
 * setState values.
 * @returns {object}
 */
export function currentState() {
  if (!stateLoaded) {
    stateLoaded = true;
    mergeStorage();
    Object.assign(state, overrides.context.state || {});
  }
  return state;
}

let geoPromise;

async function lookupGeo() {
  const { endpoint, timeout } = config.geo || {};
  if (!endpoint) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout || 500);
  try {
    const response = await fetch(endpoint, { signal: controller.signal });
    const json = response.ok ? await response.json() : {};
    return parseGeo(json.region ? `${json.country}-${json.region}` : json.country);
  } catch (e) {
    console.warn('⚠️ personalization: geo lookup failed:', e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The visitor's context, read fresh on every call.
 * @param {{needGeo?: boolean}} [options] needGeo: call config.geo.endpoint
 *   (opt-in) when no edge meta tag or cookie provides geo
 * @returns {Promise<object>} { geo, device, visitor, params, state, consent }
 */
export async function getContext({ needGeo = false } = {}) {
  const consent = hasConsent();
  const cookies = parseCookies(document.cookie);
  const writeCookie = (cookie) => { document.cookie = cookie; };
  syncConsentCookie(consent, cookies, writeCookie, window.localStorage);
  const context = {
    geo: readGeo(document, cookies),
    device: getDevice(config.devices, (query) => window.matchMedia(query)),
    visitor: getVisitor(cookies, consent, writeCookie),
    params: readParams(search),
    state: { ...currentState() },
    consent,
  };
  ['geo', 'device', 'visitor'].forEach((key) => {
    if (overrides.context[key]) context[key] = overrides.context[key];
  });
  if (needGeo && !context.geo) {
    geoPromise = geoPromise || lookupGeo();
    context.geo = await geoPromise;
  }
  return context;
}

/**
 * Custom audiences from config.js, plus those forced with ?pzn-audience.
 * @returns {object}
 */
export function getAudiences() {
  const audiences = { ...(config.audiences || {}) };
  overrides.audiences.forEach((name) => { audiences[name] = true; });
  return audiences;
}

/**
 * Fires `personalization:applied` and feeds the configured analytics.
 * @param {Element} element the section the decision applies to
 * @param {object} detail { id, variant, source, tracking }
 */
export function track(element, detail) {
  element.dispatchEvent(new CustomEvent('personalization:applied', { bubbles: true, detail }));
  if (config.analytics?.dataLayer) {
    window.adobeDataLayer = window.adobeDataLayer || [];
    window.adobeDataLayer.push({ event: 'personalization:applied', personalization: detail });
  }
  if (config.analytics?.rum) {
    // RUM reports A/B tests from the `experiment` checkpoint, as aem-experimentation does.
    const checkpoint = detail.source === 'split' || detail.tracking?.split ? 'experiment' : 'audience';
    import('../aem.js')
      .then(({ sampleRUM }) => {
        if (typeof sampleRUM === 'function') sampleRUM(checkpoint, { source: detail.id, target: detail.variant });
      })
      .catch(() => {});
  }
}

// Runtimes (sections.js) that re-decide on state or consent changes.
const runtimes = [];

/**
 * @param {{refresh?: Function, stateChanged?: Function}} runtime
 */
export function register(runtime) {
  runtimes.push(runtime);
}

/**
 * @param {string} key
 * @returns {string|undefined}
 */
export function getState(key) {
  return currentState()[key];
}

/**
 * Sets a state value (quiz answer, app state) and re-decides what depends on
 * it. Persisted in localStorage only with consent.
 * @param {string} key
 * @param {string|null} value null removes the key
 * @returns {Promise<void>}
 */
export async function setState(key, value) {
  currentState();
  if (value === null || value === undefined) delete state[key];
  else state[key] = String(value);
  if (hasConsent()) saveState(window.localStorage, state);
  document.dispatchEvent(new CustomEvent('personalization:state-changed', { detail: { key, value } }));
  await Promise.all(runtimes.map((runtime) => runtime.stateChanged?.(key)));
}

let refreshing;

/**
 * Re-decides everything, e.g. after a consent change. Calls in the same task
 * (the site's CMP hook and the consent.update listener) share one run.
 * @returns {Promise<void>}
 */
export function refresh() {
  refreshing = refreshing || Promise.resolve().then(async () => {
    refreshing = null;
    // Consent may have been granted since: pick up persisted state.
    if (stateLoaded) mergeStorage();
    await Promise.all(runtimes.map((runtime) => runtime.refresh?.()));
  });
  return refreshing;
}

// A CMP stand-in or the site's consent glue may announce consent changes.
let lastConsent = hasConsent();
window.addEventListener('consent.update', () => {
  const consent = hasConsent();
  if (consent === lastConsent) return;
  lastConsent = consent;
  refresh();
});

window.hlx = window.hlx || {};
window.hlx.personalization = {
  setState, getState, refresh, decisions,
};

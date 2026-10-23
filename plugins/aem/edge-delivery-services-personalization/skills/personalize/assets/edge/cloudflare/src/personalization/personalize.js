/* global globalThis */
/* eslint-disable no-console */
/*
 * Edge personalization for the AEM Cloudflare worker.
 *
 * Runs after the origin fetch, so the CDN cache key and cached HTML are
 * untouched. It decides personalized sections (Section Metadata,
 * section-spec.js) with source rules, api or split, with the same modules as
 * the browser: the section's children become the variant fragment's content
 * and the section is marked data-pzn-source="edge", so the browser shows it at
 * once and never decides it again. target sections, and sections needing
 * browser-only criteria (device, state, audience), are left for the browser.
 */

import { CLIENT_ONLY_CRITERIA } from './rules.js';
import { parseSection, decideSection, sectionCriteria } from './section-spec.js';
import { buildRequest, cacheKey, sanitizeRequest } from './contract.js';
import { callEngine } from './provider-api.js';
import {
  parseCookies, getVisitor, isBot, readParams, overridesEnabled, readOverrides, COOKIE_CONSENT,
} from './context.js';
import {
  findBlocks, findSections, sections, openingTag, applyEdits, injectHead, escapeAttr,
} from './html.js';
import { contractSpecs } from './sources/api.js';
import {
  COOKIE as SPLIT_COOKIE, parseAssignments, formatAssignments, assign,
} from './sources/split.js';

const MAX_API_BODY_BYTES = 16384;
const ROUTE_TIMEOUT_MS = 2000;
const FRAGMENT_TIMEOUT_MS = 1000;
// Sources the edge decides; target (and site-registered providers) stay in the browser.
export const EDGE_SOURCES = ['rules', 'api', 'split'];

/**
 * @param {Request} request
 * @param {object} [cf] request.cf
 * @returns {boolean}
 */
export function isBotRequest(request, cf) {
  return cf?.botManagement?.verifiedBot === true || isBot(request.headers.get('user-agent'));
}

/**
 * Context the edge can know. Device, state and audiences are browser-only.
 * @param {Request} request
 * @param {object} [cf]
 * @returns {object}
 */
export function edgeContext(request, cf) {
  const url = new URL(request.url);
  const cookies = parseCookies(request.headers.get('cookie'));
  let geo = null;
  if (cf?.country && /^[a-z]{2}$/i.test(cf.country)) {
    geo = { country: cf.country.toUpperCase() };
    if (cf.regionCode) geo.region = String(cf.regionCode).toUpperCase();
  }
  return {
    geo,
    visitor: getVisitor(cookies, false),
    params: readParams(url.searchParams),
    state: {},
    consent: cookies[COOKIE_CONSENT] === '1',
  };
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function engineOptions(config, env) {
  const { api } = config;
  return {
    headers: api.headers ? api.headers(env) : {},
    mapRequest: api.mapRequest,
    mapResponse: api.mapResponse,
  };
}

/**
 * Asks the engine for a batch of sections, using the Cache API for
 * responses the engine marks cacheable. Resolves to null on any failure.
 */
async function edgeDecisions({
  specs, context, path, env, config, fetchImpl, cache, ctx,
}) {
  const url = env.PZN_API_ENDPOINT || config.api.endpoint;
  if (!specs.length || !url) return null;
  if (!context.consent && !config.api.sendWithoutConsent) return null;
  const body = buildRequest({
    path, specs, context, consent: context.consent, mode: 'edge',
  });
  const key = cache ? new Request(`https://pzn-cache.invalid/${await sha256(cacheKey(body))}`) : null;
  try {
    if (key) {
      const hit = await cache.match(key);
      if (hit) return (await hit.json()).decisions;
    }
    const result = await callEngine({
      url, body, fetchImpl, timeout: config.api.timeout || 300, ...engineOptions(config, env),
    });
    if (key && result.cacheable && result.ttl > 0) {
      const stored = new Response(JSON.stringify(result), {
        headers: { 'content-type': 'application/json', 'cache-control': `max-age=${result.ttl}` },
      });
      const put = cache.put(key, stored);
      if (ctx?.waitUntil) ctx.waitUntil(put); else await put;
    }
    return result.decisions;
  } catch (error) {
    console.warn('⚠️ personalization: decision engine failed at the edge, using rules:', error.message);
    return null;
  }
}

const TAG = /<([a-z][a-z0-9-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
const URL_ATTR = /(\s(src|srcset|href)\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi;

/**
 * Rewrites the relative URLs (src, srcset, href) of a fragment's markup
 * against the fragment's path, as loadFragment does for ./media_ images, so
 * they still resolve once the markup sits in another page.
 * @param {string} markup
 * @param {string} path fragment path
 * @returns {string}
 */
export function absolutizeUrls(markup, path) {
  const base = new URL(path, 'https://fragment.invalid');
  const resolve = (value) => {
    if (!value || /^([a-z][a-z0-9+.-]*:|\/|#|\?)/i.test(value)) return value;
    try {
      const url = new URL(value, base);
      return url.pathname + url.search + url.hash;
    } catch (e) {
      return value;
    }
  };
  return markup.replace(TAG, (tag, name, attrs) => `<${name}${attrs.replace(URL_ATTR, (match, prefix, attr, double, single) => {
    const value = double ?? single;
    const out = attr.toLowerCase() === 'srcset'
      ? value.split(',').map((candidate) => {
        const [url, ...descriptor] = candidate.trim().split(/\s+/);
        return [resolve(url), ...descriptor].join(' ');
      }).join(', ')
      : resolve(value.trim());
    const quote = double === undefined ? "'" : '"';
    return `${prefix}${quote}${out}${quote}`;
  })}>`);
}

/**
 * The content of a variant fragment's .plain.html, as the browser runtime
 * shows it: the children of every fragment section, concatenated, with the
 * fragment's own Section Metadata left out.
 * @param {string} text .plain.html
 * @param {string} path fragment path
 * @returns {string|null} null when the fragment has no element content
 */
export function fragmentMarkup(text, path) {
  const source = applyEdits(text, findBlocks(text, 'section-metadata')
    .map((block) => ({ start: block.start, end: block.end, text: '' })));
  const parts = sections(source).map((section) => source.slice(section.openEnd, section.closeStart));
  const markup = (parts.length ? parts.join('') : source).trim();
  return /<[a-z]/i.test(markup) ? absolutizeUrls(markup, path) : null;
}

async function loadFragment(path, fetchFragment, timeout) {
  if (!fetchFragment) return null;
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchFragment(path);
        if (!response || !response.ok) throw new Error(`HTTP ${response?.status}`);
        return fragmentMarkup(await response.text(), path);
      })(),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeout}ms`)), timeout);
      }),
    ]);
  } catch (error) {
    console.warn(`⚠️ personalization: fragment ${path} failed at the edge, the browser decides:`, error.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The edge decision for a personalized section, or null to leave it to the
 * browser.
 * @returns {Promise<{name: string, path?: string}|null>}
 */
async function sectionDecision(spec, {
  bot, context, decisions, prefixes, split,
}) {
  if (bot) return { name: 'default' };
  if (spec.source === 'split') {
    const variant = assign(spec, split.stored[spec.id]);
    split.assigned[spec.id] = variant;
    return spec.variants.find((candidate) => candidate.name === variant) || { name: 'default' };
  }
  const decision = await decideSection(spec, context, {
    apiDecision: spec.source === 'api' && decisions ? decisions[spec.id] : undefined,
    deferCriteria: CLIENT_ONLY_CRITERIA,
    prefixes,
  });
  if (decision.deferred) return null;
  // No engine answer here (no consent cookie, no endpoint, failure) and no
  // rule matched: the browser may still ask the engine.
  if (spec.source === 'api' && !decisions && decision.source === 'default') return null;
  return decision.path ? { name: decision.variant, path: decision.path } : { name: 'default' };
}

/**
 * Decides the page's personalized sections the edge can decide.
 * @returns {Promise<{edits: object[], cookie: string|null}>}
 */
async function personalizeSections(entries, {
  bot, context, decisions, prefixes, cookies, fetchFragment, timeout,
}) {
  const split = { stored: parseAssignments(cookies[SPLIT_COOKIE]), assigned: {} };
  const results = await Promise.all(entries.map(async ({ section, spec }) => {
    const decision = await sectionDecision(spec, {
      bot, context, decisions, prefixes, split,
    });
    if (!decision) return null;
    if (!decision.path) {
      // The authored content is the default: keep it, mark it decided.
      return {
        start: section.start,
        end: section.openEnd,
        text: openingTag(section, { source: 'edge', variant: 'default', status: 'applied' }),
      };
    }
    const markup = await loadFragment(decision.path, fetchFragment, timeout);
    if (markup === null) return null;
    return {
      start: section.start,
      end: section.closeStart,
      text: openingTag(section, {
        source: 'edge', variant: decision.name, fragment: decision.path, status: 'applied',
      }) + markup,
    };
  }));
  const changed = Object.entries(split.assigned).some(([id, variant]) => split.stored[id] !== variant);
  const cookie = changed
    ? `${SPLIT_COOKIE}=${encodeURIComponent(formatAssignments({ ...split.stored, ...split.assigned }))}; Path=/; SameSite=Lax; Secure`
    : null;
  return { edits: results.filter(Boolean), cookie };
}

/**
 * Personalizes an HTML response from the AEM origin.
 * @param {Request} request original visitor request
 * @param {Response} response origin response
 * @param {object} options
 * @param {object} options.config edge-config.js
 * @param {object} [options.env]
 * @param {object} [options.cf] request.cf
 * @param {object} [options.ctx] execution context
 * @param {Function} [options.fetchImpl]
 * @param {Cache} [options.cache] defaults to caches.default when available
 * @param {Function} [options.fetchFragment] path -> Promise<Response> of
 *   `${path}.plain.html` from the AEM origin; without it the edge decides
 *   sections but leaves those showing a variant to the browser
 * @returns {Promise<Response>}
 */
export async function personalizeResponse(request, response, options) {
  const {
    config, env = {}, cf, ctx, fetchImpl = globalThis.fetch,
    cache = globalThis.caches?.default, fetchFragment,
  } = options;
  const url = new URL(request.url);
  if (request.method !== 'GET' || response.status !== 200) return response;
  if (!(response.headers.get('content-type') || '').includes('text/html')) return response;
  if (url.pathname.endsWith('.plain.html')) return response;

  const html = await response.text();
  const original = () => new Response(html, response);
  try {
    const personalized = findSections(html)
      .filter((section) => section.attributes.some(([name]) => name === 'data-personalization'));
    if (!personalized.length) return original();

    const context = edgeContext(request, cf);
    const cookies = parseCookies(request.headers.get('cookie'));
    const prefixes = config.fragmentPrefixes;
    const overrides = overridesEnabled(config.overrides, url.hostname)
      ? readOverrides(url.searchParams) : { any: false };
    const bot = config.botsGetDefault !== false && isBotRequest(request, cf);
    const sectionSpecs = personalized.map((section) => ({ section, spec: parseSection(section.attributes, { prefixes }) }));
    const edgeSections = overrides.any ? [] : sectionSpecs.filter(({ section, spec }) => !spec.errors.length
      && EDGE_SOURCES.includes(spec.source)
      && !section.attributes.some(([name]) => name === 'data-pzn-source'));

    let decisions = null;
    if (!bot && !overrides.any) {
      // One engine call for the page's api sections.
      decisions = await edgeDecisions({
        specs: contractSpecs(edgeSections.filter(({ spec }) => spec.source === 'api').map(({ spec }) => spec)),
        context,
        path: url.pathname,
        env,
        config,
        fetchImpl,
        cache,
        ctx,
      });
    }

    const { edits, cookie } = await personalizeSections(edgeSections, {
      bot,
      context,
      decisions,
      prefixes,
      cookies,
      fetchFragment,
      timeout: config.fragmentTimeout || FRAGMENT_TIMEOUT_MS,
    });

    const geoUsed = sectionSpecs.some(({ spec }) => sectionCriteria(spec).has('geo'));
    const meta = context.geo && geoUsed
      ? `<meta name="pzn-geo" content="${escapeAttr(context.geo.region ? `${context.geo.country}-${context.geo.region}` : context.geo.country)}">`
      : '';
    const out = injectHead(applyEdits(html, edits), meta);

    const headers = new Headers(response.headers);
    // Personalized output must not be stored by shared caches. no-cache (not
    // no-store) keeps the page eligible for the back/forward cache.
    headers.set('cache-control', 'private, no-cache');
    headers.delete('etag');
    headers.delete('content-length');
    headers.set('x-pzn', edits.length ? 'edge' : 'deferred');
    // Split assignments last the browser session, like sessionStorage in the browser.
    if (cookie) headers.append('set-cookie', cookie);
    return new Response(out, { status: response.status, statusText: response.statusText, headers });
  } catch (error) {
    console.error('❌ personalization: edge processing failed, serving origin HTML:', error);
    return original();
  }
}

/**
 * Reads at most `max` bytes of a request body.
 * @param {Request} request
 * @param {number} max
 * @returns {Promise<string|null>} body text, or null when it is larger than max
 */
async function readBounded(request, max) {
  if (Number(request.headers.get('content-length')) > max) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  chunks.reduce((offset, chunk) => {
    bytes.set(chunk, offset);
    return offset + chunk.byteLength;
  }, 0);
  return new TextDecoder().decode(bytes);
}

function isSameOrigin(request, url) {
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') return false;
  return request.headers.get('origin') === url.origin;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  });
}

/**
 * Same-origin proxy for browser decision requests, attaching the engine
 * secret. Accepts only v1 requests from the site's own pages, with the
 * visitor's consent (unless sendWithoutConsent), and forwards a rebuilt body;
 * the edge config's adapters translate it for non-v1 engines. An optional
 * PZN_RATE_LIMITER binding limits requests per client IP.
 * Returns null for any other request.
 * @param {Request} request
 * @param {object} env
 * @param {object} config
 * @param {Function} [fetchImpl]
 * @returns {Promise<Response|null>}
 */
export async function handleApiRoute(request, env, config, fetchImpl = globalThis.fetch) {
  const url = new URL(request.url);
  if (!config.apiRoute || url.pathname !== config.apiRoute) return null;
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  const upstream = env.PZN_API_ENDPOINT || config.api.endpoint;
  if (!upstream) return new Response('Decision engine not configured', { status: 503 });
  if (!isSameOrigin(request, url)) return new Response('Forbidden', { status: 403 });
  if (env.PZN_RATE_LIMITER) {
    const key = request.headers.get('cf-connecting-ip') || 'unknown';
    const { success } = await env.PZN_RATE_LIMITER.limit({ key });
    if (!success) return new Response('Too Many Requests', { status: 429 });
  }
  const text = await readBounded(request, MAX_API_BODY_BYTES);
  if (text === null) return new Response('Payload Too Large', { status: 413 });
  let body;
  try {
    body = sanitizeRequest(JSON.parse(text));
  } catch (e) {
    body = null;
  }
  if (!body) {
    return new Response('Bad Request: expected a v1 decision request. When the browser calls this route, leave mapRequest/mapResponse empty in scripts/personalization/config.js; set them in edge-config.js instead.', { status: 400 });
  }
  const consent = parseCookies(request.headers.get('cookie'))[COOKIE_CONSENT] === '1'
    && body.context.consent.personalization;
  if (!consent && !config.api.sendWithoutConsent) return new Response('Forbidden: no consent', { status: 403 });
  try {
    const result = await callEngine({
      url: upstream, body, fetchImpl, timeout: ROUTE_TIMEOUT_MS, ...engineOptions(config, env),
    });
    return json(result);
  } catch (error) {
    console.warn('⚠️ personalization: decision route failed:', error.message);
    return json({ decisions: {} }, 502);
  }
}

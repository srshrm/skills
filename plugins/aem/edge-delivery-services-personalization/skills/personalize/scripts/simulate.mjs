#!/usr/bin/env node
/*
 * Runs the runtime's own decision code over a context matrix and prints, per
 * personalized section, the expected variant and the preview override URL
 * that reproduces it. verify-preview.mjs
 * consumes the same cases.
 *
 * Per source: rules -> the section's rule rows; api -> the mock engine's
 * table (--api-decisions), else the rule rows as fallback; split -> the
 * variants the weights allow (`allowed`; one when a split is 0/100); target
 * -> the mock activities (--target), else the authored content (no consent).
 * Every source gets one forced case per variant (?pzn=) and a bot case.
 *
 * Usage:
 *   node simulate.mjs <content/page.html> [--matrix contexts.json]
 *     [--api-decisions decisions.json] [--target activities.json] [--consent]
 *     [--page-url http://localhost:3000/home] [--json]
 *   node simulate.mjs <page.html | URL> --edge [--country IN] [--region KA]
 *     [--cookie "pzn-seen=1"] [--ua "Googlebot"] [--api-endpoint http://localhost:4100/decide]
 *
 * contexts.json: [{ "name": "india mobile", "geo": "IN", "device": "mobile",
 *   "visitor": "returning", "params": {"utm_campaign": "x"}, "state": {"k": "v"},
 *   "audiences": ["vip"] }]   ("bot": true expects the default)
 * decisions.json: the mock engine's file (see mock-decision-api.mjs); with it,
 * api sections are decided as that engine would,
 * per case. activities.json: the mock Target activities (mock-engine.js);
 * with it, target sections get the offer Target would send. Both only answer
 * with consent, so those override URLs add ?pzn-consent=1. --consent adds it
 * to every case (except bots), e.g. to test rule fallbacks while the mock
 * engine fails.
 */

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  EDGE_DIR, RUNTIME_DIR, SHARED_WITH_EDGE, exitOnHelp, importAsset, isMain, parseArgs, readJson,
  readText, sitePrefixes,
} from './lib.mjs';

export const USAGE = `Usage:
  node simulate.mjs <content/page.html> [--matrix contexts.json]
    [--api-decisions decisions.json] [--target activities.json] [--consent]
    [--page-url http://localhost:3000/page] [--json]
  node simulate.mjs <content/page.html | URL> --edge [--country IN] [--region KA]
    [--cookie "pzn-seen=1"] [--ua "Googlebot"] [--api-endpoint http://localhost:4100/decide]
    [--repo .]
Runs the runtime's decision code over a context matrix: expected variant per
personalized section (rules, api, split, target) and the ?pzn= override URL
that reproduces it. --edge prints the edge worker's output and
headers instead. Exit 2 = usage.`;


const runtime = (...parts) => importAsset('runtime', 'scripts', 'personalization', ...parts);
const { parseCondition } = await runtime('rules.js');
const { parseGeo } = await runtime('context.js');
const { buildRequest } = await runtime('contract.js');
const {
  parseSection, listedVariant, decideSection, splitWeights, ATTRIBUTE,
} = await runtime('section-spec.js');
const { contractSpecs } = await runtime('sources', 'api.js');
const { prefetchRequest, toDecision } = await runtime('sources', 'target.js');
const { engineDecide, targetDeliver } = await runtime('mock-engine.js');
const {
  findSections, renderSectionMetadata, textContent,
} = await importAsset('edge', 'cloudflare', 'src', 'personalization', 'html.js');

/**
 * Turns a matrix entry into a rules context plus the override query that
 * reproduces it in the browser.
 * @param {object} entry
 * @returns {{context: object, audiences: string[], query: string}}
 */
export function toCase(entry) {
  const context = { params: { ...(entry.params || {}) }, state: { ...(entry.state || {}) } };
  const query = new URLSearchParams();
  const geo = typeof entry.geo === 'string' ? parseGeo(entry.geo) : entry.geo;
  if (geo) {
    context.geo = geo;
    query.set('pzn-geo', geo.region ? `${geo.country}-${geo.region}` : geo.country);
  }
  if (entry.device) {
    context.device = entry.device;
    query.set('pzn-device', entry.device);
  }
  if (entry.visitor) {
    context.visitor = entry.visitor;
    query.set('pzn-visitor', entry.visitor);
  }
  const state = Object.entries(context.state);
  if (state.length) query.set('pzn-state', state.map(([key, value]) => `${key}:${value}`).join(','));
  const audiences = entry.audiences || [];
  if (audiences.length) query.set('pzn-audience', audiences.join(','));
  Object.entries(context.params).forEach(([key, value]) => query.set(key, value));
  if (entry.forced) query.set('pzn', entry.forced);
  return { context, audiences, query: query.toString() };
}

/**
 * Builds a matrix that exercises every rule of a spec: a baseline with no
 * context, a bot (always the default), one entry satisfying each rule's
 * positive clauses (and each extra condition: engine table rows, Target
 * audiences), and one forced override per variant.
 * @param {object} spec
 * @param {object} [options]
 * @param {{condition: string, clauses: object[]}[]} [options.conditions] extra conditions
 * @param {string[]} [options.variants] variant names (default: the rules' variants)
 * @returns {object[]}
 */
export function autoMatrix(spec, { conditions = [], variants } = {}) {
  const matrix = [{ name: 'no context' }, { name: 'bot', bot: true }];
  [...spec.rules, ...conditions].forEach((rule) => {
    const entry = { name: `matches "${rule.condition}"`, params: {}, state: {} };
    if (matrix.some((existing) => existing.name === entry.name)) return;
    rule.clauses.filter((clause) => !clause.negate).forEach(({ criterion, values }) => {
      const [value] = values;
      const [key, ...rest] = value.split('=');
      if (criterion === 'geo') entry.geo = value;
      if (criterion === 'device') entry.device = value;
      if (criterion === 'visitor') entry.visitor = value;
      if (criterion === 'param') entry.params[key.trim()] = rest.length ? rest.join('=').trim() : '1';
      if (criterion === 'state') entry.state[key.trim()] = rest.length ? rest.join('=').trim() : '1';
      if (criterion === 'audience') entry.audiences = [...(entry.audiences || []), value];
    });
    matrix.push(entry);
  });
  [...(variants || spec.rules.map((rule) => rule.variant)), 'default'].forEach((variant) => {
    matrix.push({ name: `forced ${variant}`, forced: `${spec.id}:${variant}` });
  });
  return matrix;
}

const forcedFor = (entry, id) => (entry.forced
  ? String(entry.forced).split(',').map((pair) => pair.split(':').map((part) => part.trim()))
    .find(([key]) => key === id)?.[1]
  : undefined);

function conditionsOf(table) {
  return Object.keys(table || {}).filter((condition) => condition && condition !== '*').flatMap((condition) => {
    try {
      return [{ condition, clauses: parseCondition(condition) }];
    } catch (e) {
      return [];
    }
  });
}

/**
 * Personalized sections of a page, from source content (Section Metadata,
 * rendered as the pipeline does) or delivered HTML.
 * @param {string} html
 * @param {string[]} [prefixes]
 * @returns {object[]} specs, in page order, with their section index
 */
export function sectionSpecs(html, prefixes) {
  const rendered = renderSectionMetadata(html).html;
  return findSections(rendered)
    .map((section, index) => ({ section, index }))
    .filter(({ section }) => section.attributes.some(([name]) => name === ATTRIBUTE || name.startsWith(`${ATTRIBUTE}-`)))
    .map(({ section, index }) => ({
      ...parseSection(section.attributes, { prefixes }),
      index,
      // what the authored content starts with, to recognize it in the browser
      authoredText: textContent(rendered.slice(section.openEnd, section.closeStart)).slice(0, 80),
    }));
}

/**
 * The expected outcome of one matrix entry for one section, as sections.js
 * decides it.
 * @returns {Promise<object>}
 */
async function sectionCase(spec, entry, {
  engine, activities, prefixes, consent,
}) {
  const { context, audiences, query } = toCase(entry);
  const withConsent = [query, 'pzn-consent=1'].filter(Boolean).join('&');
  const result = (expected, source, extra = {}) => ({
    id: spec.id,
    section: spec.index,
    sourceType: spec.source,
    display: spec.display,
    trigger: spec.trigger || undefined,
    authoredText: spec.authoredText,
    name: entry.name,
    query: consent && !entry.bot ? withConsent : query,
    context: entry,
    expected,
    source,
    ...extra,
  });
  const forced = forcedFor(entry, spec.id);
  const listed = forced && listedVariant(spec, { variant: forced }, prefixes);
  if (listed) return result(listed.name, 'override', { query });
  if (entry.bot) return result('default', 'bot', { query });
  const ruled = async (fallbackSource, reason) => {
    const decision = await decideSection(spec, context, {
      audiences: Object.fromEntries(audiences.map((name) => [name, true])), prefixes,
    });
    if (decision.source === 'rule') return { expected: decision.variant, source: 'rule', rule: decision.rule };
    return { expected: 'default', source: fallbackSource, reason };
  };
  if (spec.source === 'rules') {
    const decision = await ruled('default');
    return result(decision.expected, decision.source, { rule: decision.rule });
  }
  if (spec.source === 'api') {
    if (!engine) {
      const decision = await ruled('fallback', 'no consent');
      return result(decision.expected, decision.source, { query, rule: decision.rule, reason: decision.reason });
    }
    const body = buildRequest({
      path: '/', specs: contractSpecs([spec]), context, consent: true, mode: 'client',
    });
    const answer = (await engineDecide(engine, body)).decisions[spec.id];
    if (!answer) {
      const decision = await ruled('fallback', 'no decision');
      return result(decision.expected, decision.source, { query: withConsent, rule: decision.rule, reason: decision.reason });
    }
    const variant = listedVariant(spec, answer, prefixes);
    if (!variant) return result('default', 'fallback', { query: withConsent, reason: `not listed: ${answer.variant || answer.fragment}` });
    return result(variant.name, 'api', { query: withConsent });
  }
  if (spec.source === 'split') {
    const names = ['default', ...spec.variants.map((variant) => variant.name)];
    const weights = splitWeights(spec.variants.length, spec.split);
    const allowed = names.filter((name, index) => weights[index] > 0);
    return result(allowed.length === 1 ? allowed[0] : null, 'split', { allowed });
  }
  // target
  const noOffer = spec.display === 'popup' ? 'waiting for consent' : 'fallback';
  if (!activities) return result('default', noOffer, { query, reason: 'no consent' });
  const page = { url: `https://simulate.invalid/${query ? `?${new URLSearchParams(context.params)}` : ''}` };
  const response = await targetDeliver(activities, prefetchRequest([spec.id], context, { requestId: 'simulate', page }));
  const answer = toDecision(response.prefetch.mboxes[0]);
  const variant = answer.fragment ? listedVariant(spec, answer, prefixes) : undefined;
  if (!variant) {
    return result('default', 'target', { query: withConsent, reason: answer.fragment ? `not listed: ${answer.fragment}` : 'no offer' });
  }
  return result(variant.name, 'target', { query: withConsent, offer: variant.path });
}

/**
 * Expected decisions for each personalized section of a page.
 * @param {string} html page HTML
 * @param {object} [options]
 * @param {object[]} [options.matrix] shared matrix; default: autoMatrix per section
 * @param {object} [options.engine] mock-decision-api decisions file, applied per case
 * @param {object} [options.activities] mock Target activities
 * @param {string[]} [options.prefixes]
 * @param {boolean} [options.consent] grant consent in every non-bot case
 * @returns {Promise<object[]>} cases, by section id
 */
export async function buildCases(html, {
  matrix, engine, activities, prefixes, consent = false,
} = {}) {
  const cases = await Promise.all(sectionSpecs(html, prefixes).map(async (spec) => {
    if (spec.errors.length) {
      return [{
        id: spec.id || null, section: spec.index, name: 'invalid section', errors: spec.errors,
      }];
    }
    let conditions = [];
    if (spec.source === 'api' && engine) conditions = conditionsOf(engine.placeholders?.[spec.id]);
    if (spec.source === 'target' && activities) {
      conditions = conditionsOf(Object.fromEntries((activities[spec.id]?.experiences || [])
        .map((experience) => [experience.audience, true])));
    }
    const entries = matrix || autoMatrix(spec, { conditions, variants: spec.variants.map((variant) => variant.name) });
    return Promise.all(entries.map((entry) => sectionCase(spec, entry, {
      engine, activities, prefixes, consent,
    })));
  }));
  return cases.flat().sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/**
 * Variant fragments for the simulated edge: content/<path>.html or
 * .plain.html in the repo, else <origin><path>.plain.html for a URL page.
 * @param {string} [repo]
 * @param {string} [origin]
 * @returns {(path: string) => Promise<string|null>}
 */
export function fragmentSource(repo, origin) {
  return async (path) => {
    if (repo) {
      const local = [`${path}.plain.html`, `${path}.html`].map((file) => readText(join(repo, 'content', file))).find(Boolean);
      if (local) return local;
    }
    if (!origin) return null;
    try {
      const response = await fetch(new URL(`${path}.plain.html`, origin));
      return response.ok ? await response.text() : null;
    } catch (e) {
      return null;
    }
  };
}

/**
 * Assembles the edge worker modules in a temp dir (as install-edge would)
 * and runs personalizeResponse over the HTML. Source content is rendered as
 * the pipeline would first (Section Metadata -> data-* attributes).
 * @param {string} html
 * @param {object} options
 * @returns {Promise<{html: string, headers: object, sections: object[]}>}
 */
export async function simulateEdge(source, {
  url = 'https://www.example.com/', country, region, cookie, ua = 'Mozilla/5.0', apiEndpoint, prefixes,
  repo, origin,
} = {}) {
  const html = renderSectionMetadata(source).html;
  const read = fragmentSource(repo, origin);
  const dir = mkdtempSync(join(tmpdir(), 'pzn-edge-'));
  try {
    cpSync(join(EDGE_DIR, 'src', 'personalization'), dir, { recursive: true });
    SHARED_WITH_EDGE.forEach((name) => cpSync(join(RUNTIME_DIR, 'scripts', 'personalization', name), join(dir, name)));
    const { personalizeResponse } = await import(pathToFileURL(join(dir, 'personalize.js')).href);
    const { default: baseConfig } = await import(pathToFileURL(join(dir, 'edge-config.js')).href);
    const config = {
      ...baseConfig,
      fragmentPrefixes: prefixes || baseConfig.fragmentPrefixes,
      api: { ...baseConfig.api, endpoint: apiEndpoint || baseConfig.api.endpoint },
    };
    const headers = { 'user-agent': ua };
    if (cookie) headers.cookie = cookie;
    const request = new Request(url, { headers });
    const response = new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    const fetchFragment = async (path) => {
      const text = await read(path);
      return new Response(text ?? '', { status: text === null ? 404 : 200, headers: { 'content-type': 'text/html' } });
    };
    const out = await personalizeResponse(request, response, {
      config, cf: country ? { country, regionCode: region } : undefined, cache: null, fetchFragment,
    });
    const text = await out.text();
    const attr = (section, name) => section.attributes.find(([key]) => key === name)?.[1];
    const sections = findSections(text).filter((section) => attr(section, ATTRIBUTE) !== undefined).map((section) => ({
      id: attr(section, ATTRIBUTE),
      type: attr(section, `${ATTRIBUTE}-source`) || 'rules',
      source: attr(section, 'data-pzn-source') || 'deferred to browser',
      variant: attr(section, 'data-pzn-variant') || null,
      fragment: attr(section, 'data-pzn-fragment') || null,
    }));
    return { html: text, headers: Object.fromEntries(out.headers), sections };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function loadHtml(target) {
  if (/^https?:\/\//.test(target)) {
    const response = await fetch(target);
    if (!response.ok) throw new Error(`${target}: HTTP ${response.status}`);
    return response.text();
  }
  const html = readText(resolve(target));
  if (html === null) throw new Error(`${target} not found`);
  return html;
}

if (isMain(import.meta.url)) {
  exitOnHelp(USAGE);
  const args = parseArgs(process.argv.slice(2));
  const target = args._[0];
  if (!target) {
    console.error(`❌ ${USAGE}`);
    process.exit(2);
  }
  const prefixes = sitePrefixes(resolve(args.repo || process.cwd()));
  const html = await loadHtml(target);
  if (args.edge) {
    const result = await simulateEdge(html, {
      url: /^https?:\/\//.test(target) ? target : undefined,
      country: args.country,
      region: args.region,
      cookie: args.cookie,
      ua: args.ua,
      apiEndpoint: args['api-endpoint'],
      prefixes,
      repo: resolve(args.repo || process.cwd()),
      origin: /^https?:\/\//.test(target) ? new URL(target).origin : undefined,
    });
    if (args.json) {
      console.log(JSON.stringify({ headers: result.headers, sections: result.sections }, null, 2));
    } else {
      console.log(`cache-control: ${result.headers['cache-control'] || '(unchanged)'}  x-pzn: ${result.headers['x-pzn'] || '-'}${result.headers['set-cookie'] ? `  set-cookie: ${result.headers['set-cookie']}` : ''}`);
      if (result.sections.length) console.table(result.sections);
    }
  } else {
    const matrix = args.matrix ? readJson(resolve(args.matrix)) : undefined;
    const engine = args['api-decisions'] ? readJson(resolve(args['api-decisions'])) : undefined;
    const activities = typeof args.target === 'string' ? readJson(resolve(args.target)) : undefined;
    const cases = await buildCases(html, {
      matrix, engine, activities, prefixes, consent: !!args.consent,
    });
    const pageUrl = typeof args['page-url'] === 'string' ? args['page-url'] : '';
    cases.forEach((entry) => {
      if (pageUrl && entry.query !== undefined) entry.url = `${pageUrl}${entry.query ? `?${entry.query}` : ''}`;
    });
    if (args.json) console.log(JSON.stringify(cases, null, 2));
    else {
      const expected = (entry) => {
        if (entry.errors) return `INVALID: ${entry.errors.join('; ')}`;
        return entry.expected ?? `one of ${entry.allowed.join(', ')}`;
      };
      console.table(cases.map((entry) => ({
        id: entry.id,
        source: `${entry.sourceType}${entry.display === 'popup' ? ' popup' : ''}`,
        case: entry.name,
        expected: expected(entry),
        'decided by': entry.source,
        url: entry.url || (entry.query ? `?${entry.query}` : ''),
      })));
    }
  }
}

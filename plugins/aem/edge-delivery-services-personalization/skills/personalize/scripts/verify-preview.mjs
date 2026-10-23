#!/usr/bin/env node
/*
 * Verifies personalization in a real browser against a running preview
 * (aem up or *.aem.page). For each case from simulate.mjs it opens the page
 * with the case's override query in a fresh browser context and checks that
 * the section applied the expected variant and rendered its content, with no
 * console errors and CLS within budget.
 *
 * Sections: no section is left pending (hidden); the variant, its source and
 * its content (the variant fragment's heading, or the authored content);
 * bots get the authored content with no decision call and no split
 * assignment; inline target offers send `display` once seen. Popups: closed
 * before the trigger (scroll: 20 points below it), open past it, modal and
 * labelled, `display` notified, Escape closes, no reopen in the page view.
 * Split sections: the assignment survives reloads and new tabs (session);
 * --split-runs N also draws N fresh visitors and reports the distribution.
 * --faults adds, per api and target section, a run with ?pzn-mock-fail
 * (expects the fallback) and ?pzn-mock-latency=3000 (expects the timeout);
 * they need config.mock.
 *
 * Usage:
 *   node verify-preview.mjs --page http://localhost:3000/index
 *     [--file content/index.html | --cases cases.json]
 *     [--matrix contexts.json] [--api-decisions decisions.json] [--target activities.json]
 *     [--consent] [--faults] [--split-runs 30]
 *     [--baseline <url>] [--revisit] [--screenshots dir] [--ignore-console <regex>]
 *     [--repo .] [--json]
 *
 * Without --file/--cases the page's .plain.html is fetched from the preview.
 * --baseline measures another URL (the page before personalization) and fails
 * when CLS regresses. --revisit loads the page, then again as a new session
 * with the persistent cookies kept, and reports both (a returning visitor
 * needs the site's consent hook to grant consent). --api-decisions and
 * --consent grant consent per case with ?pzn-consent=1 (see simulate.mjs), so
 * api sections really call the engine. --ignore-console skips
 * expected console errors, e.g. "status of 5\d\d|ERR_" while the mock engine
 * injects failures.
 * Exits 1 on any failure.
 */

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  PLAYWRIGHT_CACHE, PLAYWRIGHT_INSTALL, exitOnHelp, isMain, loadPlaywright, parseArgs, readJson,
  readText, sitePrefixes, status,
} from './lib.mjs';

export const USAGE = `Usage: node verify-preview.mjs --page http://localhost:3000/<page>
         [--file content/<page>.html | --cases cases.json]
         [--matrix contexts.json] [--api-decisions decisions.json] [--target activities.json]
         [--consent] [--faults] [--split-runs 30]
         [--baseline <url>] [--revisit] [--screenshots dir] [--ignore-console <regex>]
         [--repo .] [--json]
Playwright check against a running preview (aem up or *.aem.page): each case
applies its variant, renders content, leaves no section hidden, logs no console
errors, keeps CLS within budget; popups open at their trigger, once; splits
stay sticky; bots make no decision calls; --faults checks the fallbacks. Playwright loads from this skill's folder or ~/.cache/aem-eds-personalization/playwright,
never the site. Exit 1 = a case failed, 2 = usage or Playwright not found.`;

import { buildCases } from './simulate.mjs';
import { readSiteConfig } from './validate-placeholders.mjs';

const VIEWPORTS = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 900 },
};
// Headless Chromium announces itself as HeadlessChrome, which the runtime
// treats as a bot; cases browse as regular Chrome unless they test bots.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const BOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const CLS_BUDGET = 0.1;
const CLS_REGRESSION = 0.02;
const APPLY_TIMEOUT_MS = 10000;
const DELIVERY_URL = /\.tt\.omtrdc\.net\/|\/rest\/v1\/delivery/;

// Records personalization events for the checks below.
const EVENTS_SCRIPT = `(() => {
  window.__pznEvents = [];
  ['personalization:applied', 'personalization:notified'].forEach((name) => document.addEventListener(name,
    (event) => window.__pznEvents.push({ ...event.detail, event: name })));
})();`;

// Collects CLS (excluding shifts right after input) and LCP from page start.
const VITALS_SCRIPT = `(() => {
  window.__pzn = { cls: 0, lcp: 0 };
  try {
    new PerformanceObserver((list) => list.getEntries().forEach((entry) => {
      if (!entry.hadRecentInput) window.__pzn.cls += entry.value;
    })).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((list) => list.getEntries().forEach((entry) => {
      window.__pzn.lcp = entry.startTime;
    })).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (e) { /* unsupported */ }
})();`;

function requirePlaywright() {
  const playwright = loadPlaywright();
  if (!playwright) {
    console.error(`❌ playwright not found in this skill's folder or ${PLAYWRIGHT_CACHE}; install it there (never in the site): ${PLAYWRIGHT_INSTALL}`);
    process.exit(2);
  }
  return playwright;
}

/**
 * The .plain.html URL of a preview page (query dropped, / → index).
 * @param {string} page
 * @returns {string}
 */
export function plainUrl(page) {
  const url = new URL(page);
  url.search = '';
  url.pathname = url.pathname.endsWith('/') ? `${url.pathname}index.plain.html` : `${url.pathname}.plain.html`;
  return url.href;
}

function withQuery(page, query) {
  const url = new URL(page);
  new URLSearchParams(query).forEach((value, key) => url.searchParams.set(key, value));
  return url.href;
}

async function settle(page) {
  await page.waitForLoadState('load');
  // Lazy sections decorate after load; give them a moment, then scroll so
  // below-the-fold sections are reached.
  await page.evaluate(async () => {
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((done) => { setTimeout(done, 300); });
    window.scrollTo(0, 0);
  });
}

async function readSections(page) {
  return page.evaluate(() => [...document.querySelectorAll('main > .section[data-personalization]')]
    .map((section) => ({
      id: section.dataset.personalization,
      variant: section.dataset.pznVariant || null,
      source: section.dataset.pznSource || null,
    })));
}

async function measure(context, url, ignoreConsole) {
  const page = await context.newPage();
  const errors = collectErrors(page, ignoreConsole);
  await page.goto(url, { waitUntil: 'load' });
  await settle(page);
  await page.waitForTimeout(500);
  const vitals = await page.evaluate(() => window.__pzn);
  await page.close();
  return { ...vitals, errors };
}

// Errors that point at personalization itself never count as pre-existing.
const OWN_ERROR = /personaliz|pzn|\/fragments\//i;

function collectErrors(page, ignoreConsole) {
  const errors = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const where = message.location()?.url;
    const text = where && !message.text().includes(where) ? `${message.text()} (${where})` : message.text();
    if (!(ignoreConsole && ignoreConsole.test(text))) errors.push(text);
  });
  page.on('pageerror', (error) => errors.push(`${error.message}${OWN_ERROR.test(error.stack || '') ? ' [personalization]' : ''}`));
  return errors;
}

/**
 * Splits console errors into the ones a case introduced and the ones the page
 * already had: seen on the baseline run or on a no-context (default) case, and
 * not about personalization. Pre-existing errors are reported, never failed.
 * @param {object[]} results case results with errors[] and query
 * @param {string[]} [baselineErrors]
 * @returns {{results: object[], preExisting: string[]}}
 */
export function splitConsoleErrors(results, baselineErrors = []) {
  const reference = new Set([
    ...baselineErrors,
    ...results.filter((result) => !result.query).flatMap((result) => result.errors),
  ].filter((error) => !OWN_ERROR.test(error)));
  const preExisting = new Set();
  const split = results.map((result) => {
    const own = result.errors.filter((error) => {
      if (!reference.has(error)) return true;
      preExisting.add(error);
      return false;
    });
    const problems = [...result.problems];
    if (own.length) problems.push(`console errors: ${own.slice(0, 3).join(' | ')}`);
    return { ...result, problems, ok: !problems.length };
  });
  return { results: split, preExisting: [...preExisting] };
}

const slug = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

async function readSection(page, id) {
  return page.evaluate((sectionId) => {
    const el = document.querySelector(`[data-personalization="${CSS.escape(sectionId)}"]`);
    if (!el) return null;
    const row = (window.hlx?.personalization?.decisions || []).find((entry) => entry.id === sectionId);
    return {
      variant: el.dataset.pznVariant || null,
      source: el.dataset.pznSource || null,
      reason: el.dataset.pznReason || null,
      status: el.dataset.pznStatus || null,
      sectionStatus: el.dataset.sectionStatus || null,
      hidden: getComputedStyle(el).display === 'none',
      text: el.textContent.replace(/\s+/g, ''),
      fragment: el.dataset.pznFragment || null,
      variants: (el.dataset.personalizationVariants || '').split(',').map((item) => item.trim()).filter(Boolean),
      row: row ? { ...row } : null,
      // pzn-pending (deciding), pzn-ready / pzn-waiting (below a section still deciding)
      pending: document.querySelectorAll('[data-section-status^="pzn-"]').length,
      mock: !!window.hlx?.personalizationMock,
      mockCalls: window.hlx?.personalizationMock?.requests?.length || 0,
      splitKeys: Object.keys(sessionStorage).filter((key) => key.startsWith('pzn-split')).length,
    };
  }, id);
}

// The fragment a section shows for a variant, as a same-origin path.
function variantPath(found, variant) {
  if (found.fragment) return found.fragment;
  const href = found.variants.find((item) => slug(item.split('/').filter(Boolean).pop()) === slug(variant));
  if (!href) return null;
  try {
    return new URL(href, 'https://x.invalid').pathname.replace(/\.(plain\.)?html$/, '');
  } catch (e) {
    return null;
  }
}

// The first heading of a fragment (else its first words), spaces removed.
async function fragmentSignature(page, path) {
  return page.evaluate(async (fragment) => {
    try {
      const response = await fetch(`${fragment}.plain.html`);
      if (!response.ok) return null;
      const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      const heading = doc.querySelector('h1, h2, h3, h4, h5, h6');
      return (heading || doc.body).textContent.replace(/\s+/g, '').slice(0, 40) || null;
    } catch (e) {
      return null;
    }
  }, path);
}

// The start of a section's authored content, from the page's .plain.html as
// the browser parses it (the page itself may already show a variant).
async function authoredSignature(page, pageUrl, index) {
  return page.evaluate(async ([plain, position]) => {
    try {
      const response = await fetch(plain);
      if (!response.ok) return null;
      const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      const section = [...(doc.querySelector('main') || doc.body).children].filter((el) => el.tagName === 'DIV')[position];
      if (!section) return null;
      section.querySelectorAll('.section-metadata').forEach((block) => block.remove());
      return section.textContent.replace(/\s+/g, '').slice(0, 40) || null;
    } catch (e) {
      return null;
    }
  }, [plainUrl(pageUrl), index]);
}

async function scrollToRatio(page, ratio) {
  await page.evaluate(async (r) => {
    window.scrollTo(0, Math.max(0, document.documentElement.scrollHeight * r - window.innerHeight));
    await new Promise((done) => { setTimeout(done, 400); });
  }, ratio);
}

// Waits for a `personalization:notified` event of the given type (display, click).
const notified = (page, id, type, timeout = 5000) => page.waitForFunction(
  ([sectionId, kind]) => (window.__pznEvents || []).some((event) => event.event === 'personalization:notified'
    && event.id === sectionId && event.type === kind),
  [id, type],
  { timeout },
).then(() => true, () => false);

async function checkContent(page, found, variant, entry, problems, pageUrl) {
  if (variant === 'default') {
    const authored = (entry.section !== undefined && await authoredSignature(page, pageUrl, entry.section))
      || String(entry.authoredText || '').replace(/\s+/g, '').slice(0, 40);
    if (authored && !found.text.includes(authored)) problems.push('the authored content is not shown');
    return;
  }
  const path = variantPath(found, variant);
  const signature = path && await fragmentSignature(page, path);
  if (!signature) problems.push(`could not read the "${variant}" fragment${path ? ` ${path}` : ''}`);
  else if (!found.text.includes(signature)) problems.push(`content of "${variant}" (${path}) not rendered`);
}

async function checkPopup(page, entry, found, problems, notes, pageUrl) {
  const row = found.row || {};
  const dialogOpen = () => page.$('dialog.target-popup[open]');
  if (entry.expected === 'default') {
    if (row.status === 'armed' || row.status === 'displayed') problems.push(`offer "${row.variant}" armed, expected none`);
    if (entry.source === 'waiting for consent' && row.status !== 'waiting for consent') problems.push(`status "${row.status}", expected "waiting for consent"`);
    if (entry.expectStatus && !new RegExp(entry.expectStatus).test(row.status || '')) problems.push(`status "${row.status}", expected ${entry.expectStatus}`);
    await scrollToRatio(page, 1);
    if (await dialogOpen()) problems.push('a popup opened although no offer was expected');
    return { variant: 'default', source: row.source || null };
  }
  if (row.status !== 'armed') {
    problems.push(`popup ${row.status || 'never armed'}, expected offer "${entry.expected ?? entry.allowed}"`);
    return { variant: row.variant || null, source: row.source || null };
  }
  if (entry.expected && row.variant !== entry.expected) problems.push(`offer "${row.variant}" (source ${row.source}), expected "${entry.expected}"`);
  const trigger = entry.trigger || { type: 'scroll', ratio: 0.7 };
  if (trigger.type === 'scroll') {
    const before = trigger.ratio - 0.2;
    const reachable = await page.evaluate((r) => window.innerHeight / document.documentElement.scrollHeight < r, before);
    if (before > 0 && reachable) {
      await scrollToRatio(page, before);
      if (await dialogOpen()) problems.push(`popup open at ${Math.round(before * 100)}% scroll, before its ${Math.round(trigger.ratio * 100)}% trigger`);
    } else {
      notes.push('page too short to check the popup stays closed before its trigger');
    }
    await scrollToRatio(page, Math.min(1, trigger.ratio + 0.02));
  } else if (trigger.type === 'view') {
    await page.evaluate((id) => document.querySelector(`[data-personalization="${CSS.escape(id)}"]`).scrollIntoView(), entry.id);
  }
  const opened = await page.waitForSelector('dialog.target-popup[open]', { timeout: 5000 }).catch(() => null);
  if (!opened) {
    problems.push(`popup did not open past its trigger (${trigger.type}${trigger.ratio ? ` ${Math.round(trigger.ratio * 100)}%` : ''})`);
    return { variant: row.variant, source: row.source };
  }
  const dialog = await page.evaluate(() => {
    const el = document.querySelector('dialog.target-popup[open]');
    const labelledBy = el.getAttribute('aria-labelledby');
    const label = (labelledBy && document.getElementById(labelledBy)?.textContent.trim()) || el.getAttribute('aria-label') || '';
    return { modal: el.matches(':modal'), label, text: el.textContent.replace(/\s+/g, '') };
  });
  if (!dialog.modal) problems.push('popup is not modal');
  if (!dialog.label) problems.push('popup has no accessible name');
  await checkContent(page, { ...found, text: dialog.text }, row.variant, entry, problems, pageUrl);
  if (row.source === 'target' && !await notified(page, entry.id, 'display')) problems.push('no display notification for the shown offer');
  await page.keyboard.press('Escape');
  const closed = await page.waitForSelector('dialog.target-popup', { state: 'detached', timeout: 2000 }).then(() => true, () => false);
  if (!closed) problems.push('Escape did not close the popup');
  await scrollToRatio(page, 0);
  await scrollToRatio(page, 1);
  await page.waitForTimeout(300);
  if (await dialogOpen()) problems.push('popup opened again in the same page view');
  return { variant: row.variant, source: row.source, label: dialog.label };
}

/**
 * Runs one case.
 * @returns {Promise<object>} result with ok, problems
 */
async function runCase(browser, pageUrl, entry, { screenshots, ignoreConsole, apiPath }) {
  const device = entry.context?.device;
  const bot = !!entry.context?.bot;
  const popup = entry.display === 'popup';
  const context = await browser.newContext({
    viewport: VIEWPORTS[device] || VIEWPORTS.desktop,
    userAgent: bot ? BOT_UA : BROWSER_UA,
  });
  await context.addInitScript(VITALS_SCRIPT);
  await context.addInitScript(EVENTS_SCRIPT);
  const page = await context.newPage();
  const errors = collectErrors(page, ignoreConsole);
  const calls = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (DELIVERY_URL.test(request.url()) || (apiPath && pathname === apiPath)) calls.push(request.url());
  });
  const url = withQuery(pageUrl, entry.query || '');
  const problems = [];
  const notes = [];
  let outcome = {};
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load');
    // Popups must see the page unscrolled; other cases scroll once so lazy content loads.
    if (!popup) await settle(page);
    const ready = popup
      ? (id) => !!(window.hlx?.personalization?.decisions || []).find((row) => row.id === id && row.status)
      : (id) => {
        const el = document.querySelector(`[data-personalization="${CSS.escape(id)}"]`);
        return !!el && !!el.dataset.pznStatus && el.dataset.sectionStatus === 'loaded';
      };
    await page.waitForFunction(ready, entry.id, { timeout: APPLY_TIMEOUT_MS }).catch(() => {});
    await page.waitForTimeout(300);
    const found = await readSection(page, entry.id);
    if (!found) {
      problems.push('section not found: are the scripts.js hooks installed and is Section Metadata rendered as data-personalization attributes (rendering v2)?');
    } else {
      if (found.pending) problems.push(`${found.pending} section(s) left hidden (data-section-status pzn-*)`);
      if (found.hidden) problems.push('section is hidden');
      if (entry.fault && !found.mock) problems.push('mock faults need config.mock (the in-browser mocks are not active)');
      if (popup) {
        outcome = await checkPopup(page, entry, found, problems, notes, pageUrl);
      } else {
        outcome = { variant: found.variant, source: found.source, reason: found.reason };
        if (!found.status) problems.push('section never decided: is the loadEager hook installed?');
        else {
          if (entry.expected !== null && entry.expected !== undefined && found.variant !== entry.expected) {
            problems.push(`variant "${found.variant}" (source ${found.source}${found.reason ? `, ${found.reason}` : ''}), expected "${entry.expected}"`);
          }
          if (entry.allowed && !entry.allowed.includes(found.variant)) problems.push(`variant "${found.variant}" is not one of ${entry.allowed.join(', ')}`);
          if (entry.expectSource && !entry.expectSource.includes(found.source)) {
            problems.push(`source "${found.source}"${found.reason ? ` (${found.reason})` : ''}, expected ${entry.expectSource.join(' or ')}`);
          }
          await checkContent(page, found, found.variant, entry, problems, pageUrl);
          if (found.source === 'target' && found.variant !== 'default') {
            await page.evaluate((id) => document.querySelector(`[data-personalization="${CSS.escape(id)}"]`).scrollIntoView(), entry.id);
            if (!await notified(page, entry.id, 'display')) problems.push('no display notification once the offer was seen');
          }
        }
      }
      if (bot) {
        if (outcome.source && !['bot', 'edge'].includes(outcome.source)) problems.push(`source "${outcome.source}", expected the bot default`);
        if (outcome.variant && outcome.variant !== 'default') problems.push(`bot saw "${outcome.variant}"`);
        const after = await readSection(page, entry.id);
        if (calls.length || after?.mockCalls) problems.push(`bot caused ${calls.length + (after?.mockCalls || 0)} decision call(s)`);
        if (after?.splitKeys) problems.push('bot was assigned a split variant');
      }
    }
    const vitals = await page.evaluate(() => window.__pzn);
    if (vitals && vitals.cls > CLS_BUDGET) problems.push(`CLS ${vitals.cls.toFixed(3)} > ${CLS_BUDGET}`);
    if (screenshots) {
      mkdirSync(screenshots, { recursive: true });
      const name = `${entry.id}--${String(entry.name).replace(/[^a-z0-9]+/gi, '-')}.png`;
      await page.screenshot({ path: join(screenshots, name), fullPage: !popup });
    }
    return {
      id: entry.id,
      case: entry.name,
      query: entry.query || '',
      url,
      expected: entry.expected ?? (entry.allowed ? `one of ${entry.allowed.join(', ')}` : null),
      actual: outcome.variant ?? null,
      source: outcome.source ?? null,
      cls: vitals ? Number(vitals.cls.toFixed(3)) : null,
      lcp: vitals ? Math.round(vitals.lcp) : null,
      ok: !problems.length,
      problems,
      notes,
      errors,
    };
  } finally {
    await context.close();
  }
}

/**
 * Fault cases for api and target sections: the mock fails (fallback) or
 * answers after 3 s (timeout; held sections only).
 * @param {object[]} cases section cases from simulate
 * @returns {object[]}
 */
export function faultCases(cases) {
  const seen = new Set();
  return cases.filter((entry) => ['api', 'target'].includes(entry.sourceType)
    && !entry.errors && !seen.has(entry.id) && seen.add(entry.id))
    .flatMap((entry) => {
      const base = {
        id: entry.id,
        section: entry.section,
        sourceType: entry.sourceType,
        display: entry.display,
        trigger: entry.trigger,
        authoredText: entry.authoredText,
        context: {},
        fault: true,
      };
      if (entry.display === 'popup') {
        return [{
          ...base, name: 'mock failure', query: 'pzn-consent=1&pzn-mock-fail', expected: 'default', expectStatus: '^error',
        }];
      }
      return [
        {
          ...base, name: 'mock failure', query: 'pzn-consent=1&pzn-mock-fail', expected: null, expectSource: ['fallback', 'rule'],
        },
        {
          ...base, name: 'mock latency 3000ms', query: 'pzn-consent=1&pzn-mock-latency=3000', expected: 'default', expectSource: ['timeout'],
        },
      ];
    });
}

/**
 * Split sections: the assignment holds across reloads and new tabs in one
 * session; with runs, fresh visitors are drawn and counted.
 * @returns {Promise<object[]>}
 */
async function checkSplits(browser, pageUrl, cases, { runs = 0 } = {}) {
  const splits = cases.filter((entry) => entry.sourceType === 'split'
    && entry.name === 'no context' && entry.allowed);
  if (!splits.length) return [];
  const ids = splits.map((entry) => entry.id);
  const visit = async (page) => {
    await page.waitForFunction((list) => list.every((id) => document.querySelector(`[data-personalization="${CSS.escape(id)}"]`)?.dataset.pznStatus), ids, { timeout: APPLY_TIMEOUT_MS }).catch(() => {});
    return page.evaluate((list) => Object.fromEntries(list.map((id) => [id, document.querySelector(`[data-personalization="${CSS.escape(id)}"]`)?.dataset.pznVariant || null])), ids);
  };
  const context = await browser.newContext({ viewport: VIEWPORTS.desktop, userAgent: BROWSER_UA });
  const seen = [];
  try {
    const page = await context.newPage();
    await page.goto(pageUrl, { waitUntil: 'load' });
    seen.push(await visit(page));
    for (let i = 0; i < 2; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await page.reload({ waitUntil: 'load' });
      // eslint-disable-next-line no-await-in-loop
      seen.push(await visit(page));
    }
    const tab = await context.newPage();
    await tab.goto(pageUrl, { waitUntil: 'load' });
    seen.push(await visit(tab));
  } finally {
    await context.close();
  }
  const counts = Object.fromEntries(ids.map((id) => [id, {}]));
  for (let i = 0; i < runs; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const fresh = await browser.newContext({ viewport: VIEWPORTS.desktop, userAgent: BROWSER_UA });
    try {
      // eslint-disable-next-line no-await-in-loop
      const page = await fresh.newPage();
      // eslint-disable-next-line no-await-in-loop
      await page.goto(pageUrl, { waitUntil: 'load' });
      // eslint-disable-next-line no-await-in-loop
      const variants = await visit(page);
      ids.forEach((id) => { counts[id][variants[id]] = (counts[id][variants[id]] || 0) + 1; });
    } finally {
      // eslint-disable-next-line no-await-in-loop
      await fresh.close();
    }
  }
  return splits.map((entry) => {
    const { id } = entry;
    const problems = [];
    const variants = seen.map((visitVariants) => visitVariants[id]);
    if (new Set(variants).size !== 1) problems.push(`assignment changed within the session: ${variants.join(' → ')}`);
    if (!entry.allowed.includes(variants[0])) problems.push(`variant "${variants[0]}" is not one of ${entry.allowed.join(', ')}`);
    if (runs) {
      const missing = entry.allowed.filter((name) => !counts[id][name]);
      // With 10 draws per variant, a fair split misses one with odds below 1 in 10,000.
      if (runs >= 10 * entry.allowed.length && missing.length) problems.push(`never drawn in ${runs} visits: ${missing.join(', ')}`);
      const unexpected = Object.keys(counts[id]).filter((name) => !entry.allowed.includes(name));
      if (unexpected.length) problems.push(`drew variants the weights exclude: ${unexpected.join(', ')}`);
    }
    return {
      id, sticky: variants, distribution: runs ? counts[id] : undefined, ok: !problems.length, problems,
    };
  });
}

async function revisit(browser, pageUrl) {
  const context = await browser.newContext({ viewport: VIEWPORTS.desktop, userAgent: BROWSER_UA });
  const visits = [];
  try {
    for (let i = 0; i < 2; i += 1) {
      const page = await context.newPage();
      // eslint-disable-next-line no-await-in-loop
      await page.goto(pageUrl, { waitUntil: 'load' });
      // eslint-disable-next-line no-await-in-loop
      await settle(page);
      // eslint-disable-next-line no-await-in-loop
      await page.waitForTimeout(500);
      // eslint-disable-next-line no-await-in-loop
      visits.push(await readSections(page));
      // eslint-disable-next-line no-await-in-loop
      await page.close();
      // The next visit is a new browser session: session cookies go away.
      // eslint-disable-next-line no-await-in-loop
      const persistent = (await context.cookies()).filter((cookie) => cookie.expires > 0);
      // eslint-disable-next-line no-await-in-loop
      await context.clearCookies();
      // eslint-disable-next-line no-await-in-loop
      await context.addCookies(persistent);
    }
    const cookies = (await context.cookies()).filter((cookie) => cookie.name.startsWith('pzn-'))
      .map((cookie) => `${cookie.name}=${cookie.value}`);
    return { first: visits[0], second: visits[1], cookies };
  } finally {
    await context.close();
  }
}

/**
 * @param {object} options
 * @returns {Promise<object>} report
 */
export async function verify({
  page, cases, baseline, revisit: doRevisit, screenshots, ignoreConsole, apiPath, splitRuns = 0,
}) {
  const { chromium } = requirePlaywright();
  const browser = await chromium.launch({ headless: true });
  try {
    const runs = [];
    // Sequential: keeps aem up and CLS measurements stable.
    for (const entry of cases.filter((item) => item.expected !== undefined)) {
      // eslint-disable-next-line no-await-in-loop
      runs.push(await runCase(browser, page, entry, { screenshots, ignoreConsole, apiPath }));
    }
    const report = { page, invalid: cases.filter((item) => item.errors) };
    let baselineErrors = [];
    if (baseline) {
      const context = await browser.newContext({ viewport: VIEWPORTS.desktop, userAgent: BROWSER_UA });
      await context.addInitScript(VITALS_SCRIPT);
      const before = await measure(context, baseline, ignoreConsole);
      const after = await measure(context, page, ignoreConsole);
      baselineErrors = before.errors;
      await context.close();
      const ok = after.cls <= Math.max(CLS_BUDGET, before.cls + CLS_REGRESSION);
      report.baseline = {
        url: baseline,
        before: { cls: Number(before.cls.toFixed(3)), lcp: Math.round(before.lcp) },
        after: { cls: Number(after.cls.toFixed(3)), lcp: Math.round(after.lcp) },
        lcpDeltaMs: Math.round(after.lcp - before.lcp),
        ok,
      };
    }
    const { results, preExisting } = splitConsoleErrors(runs, baselineErrors);
    Object.assign(report, { results, preExistingErrors: preExisting });
    report.splits = await checkSplits(browser, page, cases, { runs: splitRuns });
    if (doRevisit) report.revisit = await revisit(browser, page);
    report.ok = results.every((result) => result.ok) && report.splits.every((split) => split.ok)
      && !report.invalid.length && report.baseline?.ok !== false;
    return report;
  } finally {
    await browser.close();
  }
}

if (isMain(import.meta.url)) {
  exitOnHelp(USAGE);
  const args = parseArgs(process.argv.slice(2));
  if (typeof args.page !== 'string') {
    console.error(`❌ ${USAGE}`);
    process.exit(2);
  }
  const repo = resolve(args.repo || process.cwd());
  let cases;
  if (args.cases) cases = readJson(resolve(args.cases));
  else {
    let html = args.file ? readText(resolve(args.file)) : null;
    if (!html && !args.file) {
      const response = await fetch(plainUrl(args.page)).catch(() => null);
      html = response?.ok ? await response.text() : null;
    }
    if (!html) {
      console.error(`❌ could not read ${args.file || plainUrl(args.page)}`);
      process.exit(2);
    }
    cases = await buildCases(html, {
      matrix: args.matrix ? readJson(resolve(args.matrix)) : undefined,
      engine: args['api-decisions'] ? readJson(resolve(args['api-decisions'])) : undefined,
      activities: typeof args.target === 'string' ? readJson(resolve(args.target)) : undefined,
      prefixes: sitePrefixes(repo),
      consent: !!args.consent,
    });
  }
  if (!Array.isArray(cases) || !cases.length) {
    console.error('❌ no cases: the page has no personalized sections');
    process.exit(2);
  }
  if (args.faults) cases.push(...faultCases(cases));
  const site = readSiteConfig(readText(join(repo, 'scripts', 'personalization', 'config.js')) || '');
  let apiPath;
  try {
    apiPath = site.apiEndpoint ? new URL(site.apiEndpoint, args.page).pathname : undefined;
  } catch (e) {
    apiPath = undefined;
  }
  const report = await verify({
    page: args.page,
    cases,
    apiPath,
    splitRuns: Number(args['split-runs'] || 0),
    baseline: typeof args.baseline === 'string' ? args.baseline : undefined,
    revisit: !!args.revisit,
    screenshots: typeof args.screenshots === 'string' ? resolve(args.screenshots) : undefined,
    ignoreConsole: typeof args['ignore-console'] === 'string' ? new RegExp(args['ignore-console']) : undefined,
  });
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    report.invalid.forEach((item) => status(false, `section "${item.id ?? '?'}" is invalid: ${item.errors.join('; ')}`));
    report.results.forEach((result) => {
      status(result.ok, `${result.id} · ${result.case} → ${result.actual ?? '-'} (${result.source ?? '-'}), CLS ${result.cls ?? '-'}, LCP ${result.lcp ?? '-'}ms`);
      result.problems.forEach((problem) => console.log(`   ❌ ${problem}`));
      (result.notes || []).forEach((note) => console.log(`   ℹ️ ${note}`));
      if (!result.ok) console.log(`   ${result.url}`);
    });
    report.splits.forEach((split) => {
      const distribution = split.distribution ? `, distribution ${JSON.stringify(split.distribution)}` : '';
      status(split.ok, `${split.id} · split sticky across reloads and tabs: ${split.sticky.join(', ')}${distribution}`);
      split.problems.forEach((problem) => console.log(`   ❌ ${problem}`));
    });
    if (report.baseline) {
      const { before, after, lcpDeltaMs } = report.baseline;
      status(report.baseline.ok, `baseline CLS ${before.cls} → ${after.cls}, LCP ${before.lcp} → ${after.lcp}ms (${lcpDeltaMs >= 0 ? '+' : ''}${lcpDeltaMs}ms)`);
      if (lcpDeltaMs > 500) console.log('   ⚠️ LCP regressed by more than 500ms: consider edge mode for above-the-fold sections');
    }
    if (report.preExistingErrors.length) {
      console.log(`⚠️ pre-existing console errors (also on the default/baseline run, not failed): ${report.preExistingErrors.slice(0, 5).join(' | ')}`);
    }
    if (report.revisit) {
      const show = (visit) => visit.map((section) => `${section.id}=${section.variant}`).join(', ');
      console.log(`ℹ️ revisit: first [${show(report.revisit.first)}], second [${show(report.revisit.second)}], cookies [${report.revisit.cookies.join('; ') || 'none'}]`);
    }
    console.log(report.ok ? '\n✓ PASS preview verified' : '\n❌ FAIL see problems above');
  }
  process.exit(report.ok ? 0 : 1);
}

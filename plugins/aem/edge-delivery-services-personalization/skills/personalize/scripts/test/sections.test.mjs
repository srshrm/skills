/*
 * Section runtime (scripts/personalization/sections.js) in headless Chromium:
 * held sections, every source, budgets, fallbacks, overrides, bots, consent,
 * split stickiness, target popups and notifications, edge handoff and live
 * state. aem.js is a stub with the boilerplate's loadSection semantics.
 * Skipped when Playwright Chromium is not installed (see runtime.test.mjs).
 */

import assert from 'node:assert/strict';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { dirname, join } from 'node:path';
import {
  after, before, describe, it,
} from 'node:test';
import { RUNTIME_DIR, RUNTIME_MODULES, loadPlaywright } from '../lib.mjs';
import { tempDir } from './helpers.mjs';

const UA = 'Mozilla/5.0 (Macintosh) Chrome/140 Safari/537.36';
const BOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

const CONFIG = `const base = {
  fragmentPrefixes: ['/fragments/'],
  budgets: { eager: 1500, lazy: 1500 },
  devices: { mobile: '(max-width: 599px)', desktop: '(min-width: 600px)' },
  geo: { endpoint: '', timeout: 500 },
  api: { endpoint: '/decide', sendWithoutConsent: false, mapRequest: null, mapResponse: null },
  target: { clientCode: 'acme', timeout: 3000, sendWithoutConsent: false },
  providers: {},
  mock: {
    api: { ttl: 0, placeholders: { plan: {
      'param: utm_campaign=enterprise': 'enterprise',
      'param: utm_source=agency': 'agency',
      'param: utm_content=rogue': 'unlisted',
      'device: mobile': 'mobile',
    } } },
    target: {
      offer: { name: 'Scroll offer', experiences: [
        { name: 'Enterprise', audience: 'param: utm_campaign=enterprise', offer: '/fragments/offer/enterprise' },
        { name: 'Returning', audience: 'visitor: returning', offer: '/fragments/offer/welcome-back' },
        { name: 'Everyone', audience: null, offer: '/fragments/offer/free-trial' },
      ] },
      'inline-offer': { experiences: [{ name: 'All', audience: null, offer: '/fragments/inline-offer/promo' }] },
    },
  },
  audiences: {},
  hasConsent: () => !!window.testConsent,
  overrides: 'preview',
  botsGetDefault: true,
  analytics: { dataLayer: true, rum: true },
};
export default { ...base, ...(window.testConfig || {}) };`;

// loadSection / loadSections as in the boilerplate's aem.js, minus blocks.
const AEM = `export function sampleRUM(checkpoint, data) { (window.testRum = window.testRum || []).push({ checkpoint, ...data }); }
export async function loadCSS(href) {
  if (document.querySelector(\`link[href="\${href}"]\`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.append(link);
}
export async function loadSection(section) {
  const status = section.dataset.sectionStatus;
  if (!status || status === 'initialized') {
    section.dataset.sectionStatus = 'loading';
    section.dataset.sectionStatus = 'loaded';
    section.style.display = null;
  }
}
export async function loadSections(main) {
  for (const section of main.querySelectorAll('div.section')) {
    // eslint-disable-next-line no-await-in-loop
    await loadSection(section);
  }
}`;

const FRAGMENT_BLOCK = `export async function loadFragment(path) {
  const resp = await fetch(\`\${path}.plain.html\`);
  if (!resp.ok) return null;
  const main = document.createElement('main');
  main.innerHTML = await resp.text();
  main.querySelectorAll(':scope > div').forEach((div) => div.classList.add('section'));
  return main;
}`;

const FRAGMENTS = {
  'hero/india': '<h1>India hero</h1>',
  'hero/quiz-a': '<h1>Quiz A hero</h1>',
  'plan/enterprise': '<h2>Enterprise plan</h2><p><a href="/contact">Book</a></p>',
  'plan/agency': '<h2>Agency plan</h2>',
  'plan/mobile': '<h2>Mobile plan</h2>',
  'msg/speed': '<h2>Speed</h2>',
  'msg/team': '<h2>Team</h2>',
  'pick/x': '<p>X</p>',
  'pick/y': '<p>Y</p>',
  'offer/free-trial': '<p>BEFORE YOU GO</p><h2>Free trial</h2><p><a href="/trial">Start</a></p>',
  'offer/welcome-back': '<h2>Welcome back</h2><p><a href="/plans">Plans</a></p>',
  'offer/enterprise': '<h2>Enterprise demo</h2>',
  'inline-offer/promo': '<h2>Inline promo</h2><p><a href="/promo">Go</a></p>',
};

const section = (attrs, body, { style = '', classes = '' } = {}) => `<div class="section${classes ? ` ${classes}` : ''}" data-section-status="initialized" style="display:none;${style}" ${attrs}>${body}</div>`;
const variants = (...paths) => `data-personalization-variants="${paths.map((p) => `/fragments/${p}`).join(',')}"`;
const spacer = section('', '<p>spacer</p>', { style: 'height:1200px' });

const PAGE = `<!DOCTYPE html><html lang="en"><head></head><body><main>
${section(`data-personalization="hero" ${variants('hero/india', 'hero/quiz-a')} data-personalization-rule-india="geo: IN" data-personalization-rule-quiz-a="state: persona=a"`, '<h1>Authored hero</h1>', { classes: 'hero dark' })}
${spacer}
${section(`data-personalization="plan" data-personalization-source="api" ${variants('plan/enterprise', 'plan/agency', 'plan/mobile', 'plan/missing')}`, '<h2>Authored plan</h2>')}
${section(`data-personalization="msg" data-personalization-source="split" ${variants('msg/speed', 'msg/team')}`, '<h2>Authored msg</h2>')}
${section(`data-personalization="pick" data-personalization-source="split" data-personalization-split="0,100" ${variants('pick/x', 'pick/y')}`, '<p>Authored pick</p>')}
${section(`data-personalization="inline-offer" data-personalization-source="target" ${variants('inline-offer/promo')}`, '<h2>Authored inline offer</h2>')}
${section('data-personalization="broken" data-personalization-source="bogus"', '<p>Authored broken</p>')}
${section(`data-personalization="edged" ${variants('pick/x')} data-personalization-rule-x="geo: IN" data-pzn-source="edge" data-pzn-variant="x" data-pzn-status="applied"`, '<p>Edge content</p>')}
${spacer}
${section(`data-personalization="offer" data-personalization-source="target" data-personalization-trigger="scroll: 70%" ${variants('offer/free-trial', 'offer/welcome-back', 'offer/enterprise')}`, '<h2>Authored offer section</h2>')}
${spacer}
${spacer}
</main>
<script type="module">
  import { personalizeSections, personalizeSectionsLazy } from '/scripts/personalization/sections.js';
  import { loadSections } from '/scripts/aem.js';
  window.hlx = window.hlx || {};
  window.hlx.codeBasePath = '';
  window.testEvents = [];
  document.addEventListener('personalization:applied', (e) => window.testEvents.push(e.detail));
  document.addEventListener('personalization:notified', (e) => window.testEvents.push({ notified: e.detail.type, id: e.detail.id }));
  const main = document.querySelector('main');
  personalizeSections(main);
  window.testDone = loadSections(main).then(() => personalizeSectionsLazy(main));
</script></body></html>`;

function buildSite(dir) {
  RUNTIME_MODULES.forEach((name) => {
    const target = join(dir, 'scripts', 'personalization', name);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(RUNTIME_DIR, 'scripts', 'personalization', name), target);
  });
  writeFileSync(join(dir, 'scripts', 'personalization', 'config.js'), CONFIG);
  writeFileSync(join(dir, 'scripts', 'aem.js'), AEM);
  mkdirSync(join(dir, 'blocks', 'fragment'), { recursive: true });
  writeFileSync(join(dir, 'blocks', 'fragment', 'fragment.js'), FRAGMENT_BLOCK);
  mkdirSync(join(dir, 'styles'), { recursive: true });
  cpSync(join(RUNTIME_DIR, 'styles', 'target-popup.css'), join(dir, 'styles', 'target-popup.css'));
  Object.entries(FRAGMENTS).forEach(([name, body]) => {
    mkdirSync(join(dir, 'fragments', name.split('/')[0]), { recursive: true });
    writeFileSync(join(dir, 'fragments', `${name}.plain.html`), `<div>${body}</div>`);
  });
}

async function launch() {
  const playwright = loadPlaywright() || loadPlaywright([process.cwd()]);
  try {
    return playwright ? await playwright.chromium.launch() : null;
  } catch (e) {
    return null;
  }
}

const browser = await launch();

describe('section runtime', { skip: browser ? false : 'Playwright Chromium not installed' }, () => {
  const site = tempDir('pzn-sections-');
  let server;
  let base;
  let apiCalls = [];

  before(async () => {
    buildSite(site.dir);
    server = http.createServer(async (req, res) => {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (pathname === '/decide') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        await new Promise((done) => { req.on('end', done); });
        apiCalls.push(JSON.parse(body));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ decisions: { plan: { variant: 'agency', tracking: { engine: 'real' } } }, ttl: 0 }));
        return;
      }
      if (pathname === '/page.html') {
        res.setHeader('content-type', 'text/html');
        res.end(PAGE);
        return;
      }
      try {
        const body = await readFile(join(site.dir, pathname));
        const type = { js: 'text/javascript', css: 'text/css' }[pathname.split('.').pop()] || 'text/html';
        res.setHeader('content-type', type);
        res.end(body);
      } catch (e) {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise((done) => { server.listen(0, done); });
    base = `http://localhost:${server.address().port}`;
  });

  after(async () => {
    await browser?.close();
    server?.close();
    site.cleanup();
  });

  async function open({
    query = '', init = '', userAgent = UA, viewport = { width: 1280, height: 800 }, context: shared,
  } = {}) {
    apiCalls = [];
    const context = shared || await browser.newContext({ userAgent, viewport });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    if (init) await page.addInitScript(init);
    await page.goto(`${base}/page.html${query}`);
    await page.evaluate(() => window.testDone);
    await page.waitForFunction(() => !document.querySelector('[data-section-status^="pzn-"]'), null, { timeout: 5000 });
    return {
      page, errors, context, close: () => (shared ? page.close() : context.close()),
    };
  }

  const read = (page, id) => page.evaluate((sectionId) => {
    const el = document.querySelector(`[data-personalization="${sectionId}"]`);
    return {
      variant: el.dataset.pznVariant,
      source: el.dataset.pznSource,
      reason: el.dataset.pznReason,
      status: el.dataset.sectionStatus,
      hidden: el.style.display === 'none',
      text: el.innerText.trim().replace(/\s+/g, ' '),
      classes: el.className,
    };
  }, id);

  const mockRequests = (page) => page.evaluate(() => (window.hlx.personalizationMock?.requests || [])
    .map((request) => ({ url: request.url, notifications: request.body.notifications?.map((n) => n.type), status: request.status })));

  it('shows authored content without consent and never leaves a section hidden', async () => {
    const { page, errors, close } = await open();
    assert.deepEqual(await read(page, 'hero'), {
      variant: 'default', source: 'default', reason: undefined, status: 'loaded', hidden: false, text: 'Authored hero', classes: 'section hero dark',
    });
    const plan = await read(page, 'plan');
    assert.equal(plan.source, 'fallback');
    assert.equal(plan.reason, 'no consent');
    assert.equal(plan.text, 'Authored plan');
    assert.equal((await read(page, 'inline-offer')).reason, 'no consent');
    const broken = await read(page, 'broken');
    assert.equal(broken.hidden, false);
    assert.equal(broken.text, 'Authored broken');
    const rows = await page.evaluate(() => window.hlx.personalization.decisions);
    assert.equal(rows.find((row) => row.id === 'offer').status, 'waiting for consent');
    assert.equal((await mockRequests(page)).length, 0, 'no engine or Target call without consent');
    assert.deepEqual(errors, []);
    await close();
  });

  it('shows sections in page order: nothing below a section still deciding appears first', async () => {
    const context = await browser.newContext({ userAgent: UA });
    const page = await context.newPage();
    await page.goto(`${base}/page.html?pzn-consent=1&utm_campaign=enterprise&pzn-mock-latency=900`);
    // hero and the split are decided at once; plan waits 900 ms for the engine.
    await page.waitForFunction(() => document.querySelector('[data-personalization="hero"]').dataset.sectionStatus === 'loaded'
      && document.querySelector('[data-personalization="msg"]').dataset.sectionStatus === 'pzn-ready');
    const during = await page.evaluate(() => [...document.querySelectorAll('main > .section')]
      .map((section) => [section.dataset.personalization || 'plain', section.dataset.sectionStatus, section.style.display === 'none']));
    assert.deepEqual(during.slice(0, 4).map(([id, status]) => [id, status]), [
      ['hero', 'loaded'], ['plain', 'loaded'], ['plan', 'pzn-pending'], ['msg', 'pzn-ready'],
    ]);
    assert.ok(during.slice(2).every(([, , hidden]) => hidden), 'everything from the deciding section down is hidden');
    assert.ok(during.slice(4).every(([, status]) => ['pzn-ready', 'pzn-waiting', 'pzn-pending'].includes(status)));
    await page.waitForFunction(() => !document.querySelector('[data-section-status^="pzn-"]'), null, { timeout: 5000 });
    const plan = await read(page, 'plan');
    assert.deepEqual([plan.variant, plan.hidden], ['enterprise', false]);
    await context.close();
  });

  it('decides rules, keeps host classes and fires personalization:applied', async () => {
    const { page, close } = await open({ query: '?pzn-geo=IN' });
    const hero = await read(page, 'hero');
    assert.equal(hero.variant, 'india');
    assert.equal(hero.source, 'rule');
    assert.equal(hero.text, 'India hero');
    assert.equal(hero.classes, 'section hero dark');
    const events = await page.evaluate(() => window.testEvents);
    assert.deepEqual(events.find((event) => event.id === 'hero'), {
      id: 'hero', variant: 'india', source: 'rule', tracking: undefined,
    });
    const pushed = await page.evaluate(() => window.adobeDataLayer.map((entry) => entry.personalization.id));
    assert.ok(pushed.includes('hero'));
    const rum = await page.evaluate(() => window.testRum);
    assert.ok(rum.some((entry) => entry.checkpoint === 'audience' && entry.source === 'hero' && entry.target === 'india'));
    assert.ok(rum.some((entry) => entry.checkpoint === 'experiment' && entry.source === 'msg'));
    await close();
  });

  it('asks the decision API once per page with consent and accepts only listed variants', async () => {
    const enterprise = await open({ query: '?pzn-consent=1&utm_campaign=enterprise' });
    assert.equal((await read(enterprise.page, 'plan')).variant, 'enterprise');
    assert.equal((await read(enterprise.page, 'plan')).source, 'api');
    const requests = await mockRequests(enterprise.page);
    assert.equal(requests.filter((request) => request.url.endsWith('/decide')).length, 1);
    await enterprise.close();
    const agency = await open({ query: '?pzn-consent=1&utm_source=agency' });
    assert.equal((await read(agency.page, 'plan')).variant, 'agency');
    await agency.close();
    const mobile = await open({ query: '?pzn-consent=1', viewport: { width: 390, height: 844 } });
    assert.equal((await read(mobile.page, 'plan')).variant, 'mobile');
    await mobile.close();
    const rogue = await open({ query: '?pzn-consent=1&utm_content=rogue' });
    assert.deepEqual(await read(rogue.page, 'plan').then(({ source, reason }) => ({ source, reason })), { source: 'fallback', reason: 'not listed: unlisted' });
    await rogue.close();
  });

  it('calls a real endpoint through the v1 contract when mocks are off', async () => {
    const { page, close } = await open({ query: '?pzn-consent=1&utm_campaign=x&email=a', init: 'window.testConfig = { mock: false };' });
    assert.equal((await read(page, 'plan')).variant, 'agency');
    assert.equal(apiCalls.length, 1);
    assert.deepEqual(apiCalls[0].placeholders, [{ id: 'plan', candidates: ['enterprise', 'agency', 'mobile', 'missing', 'default'] }]);
    assert.deepEqual(apiCalls[0].context.params, { utm_campaign: 'x' });
    await close();
  });

  it('falls back on engine failure and times out on a slow engine', async () => {
    const failed = await open({ query: '?pzn-consent=1&utm_campaign=enterprise&pzn-mock-fail' });
    const plan = await read(failed.page, 'plan');
    assert.deepEqual([plan.source, plan.reason, plan.text, plan.hidden], ['fallback', 'HTTP 500', 'Authored plan', false]);
    await failed.close();
    const slow = await open({ query: '?pzn-consent=1&utm_campaign=enterprise&pzn-mock-latency=3000' });
    const timed = await read(slow.page, 'plan');
    assert.deepEqual([timed.source, timed.text, timed.hidden], ['timeout', 'Authored plan', false]);
    await slow.close();
  });

  it('falls back when a variant fragment is missing', async () => {
    const { page, close } = await open({ query: '?pzn=plan:missing' });
    assert.deepEqual(await read(page, 'plan').then(({ source, reason, text }) => ({ source, reason, text })), {
      source: 'fallback', reason: 'fragment failed: /fragments/plan/missing', text: 'Authored plan',
    });
    await close();
  });

  it('forces any source with ?pzn=, including target without consent or a call', async () => {
    const { page, close } = await open({ query: '?pzn=msg:team,plan:agency,inline-offer:promo,hero:default,offer:welcome-back' });
    assert.equal((await read(page, 'msg')).text, 'Team');
    assert.equal((await read(page, 'plan')).variant, 'agency');
    assert.equal((await read(page, 'inline-offer')).text, 'Inline promo Go');
    assert.equal((await read(page, 'hero')).source, 'override');
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForSelector('dialog.target-popup[open]');
    assert.match(await page.textContent('dialog.target-popup'), /Welcome back/);
    assert.equal((await mockRequests(page)).length, 0, 'forced offers never call Target');
    await close();
  });

  it('serves bots the authored content with no calls and no split assignment', async () => {
    const { page, close } = await open({ userAgent: BOT, init: 'window.testConsent = true;' });
    for (const id of ['hero', 'plan', 'msg', 'pick', 'inline-offer']) {
      // eslint-disable-next-line no-await-in-loop
      const { source, text } = await read(page, id);
      assert.equal(source, 'bot', id);
      assert.match(text, /^Authored/);
    }
    assert.equal(await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('pzn-split')).length), 0);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(300);
    assert.equal(await page.$('dialog.target-popup'), null);
    assert.equal((await mockRequests(page)).length, 0);
    await close();
    const forced = await open({ userAgent: BOT, query: '?pzn=msg:speed' });
    assert.equal((await read(forced.page, 'msg')).text, 'Speed', 'overrides beat the bot check');
    await forced.close();
  });

  it('keeps split assignments for the session and honors the weights', async () => {
    const context = await browser.newContext({ userAgent: UA });
    const seen = [];
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const { page, close } = await open({ context });
      // eslint-disable-next-line no-await-in-loop
      seen.push(await read(page, 'msg'));
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await read(page, 'pick')).text, 'Y', '0, 100 always picks the second variant');
      // eslint-disable-next-line no-await-in-loop
      await close();
    }
    assert.equal(new Set(seen.map((msg) => msg.variant)).size, 1, 'sticky within the session');
    assert.equal(seen[0].source, 'split');
    await context.close();
  });

  it('opens the target popup past the scroll threshold, once, with notifications', async () => {
    const { page, errors, close } = await open({ query: '?pzn-consent=1&pzn-visitor=returning' });
    const scrollTo = (ratio) => page.evaluate(async (r) => {
      window.scrollTo(0, document.documentElement.scrollHeight * r - window.innerHeight);
      await new Promise((done) => { setTimeout(done, 250); });
    }, ratio);
    await page.waitForFunction(() => window.hlx.personalization.decisions.find((row) => row.id === 'offer')?.status === 'armed');
    await scrollTo(0.5);
    assert.equal(await page.$('dialog.target-popup'), null, 'no popup at 50%');
    await scrollTo(0.72);
    await page.waitForSelector('dialog.target-popup[open]');
    const dialog = await page.evaluate(() => {
      const el = document.querySelector('dialog.target-popup');
      const label = document.getElementById(el.getAttribute('aria-labelledby'));
      return { modal: el.matches(':modal'), label: label?.textContent };
    });
    assert.deepEqual(dialog, { modal: true, label: 'Welcome back' });
    await page.waitForFunction(() => window.testEvents.some((event) => event.notified === 'display'));
    // Keep the page: the click notification is what is under test.
    await page.evaluate(() => document.addEventListener('click', (event) => event.preventDefault()));
    await page.click('dialog.target-popup a');
    await page.waitForFunction(() => window.testEvents.some((event) => event.notified === 'click'));
    await close();
    assert.deepEqual(errors, []);

    const again = await open({ query: '?pzn-consent=1' });
    await again.page.waitForFunction(() => window.hlx.personalization.decisions.find((row) => row.id === 'offer')?.status === 'armed');
    await again.page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await again.page.waitForSelector('dialog.target-popup[open]');
    assert.match(await again.page.textContent('dialog.target-popup'), /Free trial/);
    await again.page.keyboard.press('Escape');
    await again.page.waitForSelector('dialog.target-popup', { state: 'detached' });
    await again.page.evaluate(async () => {
      window.scrollTo(0, 0);
      await new Promise((done) => { setTimeout(done, 100); });
      window.scrollTo(0, document.documentElement.scrollHeight);
      await new Promise((done) => { setTimeout(done, 300); });
    });
    assert.equal(await again.page.$('dialog.target-popup'), null, 'shown once per page view');
    const requests = await mockRequests(again.page);
    assert.equal(requests.filter((request) => !request.notifications && /tt\.omtrdc\.net/.test(request.url)).length, 1, 'one prefetch');
    assert.deepEqual(requests.filter((request) => request.notifications).map((request) => request.notifications), [['display']]);
    await again.close();
  });

  it('renders inline target offers and reports display once seen', async () => {
    const { page, close } = await open({ query: '?pzn-consent=1' });
    const inline = await read(page, 'inline-offer');
    assert.deepEqual([inline.variant, inline.source, inline.text], ['promo', 'target', 'Inline promo Go']);
    await page.evaluate(() => document.querySelector('[data-personalization="inline-offer"]').scrollIntoView());
    await page.waitForFunction(() => window.testEvents.some((event) => event.id === 'inline-offer' && event.notified === 'display'));
    await close();
  });

  it('runs waiting target sections when consent arrives', async () => {
    const { page, close } = await open({ query: '?utm_source=agency' });
    await page.evaluate(() => {
      window.testConsent = true;
      window.dispatchEvent(new CustomEvent('consent.update', { detail: { consented: true } }));
    });
    await page.waitForFunction(() => window.hlx.personalization.decisions.find((row) => row.id === 'offer')?.status === 'armed');
    await page.waitForFunction(() => document.querySelector('[data-personalization="plan"]').dataset.pznVariant === 'agency');
    await close();
  });

  it('re-decides rules on setState and restores the authored content', async () => {
    const { page, close } = await open();
    await page.evaluate(() => window.hlx.personalization.setState('persona', 'a'));
    assert.equal((await read(page, 'hero')).text, 'Quiz A hero');
    await page.evaluate(() => window.hlx.personalization.setState('persona', null));
    const hero = await read(page, 'hero');
    assert.deepEqual([hero.variant, hero.text], ['default', 'Authored hero']);
    await close();
  });

  it('leaves edge-decided sections as rendered and tracks them', async () => {
    const { page, close } = await open();
    const edged = await read(page, 'edged');
    assert.deepEqual([edged.source, edged.variant, edged.text, edged.hidden], ['edge', 'x', 'Edge content', false]);
    assert.ok((await page.evaluate(() => window.testEvents)).some((event) => event.id === 'edged' && event.source === 'edge'));
    await close();
  });
});

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import {
  after, before, describe, it,
} from 'node:test';
import { installRuntime } from '../install-runtime.mjs';
import { importAsset, loadPlaywright } from '../lib.mjs';
import { buildCases } from '../simulate.mjs';
import {
  faultCases, plainUrl, splitConsoleErrors, verify,
} from '../verify-preview.mjs';
import { runHelp, tempDir } from './helpers.mjs';

const { renderSectionMetadata } = await importAsset('edge', 'cloudflare', 'src', 'personalization', 'html.js');

describe('plainUrl', () => {
  it('maps a preview page to its .plain.html, dropping the query', () => {
    assert.equal(plainUrl('http://localhost:3000/offer?pzn=offer:india'), 'http://localhost:3000/offer.plain.html');
    assert.equal(plainUrl('https://main--site--org.aem.page/'), 'https://main--site--org.aem.page/index.plain.html');
    assert.equal(plainUrl('http://localhost:3000/en/'), 'http://localhost:3000/en/index.plain.html');
  });
});

describe('splitConsoleErrors', () => {
  const nav = 'Failed to load resource: 404 (http://localhost:3000/nav.plain.html)';
  const variant = 'Failed to load resource: 404 (http://localhost:3000/fragments/personalization/hero/india.plain.html)';
  const run = (query, errors) => ({ query, errors, problems: [], ok: true });

  it('reports errors the default run also has as pre-existing, not failures', () => {
    const { results, preExisting } = splitConsoleErrors([run('', [nav]), run('pzn-geo=IN', [nav])]);
    assert.ok(results.every((result) => result.ok));
    assert.deepEqual(preExisting, [nav]);
  });

  it('fails errors a case introduced, and personalization errors even on the default run', () => {
    const { results, preExisting } = splitConsoleErrors([run('', [variant]), run('pzn-geo=IN', ['boom', variant])]);
    assert.equal(results[0].ok, false);
    assert.match(results[1].problems[0], /boom/);
    assert.deepEqual(preExisting, []);
  });

  it('treats baseline errors as pre-existing', () => {
    const { results, preExisting } = splitConsoleErrors([run('pzn-geo=IN', [nav])], [nav]);
    assert.equal(results[0].ok, true);
    assert.deepEqual(preExisting, [nav]);
  });
});

describe('verify-preview.mjs --help', () => {
  it('prints the usage, exits 0 and writes nothing', () => {
    const { status, stdout, wrote } = runHelp('verify-preview.mjs');
    assert.equal(status, 0);
    assert.match(stdout, /^Usage/);
    assert.deepEqual(wrote, []);
  });
});

/*
 * End to end: install-runtime --apply-hook into a boilerplate-shaped site,
 * pages rendered the way the pipeline renders Section Metadata, in-browser
 * mocks for the decision API and Target, then simulate's cases through
 * verify(). Skipped without Playwright Chromium.
 */
const F = '/fragments/pzn';
const metadata = (rows) => `<div class="section-metadata">${rows.map(([key, value]) => `<div><div><p>${key}</p></div><div>${value}</div></div>`).join('')}</div>`;
const links = (...paths) => paths.map((path) => `<p><a href="${path}">${path}</a></p>`).join('');
const spacer = '<div><p>Spacer</p><div class="spacer"></div></div>';
const SOURCE = `<body><header></header><main>
  <div><h1>Welcome</h1><p>Intro</p></div>
  <div><h2>Authored hero</h2>${metadata([['Personalization', 'hero'], ['Personalization Variants', links(`${F}/hero/india`)], ['Personalization Rule India', 'geo: IN']])}</div>
  <div><h2>Authored plan</h2>${metadata([['Personalization', 'plan'], ['Personalization Source', 'api'], ['Personalization Variants', links(`${F}/plan/enterprise`, `${F}/plan/mobile`)]])}</div>
  <div><h2>Authored message</h2>${metadata([['Personalization', 'msg'], ['Personalization Source', 'split'], ['Personalization Variants', links(`${F}/msg/speed`, `${F}/msg/team`)]])}</div>
  ${spacer}${spacer}
  <div><h2>Authored offer</h2>${metadata([['Personalization', 'offer'], ['Personalization Source', 'target'], ['Personalization Trigger', 'scroll: 70%'], ['Personalization Variants', links(`${F}/offer/free-trial`, `${F}/offer/welcome-back`)]])}</div>
  ${spacer}${spacer}
</main><footer></footer></body>`;
const FRAGMENTS = {
  'hero/india': '<h2>Namaste</h2>',
  'plan/enterprise': '<h2>Enterprise plan</h2>',
  'plan/mobile': '<h2>Mobile plan</h2>',
  'msg/speed': '<h2>Speed</h2>',
  'msg/team': '<h2>Team</h2>',
  'offer/free-trial': '<h2>Free trial</h2><p><a href="/trial">Start</a></p>',
  'offer/welcome-back': '<h2>Welcome back</h2>',
};
const ENGINE = { ttl: 0, placeholders: { plan: { 'param: utm_campaign=enterprise': 'enterprise', 'device: mobile': 'mobile' } } };
const ACTIVITIES = {
  offer: {
    name: 'Scroll offer',
    experiences: [
      { name: 'Returning', audience: 'visitor: returning', offer: `${F}/offer/welcome-back` },
      { name: 'Everyone', audience: null, offer: `${F}/offer/free-trial` },
    ],
  },
};
const CONFIG = `export default {
  fragmentPrefixes: ['/fragments/'],
  budgets: { eager: 800, lazy: 2000 },
  devices: { mobile: '(max-width: 599px)', desktop: '(min-width: 600px)' },
  geo: { endpoint: '', timeout: 500 },
  api: { endpoint: '/pzn/decide', sendWithoutConsent: false, mapRequest: null, mapResponse: null },
  target: { clientCode: 'acme', propertyToken: '', endpoint: '', timeout: 3000, sendWithoutConsent: false },
  providers: {},
  mock: { api: ${JSON.stringify(ENGINE)}, target: ${JSON.stringify(ACTIVITIES)} },
  audiences: {},
  hasConsent: () => false,
  overrides: 'preview',
  botsGetDefault: true,
  analytics: { dataLayer: true, rum: false },
};
`;
// aem.js essentials: sections decorated and loaded like the boilerplate's.
const AEM = `export function sampleRUM() {}
export async function loadCSS(href) {
  if (document.querySelector(\`link[href="\${href}"]\`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.append(link);
}
export function decorateSections(main) {
  main.querySelectorAll(':scope > div').forEach((section) => {
    section.classList.add('section');
    section.dataset.sectionStatus = 'initialized';
    section.style.display = 'none';
  });
}
export async function loadSection(section) {
  const status = section.dataset.sectionStatus;
  if (!status || status === 'initialized') {
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
const SCRIPTS = `import { decorateSections, loadSection, loadSections } from './aem.js';

function decorateMain(main) {
  decorateSections(main);
}

async function loadEager(doc) {
  const main = doc.querySelector('main');
  if (main) {
    decorateMain(main);
    await loadSection(main.querySelector('.section'));
  }
}

async function loadLazy(doc) {
  const main = doc.querySelector('main');
  await loadSections(main);
}

async function loadPage() {
  await loadEager(document);
  await loadLazy(document);
}

loadPage();
`;
const FRAGMENT_BLOCK = `export async function loadFragment(path) {
  const resp = await fetch(\`\${path}.plain.html\`);
  if (!resp.ok) return null;
  const main = document.createElement('main');
  main.innerHTML = await resp.text();
  main.querySelectorAll(':scope > div').forEach((div) => div.classList.add('section'));
  return main;
}`;

const chromium = await (async () => {
  try {
    const playwright = loadPlaywright() || loadPlaywright([process.cwd()]);
    const browser = playwright ? await playwright.chromium.launch() : null;
    await browser?.close();
    return browser ? playwright : null;
  } catch (e) {
    return null;
  }
})();

describe('verify against a preview', { skip: chromium ? false : 'Playwright Chromium not installed' }, () => {
  const site = tempDir('pzn-verify-');
  let server;
  let base;

  before(async () => {
    const { dir } = site;
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    mkdirSync(join(dir, 'blocks', 'fragment'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'scripts.js'), SCRIPTS);
    writeFileSync(join(dir, 'scripts', 'aem.js'), AEM);
    writeFileSync(join(dir, 'blocks', 'fragment', 'fragment.js'), FRAGMENT_BLOCK);
    const installed = installRuntime(dir, { applyHook: true });
    assert.equal(installed.hook, 'applied', JSON.stringify(installed.hooks));
    writeFileSync(join(dir, 'scripts', 'personalization', 'config.js'), CONFIG);
    const rendered = renderSectionMetadata(SOURCE).html;
    const plain = rendered.replace(/^[\s\S]*<main>|<\/main>[\s\S]*$/g, '');
    const pageHtml = `<!DOCTYPE html><html lang="en"><head><style>.spacer{height:1400px}</style>
      <script type="module" src="/scripts/scripts.js"></script></head>${rendered}</html>`;
    server = http.createServer(async (req, res) => {
      const { pathname } = new URL(req.url, 'http://localhost');
      const fragment = /^\/fragments\/pzn\/(.+)\.plain\.html$/.exec(pathname);
      let body = null;
      let type = 'text/html';
      if (pathname === '/page') body = pageHtml;
      else if (pathname === '/page.plain.html') body = plain;
      else if (fragment && FRAGMENTS[fragment[1]]) body = `<div>${FRAGMENTS[fragment[1]]}</div>`;
      else {
        body = await readFile(join(dir, pathname)).catch(() => null);
        if (pathname.endsWith('.js')) type = 'text/javascript';
        if (pathname.endsWith('.css')) type = 'text/css';
      }
      res.statusCode = body === null ? 404 : 200;
      res.setHeader('content-type', type);
      res.end(body ?? '');
    });
    await new Promise((done) => { server.listen(0, done); });
    base = `http://localhost:${server.address().port}`;
  });

  after(() => {
    server?.close();
    site.cleanup();
  });

  it('passes every simulated case, the faults and the split checks', async () => {
    const all = await buildCases(SOURCE, { engine: ENGINE, activities: ACTIVITIES });
    const wanted = new Set(['no context', 'bot', 'forced india', 'matches "geo: IN"', 'matches "param: utm_campaign=enterprise"',
      'matches "device: mobile"', 'forced team', 'matches "visitor: returning"', 'forced free-trial']);
    const cases = [...all.filter((entry) => wanted.has(entry.name)), ...faultCases(all)];
    const report = await verify({
      page: `${base}/page`, cases, apiPath: '/pzn/decide', splitRuns: 6,
    });
    const failed = report.results.filter((result) => !result.ok).map((result) => `${result.id} · ${result.case}: ${result.problems.join('; ')}`);
    assert.deepEqual(failed, []);
    assert.equal(report.splits.length, 1);
    assert.equal(report.splits[0].ok, true, report.splits[0].problems.join());
    assert.equal(new Set(report.splits[0].sticky).size, 1);
    assert.equal(Object.values(report.splits[0].distribution).reduce((sum, count) => sum + count, 0), 6);
    assert.equal(report.ok, true);
    const names = report.results.map((result) => `${result.id} · ${result.case} → ${result.actual} (${result.source})`);
    assert.ok(names.includes('offer · matches "visitor: returning" → welcome-back (target)'), names.join('\n'));
    assert.ok(names.includes('plan · mock latency 3000ms → default (timeout)'), names.join('\n'));
    assert.ok(names.includes('plan · bot → default (bot)'), names.join('\n'));
  });

  it('fails a case whose expectation is wrong', async () => {
    const [entry] = (await buildCases(SOURCE)).filter((item) => item.id === 'hero' && item.name === 'forced india');
    const report = await verify({ page: `${base}/page`, cases: [{ ...entry, expected: 'default' }] });
    assert.equal(report.ok, false);
    assert.match(report.results[0].problems.join(), /variant "india" \(source override\), expected "default"/);
  });
});

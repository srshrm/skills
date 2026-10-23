import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  autoMatrix, buildCases, simulateEdge, toCase,
} from '../simulate.mjs';
import {
  SITE, fixture, runHelp, sectionSpec, tempDir,
} from './helpers.mjs';

const DECISIONS = JSON.parse(fixture('decisions.json'));

describe('toCase', () => {
  it('turns a matrix entry into a context and the override query', () => {
    const entry = toCase({
      geo: 'US-CA', device: 'mobile', visitor: 'returning', state: { quiz: 'cn' }, audiences: ['vip'], params: { utm_campaign: 'x' }, forced: 'hero:india',
    });
    assert.deepEqual(entry.context, {
      geo: { country: 'US', region: 'CA' }, device: 'mobile', visitor: 'returning', state: { quiz: 'cn' }, params: { utm_campaign: 'x' },
    });
    assert.equal(entry.query, 'pzn-geo=US-CA&pzn-device=mobile&pzn-visitor=returning&pzn-state=quiz%3Acn&pzn-audience=vip&utm_campaign=x&pzn=hero%3Aindia');
    assert.equal(toCase({}).query, '');
  });
});

describe('autoMatrix', () => {
  it('covers baseline, bot, each rule and each forced variant', () => {
    const spec = sectionSpec({
      '': 'hero',
      variants: '/fragments/h/na,/fragments/h/promo',
      'rule-na': 'geo: US, CA & device: mobile & !visitor: returning',
      'rule-promo': 'param: utm_campaign=diwali & state: quiz & audience: vip',
    });
    const matrix = autoMatrix(spec);
    assert.deepEqual(matrix.map((entry) => entry.name), [
      'no context', 'bot',
      'matches "geo: US, CA & device: mobile & !visitor: returning"',
      'matches "param: utm_campaign=diwali & state: quiz & audience: vip"',
      'forced na', 'forced promo', 'forced default',
    ]);
    assert.equal(matrix[2].geo, 'US');
    assert.equal(matrix[2].visitor, undefined, 'negated clauses are left unset');
    assert.deepEqual(matrix[3].params, { utm_campaign: 'diwali' });
    assert.deepEqual(matrix[3].state, { quiz: '1' });
    assert.deepEqual(matrix[3].audiences, ['vip']);
  });
});

describe('buildCases', () => {
  it('expects the right variant for every generated case', async () => {
    const cases = await buildCases(fixture('content/index.html'));
    const expected = Object.fromEntries(cases.map((entry) => [`${entry.id} · ${entry.name}`, entry.expected]));
    assert.deepEqual(expected, {
      'home-hero · no context': 'default',
      'home-hero · bot': 'default',
      'home-hero · matches "geo: IN"': 'india',
      'home-hero · matches "geo: US,CA & device: mobile"': 'na-mobile',
      'home-hero · forced india': 'india',
      'home-hero · forced na-mobile': 'na-mobile',
      'home-hero · forced default': 'default',
      'welcome · no context': 'default',
      'welcome · bot': 'default',
      'welcome · matches "visitor: returning"': 'back',
      'welcome · matches "state: quiz-persona=cn"': 'cn',
      'welcome · forced back': 'back',
      'welcome · forced cn': 'cn',
      'welcome · forced default': 'default',
    });
    const bot = cases.find((entry) => entry.name === 'bot');
    assert.equal(bot.source, 'bot');
    assert.equal(cases.find((entry) => entry.name === 'forced cn').query, 'pzn=welcome%3Acn');
  });

  it('applies a shared matrix and the mock engine for api sections', async () => {
    const matrix = [
      { name: 'india returning', geo: 'IN', visitor: 'returning' },
      { name: 'india new', geo: 'IN', visitor: 'new' },
      { name: 'us', geo: 'US' },
      { name: 'campaign', params: { utm_campaign: 'diwali' } },
    ];
    const cases = await buildCases(fixture('content/offer.plain.html'), { matrix, engine: DECISIONS });
    const byName = Object.fromEntries(cases.map((entry) => [entry.name, [entry.expected, entry.source]]));
    assert.deepEqual(byName, {
      'india returning': ['india', 'api'],
      'india new': ['india', 'rule'],
      us: ['default', 'api'],
      campaign: ['diwali', 'rule'],
    });
    // The runtime calls the engine only with consent: the browser case must grant it.
    assert.ok(cases.every((entry) => /(^|&)pzn-consent=1$/.test(entry.query)));
  });

  it('grants consent in every case but bots with consent: true', async () => {
    const cases = await buildCases(fixture('index.html'), { consent: true });
    // Forced overrides need no consent.
    cases.filter((entry) => !['bot', 'override'].includes(entry.source)).forEach((entry) => assert.match(entry.query, /pzn-consent=1/));
    cases.filter((entry) => entry.source === 'bot').forEach((entry) => assert.equal(entry.query, ''));
    const plain = await buildCases(fixture('index.html'));
    assert.ok(plain.every((entry) => !/pzn-consent/.test(entry.query)));
  });

  it('reports invalid sections instead of cases', async () => {
    const cases = await buildCases('<main><div><p>x</p><div class="section-metadata"><div><div>Personalization</div><div>bad id!</div></div></div></div></main>');
    assert.equal(cases.length, 1);
    assert.equal(cases[0].name, 'invalid section');
    assert.match(cases[0].errors.join(), /id "bad id!"/);
  });
});

describe('simulateEdge', () => {
  it('runs the worker logic over a page', async () => {
    const india = await simulateEdge(fixture('index.html'), { country: 'IN', repo: SITE });
    assert.deepEqual(india.sections, [
      {
        id: 'home-hero', type: 'rules', source: 'edge', variant: 'india', fragment: '/fragments/personalization/home-hero/india',
      },
      {
        // visitor: new, then a state rule only the browser can evaluate
        id: 'welcome', type: 'rules', source: 'deferred to browser', variant: null, fragment: null,
      },
    ]);
    assert.match(india.html, /Variant home-hero\/india/);
    assert.equal(india.headers['x-pzn'], 'edge');
    const bot = await simulateEdge(fixture('index.html'), { country: 'IN', ua: 'Googlebot', repo: SITE });
    assert.deepEqual(bot.sections.map((section) => section.variant), ['default', 'default']);
  });
});

describe('section cases', () => {
  const F = '/fragments/p';
  const metadata = (rows) => `<div class="section-metadata">${rows.map(([key, value]) => `<div><div><p>${key}</p></div><div>${value}</div></div>`).join('')}</div>`;
  const links = (...paths) => paths.map((path) => `<p><a href="${path}">${path}</a></p>`).join('');
  const PAGE = `<main>
    <div><h1>Hero</h1></div>
    <div><h2>Hero</h2>${metadata([['Personalization', 'hero'], ['Personalization Variants', links(`${F}/hero/india`)], ['Personalization Rule India', 'geo: IN'], ['Personalization Rule India 2', 'param: utm_campaign=diwali']])}</div>
    <div><h2>Plan</h2>${metadata([['Personalization', 'plan'], ['Personalization Source', 'api'], ['Personalization Variants', links(`${F}/plan/enterprise`, `${F}/plan/mobile`)], ['Personalization Rule Mobile', 'device: mobile']])}</div>
    <div><h2>Msg</h2>${metadata([['Personalization', 'msg'], ['Personalization Source', 'split'], ['Personalization Variants', links(`${F}/msg/a`, `${F}/msg/b`)]])}</div>
    <div><h2>Pick</h2>${metadata([['Personalization', 'pick'], ['Personalization Source', 'split'], ['Personalization Split', '0, 100'], ['Personalization Variants', links(`${F}/pick/x`, `${F}/pick/y`)]])}</div>
    <div><h2>Offer</h2>${metadata([['Personalization', 'offer'], ['Personalization Source', 'target'], ['Personalization Trigger', 'scroll: 70%'], ['Personalization Variants', links(`${F}/offer/free-trial`, `${F}/offer/welcome-back`)]])}</div>
  </main>`;
  const ENGINE = { placeholders: { plan: { 'param: utm_campaign=enterprise': 'enterprise', 'param: utm_source=x': 'unlisted' } } };
  const ACTIVITIES = {
    offer: {
      experiences: [
        { audience: 'visitor: returning', offer: `${F}/offer/welcome-back` },
        { audience: null, offer: `${F}/offer/free-trial` },
      ],
    },
  };
  const pick = (cases, id, name) => cases.find((entry) => entry.id === id && entry.name === name);

  it('decides each source as sections.js would', async () => {
    const cases = await buildCases(PAGE, { engine: ENGINE, activities: ACTIVITIES });
    assert.deepEqual(pick(cases, 'hero', 'matches "geo: IN"'), {
      id: 'hero', section: 1, sourceType: 'rules', display: 'inline', trigger: undefined, authoredText: 'Hero', name: 'matches "geo: IN"', query: 'pzn-geo=IN', context: { name: 'matches "geo: IN"', params: {}, state: {}, geo: 'IN' }, expected: 'india', source: 'rule', rule: 'geo: IN',
    });
    assert.equal(pick(cases, 'hero', 'matches "param: utm_campaign=diwali"').expected, 'india');
    assert.equal(pick(cases, 'hero', 'no context').expected, 'default');
    assert.deepEqual(['forced india', 'forced default'].map((name) => pick(cases, 'hero', name).expected), ['india', 'default']);

    const enterprise = pick(cases, 'plan', 'matches "param: utm_campaign=enterprise"');
    assert.deepEqual([enterprise.expected, enterprise.source, enterprise.query], ['enterprise', 'api', 'utm_campaign=enterprise&pzn-consent=1']);
    const unlisted = pick(cases, 'plan', 'matches "param: utm_source=x"');
    assert.deepEqual([unlisted.expected, unlisted.source, unlisted.reason], ['default', 'fallback', 'not listed: unlisted']);
    const mobile = pick(cases, 'plan', 'matches "device: mobile"');
    assert.deepEqual([mobile.expected, mobile.source], ['mobile', 'rule'], 'no engine answer: the rule rows decide');
    assert.deepEqual([pick(cases, 'plan', 'bot').expected, pick(cases, 'plan', 'bot').source], ['default', 'bot']);

    const msg = pick(cases, 'msg', 'no context');
    assert.deepEqual([msg.expected, msg.allowed], [null, ['default', 'a', 'b']]);
    assert.equal(pick(cases, 'pick', 'no context').expected, 'y');
    assert.equal(pick(cases, 'msg', 'forced b').expected, 'b');

    const returning = pick(cases, 'offer', 'matches "visitor: returning"');
    assert.deepEqual([returning.expected, returning.source, returning.display, returning.query], ['welcome-back', 'target', 'popup', 'pzn-visitor=returning&pzn-consent=1']);
    assert.equal(pick(cases, 'offer', 'no context').expected, 'free-trial');
    assert.equal(pick(cases, 'offer', 'forced welcome-back').query, 'pzn=offer%3Awelcome-back', 'forced offers need no consent');
  });

  it('expects the authored content without an engine or Target table', async () => {
    const cases = await buildCases(PAGE);
    const plan = pick(cases, 'plan', 'no context');
    assert.deepEqual([plan.expected, plan.source, plan.reason], ['default', 'fallback', 'no consent']);
    const offer = pick(cases, 'offer', 'no context');
    assert.deepEqual([offer.expected, offer.source], ['default', 'waiting for consent']);
  });

  it('runs the edge over source content with local fragments', async () => {
    const { dir, cleanup } = tempDir();
    try {
      mkdirSync(join(dir, 'content', 'fragments', 'p', 'hero'), { recursive: true });
      writeFileSync(join(dir, 'content', 'fragments', 'p', 'hero', 'india.html'), '<body><main><div><h2>Namaste</h2><img src="./media_1.png"></div></main></body>');
      mkdirSync(join(dir, 'content', 'fragments', 'p', 'pick'), { recursive: true });
      writeFileSync(join(dir, 'content', 'fragments', 'p', 'pick', 'y.plain.html'), '<div><p>Y</p></div>');
      const india = await simulateEdge(PAGE, { country: 'IN', repo: dir, prefixes: ['/fragments/'] });
      const hero = india.sections.find((section) => section.id === 'hero');
      assert.deepEqual(hero, {
        id: 'hero', type: 'rules', source: 'edge', variant: 'india', fragment: `${F}/hero/india`,
      });
      assert.match(india.html, /<h2>Namaste<\/h2>/);
      assert.equal(india.sections.find((section) => section.id === 'offer').source, 'deferred to browser');
      const pickSection = india.sections.find((section) => section.id === 'pick');
      assert.deepEqual([pickSection.source, pickSection.variant], ['edge', 'y']);
      assert.match(india.html, /media_1\.png/);
      assert.match(india.headers['set-cookie'] || '', /pzn-split=/);
    } finally {
      cleanup();
    }
  });
});

describe('simulate.mjs --help', () => {
  it('prints the usage, exits 0 and writes nothing', () => {
    const { status, stdout, wrote } = runHelp('simulate.mjs');
    assert.equal(status, 0);
    assert.match(stdout, /^Usage/);
    assert.deepEqual(wrote, []);
  });
});

import assert from 'node:assert/strict';
import {
  after, before, describe, it,
} from 'node:test';
import { edgeBundle, fixture, html } from './helpers.mjs';

const bundle = edgeBundle();
const {
  personalizeResponse, handleApiRoute, edgeContext, absolutizeUrls, fragmentMarkup,
} = await bundle.load('personalization/personalize.js');
const { default: baseConfig } = await bundle.load('personalization/edge-config.js');
after(bundle.cleanup);

const BROWSER = 'Mozilla/5.0 (Macintosh) Chrome/140 Safari/537.36';
// The fixture home page as delivered: home-hero (geo, then geo+device) and
// welcome (visitor, then state).
const PAGE = fixture('index.html');
// The fixture offer page (api: diwali by param, india by geo), as delivered.
const OFFER_PAGE = `<html><head></head><body><main>${html.renderSectionMetadata(fixture('content/offer.plain.html')).html}</main></body></html>`;

function htmlResponse(body, headers = {}) {
  return new Response(body, {
    headers: {
      'content-type': 'text/html; charset=utf-8', etag: '"abc"', 'cache-control': 'max-age=7200', ...headers,
    },
  });
}

function request(url = 'https://www.example.com/', headers = {}) {
  return new Request(url, { headers: { 'user-agent': BROWSER, ...headers } });
}

function quiet(fn) {
  return async () => {
    const { warn, error } = console;
    console.warn = () => {};
    console.error = () => {};
    try {
      await fn();
    } finally {
      console.warn = warn;
      console.error = error;
    }
  };
}

// Personalized sections as the pipeline delivers them: Section Metadata rows
// are data-personalization* attributes, links absolute.
const AEM = 'https://main--site--org.aem.page';
const F = '/fragments/personalization';
const variants = (...names) => names.map((name) => `${AEM}${F}/${name}`).join(',');
const SECTIONS = {
  hero: `<div class="hero dark" data-personalization="hero" data-personalization-variants="${variants('hero/india', 'hero/quiz')}" data-personalization-rule-india="geo: IN" data-personalization-rule-quiz="state: persona=a"><h1>Authored hero</h1></div>`,
  promo: `<div data-personalization="promo" data-personalization-variants="${variants('promo/india')}" data-personalization-rule-india="geo: IN"><p>Authored promo</p></div>`,
  device: `<div data-personalization="device" data-personalization-variants="${variants('device/mobile', 'device/india')}" data-personalization-rule-mobile="device: mobile" data-personalization-rule-india="geo: IN"><p>Authored device</p></div>`,
  plan: `<div data-personalization="plan" data-personalization-source="api" data-personalization-variants="${variants('plan/enterprise', 'plan/agency', 'plan/mobile')}" data-personalization-rule-agency="param: utm_source=agency"><p>Authored plan</p></div>`,
  extra: `<div data-personalization="extra" data-personalization-source="api" data-personalization-variants="${variants('extra/x')}"><p>Authored extra</p></div>`,
  msg: `<div data-personalization="msg" data-personalization-source="split" data-personalization-variants="${variants('msg/speed', 'msg/team')}"><p>Authored msg</p></div>`,
  pick: `<div data-personalization="pick" data-personalization-source="split" data-personalization-split="0, 100" data-personalization-variants="${variants('pick/x', 'pick/y')}"><p>Authored pick</p></div>`,
  offer: `<div data-personalization="scroll-offer" data-personalization-source="target" data-personalization-trigger="scroll: 70%" data-personalization-variants="${variants('offer/free-trial')}"><p>Authored offer</p></div>`,
  inline: `<div data-personalization="inline-offer" data-personalization-source="target" data-personalization-variants="${variants('offer/inline')}"><p>Authored inline</p></div>`,
  invalid: `<div data-personalization="broken" data-personalization-source="bogus" data-personalization-variants="${variants('broken/a')}"><p>Authored broken</p></div>`,
  missing: `<div data-personalization="missing" data-personalization-variants="${variants('missing/india')}" data-personalization-rule-india="geo: IN"><p>Authored missing</p></div>`,
  quoted: `<div data-note="a > b" data-personalization="deal" data-personalization-variants="${variants('deal/vip')}" data-personalization-rule-vip="param: q=a>b"><p>Authored deal</p></div>`,
};
const FRAGMENTS = {
  [`${F}/hero/india`]: '<div><h1>India hero</h1><p><picture><source type="image/webp" srcset="./media_1a2b.png?width=2000&amp;format=webply 2000w, ./media_1a2b.png?width=750&amp;format=webply 750w"><img src="./media_1a2b.png?width=750&amp;format=png" alt=""></picture></p>'
    + '<p><a href="../other">Other</a> <a href="/abs">Abs</a> <a href="https://www.example.com/x">Full</a> <a href="#top">Top</a></p></div>'
    + '<div><div class="section-metadata"><div><div>style</div><div>dark</div></div></div><p>Second section</p></div>',
  [`${F}/promo/india`]: '<div><p>India promo</p></div>',
  [`${F}/device/india`]: '<div><p>India device</p></div>',
  [`${F}/plan/enterprise`]: '<div><h2>Enterprise plan</h2></div>',
  [`${F}/plan/agency`]: '<div><h2>Agency plan</h2></div>',
  [`${F}/msg/speed`]: '<div><p>Speed</p></div>',
  [`${F}/msg/team`]: '<div><p>Team</p></div>',
  [`${F}/pick/x`]: '<div><p>X</p></div>',
  [`${F}/pick/y`]: '<div><p>Y</p></div>',
  [`${F}/deal/vip`]: '<div><p>VIP deal</p></div>',
  // fixture site fragments
  [`${F}/home-hero/india`]: fixture(`content${F}/home-hero/india.html`),
  [`${F}/welcome/back`]: fixture(`content${F}/welcome/back.html`),
  [`${F}/offer/diwali`]: fixture(`content${F}/offer/diwali.html`),
  [`${F}/offer/india`]: fixture(`content${F}/offer/india.html`),
};
const sectionPage = (...names) => `<html><head><title>x</title></head><body><header></header><main>
${names.map((name) => SECTIONS[name] || name).join('\n')}
</main><footer></footer></body></html>`;

function fragments() {
  const calls = [];
  const fetchFragment = async (path) => {
    calls.push(path);
    return FRAGMENTS[path]
      ? new Response(FRAGMENTS[path], { headers: { 'content-type': 'text/html' } })
      : new Response('Not Found', { status: 404 });
  };
  return { calls, fetchFragment };
}

const section = (out, id) => {
  const found = html.findSections(out).find((candidate) => candidate.attributes
    .some(([name, value]) => name === 'data-personalization' && value === id));
  return found && {
    attrs: Object.fromEntries(found.attributes),
    inner: out.slice(found.openEnd, found.closeStart),
    raw: out.slice(found.start, found.end),
  };
};
const untouched = (out, name) => assert.ok(out.includes(SECTIONS[name]), `${name} is left to the browser`);
const engineConfig = { ...baseConfig, api: { ...baseConfig.api, endpoint: 'https://engine.example/decide' } };

describe('personalizeResponse', () => {
  it('decides geo at the edge and defers browser-only criteria', async () => {
    const { fetchFragment } = fragments();
    const out = await personalizeResponse(request(), htmlResponse(PAGE), {
      config: baseConfig, cf: { country: 'IN' }, cache: null, fetchFragment,
    });
    const text = await out.text();
    const hero = section(text, 'home-hero');
    assert.deepEqual([hero.attrs['data-pzn-source'], hero.attrs['data-pzn-variant'], hero.attrs['data-pzn-fragment']], ['edge', 'india', `${F}/home-hero/india`]);
    assert.match(hero.inner, /Variant home-hero\/india/);
    // welcome: visitor is known (new) but the state rule after it is browser-only.
    assert.equal(section(text, 'welcome').attrs['data-pzn-source'], undefined);
    assert.match(text, /<meta name="pzn-geo" content="IN"><\/head>/);
    assert.equal(out.headers.get('cache-control'), 'private, no-cache');
    assert.equal(out.headers.get('etag'), null);
    assert.equal(out.headers.get('x-pzn'), 'edge');
  });

  it('uses the returning-visitor cookie', async () => {
    const { fetchFragment } = fragments();
    const out = await personalizeResponse(
      request('https://www.example.com/', { cookie: 'pzn-seen=1' }),
      htmlResponse(PAGE),
      {
        config: baseConfig, cf: { country: 'FR' }, cache: null, fetchFragment,
      },
    );
    const text = await out.text();
    assert.equal(section(text, 'welcome').attrs['data-pzn-variant'], 'back');
    // FR: the geo rule fails, the next rule needs device -> the browser decides.
    assert.equal(section(text, 'home-hero').attrs['data-pzn-source'], undefined);
  });

  it('serves verified bots the authored content', async () => {
    const out = await personalizeResponse(request(), htmlResponse(PAGE), {
      config: baseConfig, cf: { country: 'IN', botManagement: { verifiedBot: true } }, cache: null,
    });
    const text = await out.text();
    assert.equal(section(text, 'home-hero').attrs['data-pzn-variant'], 'default');
    assert.match(section(text, 'home-hero').inner, /Original hero/);
  });

  it('marks pages it cannot decide as deferred', async () => {
    const out = await personalizeResponse(request(), htmlResponse(PAGE), { config: baseConfig, cf: { country: 'US' }, cache: null });
    assert.equal(out.headers.get('x-pzn'), 'deferred');
    assert.equal(out.headers.get('cache-control'), 'private, no-cache');
  });

  it('passes through everything that is not a personalized HTML page', async () => {
    const plain = htmlResponse('<main><div>No personalized sections</div></main>');
    const out = await personalizeResponse(request(), plain, { config: baseConfig, cache: null });
    assert.equal(out.headers.get('x-pzn'), null);
    assert.equal(out.headers.get('cache-control'), 'max-age=7200');

    const json = new Response('{}', { headers: { 'content-type': 'application/json' } });
    assert.equal(await personalizeResponse(request(), json, { config: baseConfig }), json);
    const notFound = new Response('x', { status: 404, headers: { 'content-type': 'text/html' } });
    assert.equal(await personalizeResponse(request(), notFound, { config: baseConfig }), notFound);
    const fragment = htmlResponse(PAGE);
    assert.equal(await personalizeResponse(request('https://www.example.com/a.plain.html'), fragment, { config: baseConfig }), fragment);
    const head = htmlResponse(PAGE);
    assert.equal(await personalizeResponse(new Request('https://www.example.com/', { method: 'HEAD' }), head, { config: baseConfig }), head);
  });

  it('asks the engine with consent and caches cacheable answers', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return Response.json({ decisions: { offer: { variant: 'diwali' } }, ttl: 60, cacheable: true });
    };
    const store = new Map();
    const cache = {
      match: async (key) => store.get(key.url)?.clone(),
      put: async (key, value) => { store.set(key.url, value); },
    };
    const { fetchFragment } = fragments();
    const run = () => personalizeResponse(
      request('https://www.example.com/offers?utm_campaign=x&email=a', { cookie: 'pzn-consent=1' }),
      htmlResponse(OFFER_PAGE),
      {
        config: engineConfig, env: { PZN_API_KEY: 'k' }, cf: { country: 'IN' }, cache, fetchImpl, fetchFragment,
      },
    );
    const first = await (await run()).text();
    assert.equal(section(first, 'offer').attrs['data-pzn-variant'], 'diwali');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://engine.example/decide');
    assert.equal(calls[0].init.headers.authorization, 'Bearer k');
    assert.equal(calls[0].body.mode, 'edge');
    assert.deepEqual(calls[0].body.placeholders, [{ id: 'offer', candidates: ['diwali', 'india', 'default'] }]);
    assert.deepEqual(calls[0].body.context.params, { utm_campaign: 'x' });
    const second = await (await run()).text();
    assert.equal(section(second, 'offer').attrs['data-pzn-variant'], 'diwali');
    assert.equal(calls.length, 1, 'second request served from the Cache API');
  });

  it('serves origin HTML when processing throws', quiet(async () => {
    const config = { ...baseConfig, fragmentPrefixes: null, get botsGetDefault() { throw new Error('boom'); } };
    const out = await personalizeResponse(request(), htmlResponse(PAGE), { config, cache: null });
    assert.equal(await out.text(), PAGE);
    assert.equal(out.headers.get('x-pzn'), null);
  }));

  it('builds the edge context from cf and cookies', () => {
    const ctx = edgeContext(request('https://www.example.com/?a=1', { cookie: 'pzn-seen=1; pzn-consent=1' }), { country: 'us', regionCode: 'ca' });
    assert.deepEqual(ctx, {
      geo: { country: 'US', region: 'CA' }, visitor: 'returning', params: { a: '1' }, state: {}, consent: true,
    });
    assert.equal(edgeContext(request(), { country: 'T1' }).geo, null);
  });
});

describe('personalizeResponse: sections', () => {
  it('shows a rules section\'s variant fragment, with its URLs rewritten', async () => {
    const { calls, fetchFragment } = fragments();
    const out = await personalizeResponse(request(), htmlResponse(sectionPage('hero')), {
      config: baseConfig, cf: { country: 'IN' }, cache: null, fetchFragment,
    });
    const text = await out.text();
    const hero = section(text, 'hero');
    assert.deepEqual(hero.attrs, {
      class: 'hero dark',
      'data-personalization': 'hero',
      'data-personalization-variants': variants('hero/india', 'hero/quiz'),
      'data-personalization-rule-india': 'geo: IN',
      'data-personalization-rule-quiz': 'state: persona=a',
      'data-pzn-source': 'edge',
      'data-pzn-variant': 'india',
      'data-pzn-fragment': `${F}/hero/india`,
      'data-pzn-status': 'applied',
    });
    assert.equal(hero.inner, '<h1>India hero</h1><p><picture><source type="image/webp" srcset="/fragments/personalization/hero/media_1a2b.png?width=2000&amp;format=webply 2000w, /fragments/personalization/hero/media_1a2b.png?width=750&amp;format=webply 750w"><img src="/fragments/personalization/hero/media_1a2b.png?width=750&amp;format=png" alt=""></picture></p>'
      + '<p><a href="/fragments/personalization/other">Other</a> <a href="/abs">Abs</a> <a href="https://www.example.com/x">Full</a> <a href="#top">Top</a></p>'
      + '<p>Second section</p>');
    assert.deepEqual(calls, [`${F}/hero/india`]);
    assert.match(text, /<meta name="pzn-geo" content="IN">/);
    assert.equal(out.headers.get('x-pzn'), 'edge');
    assert.equal(out.headers.get('cache-control'), 'private, no-cache');
    assert.equal(out.headers.get('etag'), null);
    assert.equal(out.headers.get('set-cookie'), null);
  });

  it('keeps the authored content as the default and leaves browser-only rules to the browser', async () => {
    const { calls, fetchFragment } = fragments();
    const out = await personalizeResponse(request(), htmlResponse(sectionPage('promo', 'device', 'hero')), {
      config: baseConfig, cf: { country: 'FR' }, cache: null, fetchFragment,
    });
    const text = await out.text();
    const promo = section(text, 'promo');
    assert.equal(promo.inner, '<p>Authored promo</p>');
    assert.deepEqual([promo.attrs['data-pzn-source'], promo.attrs['data-pzn-variant'], promo.attrs['data-pzn-status'], promo.attrs['data-pzn-fragment']], ['edge', 'default', 'applied', undefined]);
    // FR: the geo rule fails and the state rule after it needs the browser.
    untouched(text, 'hero');
    const indian = await (await personalizeResponse(request(), htmlResponse(sectionPage('device')), {
      config: baseConfig, cf: { country: 'IN' }, cache: null, fetchFragment,
    })).text();
    // A device rule before the geo rule: only the browser knows which matches first.
    untouched(indian, 'device');
    assert.deepEqual(calls, []);
  });

  it('asks the engine once for the page\'s api sections, with the secret', async () => {
    const engine = [];
    const fetchImpl = async (url, init) => {
      engine.push({ url, init, body: JSON.parse(init.body) });
      return Response.json({ decisions: { plan: { variant: 'enterprise', tracking: { a: '1' } }, extra: { variant: null } } });
    };
    const { fetchFragment } = fragments();
    const page = sectionPage('plan', 'extra');
    const out = await personalizeResponse(request('https://www.example.com/plans?utm_source=agency&email=a', { cookie: 'pzn-consent=1' }), htmlResponse(page), {
      config: engineConfig, env: { PZN_API_KEY: 'k' }, cf: { country: 'IN' }, cache: null, fetchImpl, fetchFragment,
    });
    const text = await out.text();
    assert.equal(engine.length, 1, 'one engine call per page');
    assert.equal(engine[0].init.headers.authorization, 'Bearer k');
    assert.equal(engine[0].body.mode, 'edge');
    assert.deepEqual(engine[0].body.placeholders, [
      { id: 'plan', candidates: ['agency', 'enterprise', 'mobile', 'default'] },
      { id: 'extra', candidates: ['x', 'default'] },
    ]);
    assert.deepEqual(engine[0].body.context.params, { utm_source: 'agency' });
    assert.equal(section(text, 'plan').inner, '<h2>Enterprise plan</h2>');
    assert.equal(section(text, 'plan').attrs['data-pzn-variant'], 'enterprise');
    assert.equal(section(text, 'extra').attrs['data-pzn-variant'], 'default', 'a control decision keeps the authored content');
    assert.equal(section(text, 'extra').inner, '<p>Authored extra</p>');
  });

  it('falls back to the rules without an engine answer, else leaves api sections to the browser', quiet(async () => {
    let calls = 0;
    const failing = async () => { calls += 1; return new Response('down', { status: 500 }); };
    const { fetchFragment } = fragments();
    const run = (cookie) => personalizeResponse(
      request('https://www.example.com/plans?utm_source=agency', cookie ? { cookie } : {}),
      htmlResponse(sectionPage('plan', 'extra')),
      {
        config: engineConfig, cf: { country: 'IN' }, cache: null, fetchImpl: failing, fetchFragment,
      },
    );
    const failed = await (await run('pzn-consent=1')).text();
    assert.equal(calls, 1);
    assert.equal(section(failed, 'plan').inner, '<h2>Agency plan</h2>');
    untouched(failed, 'extra');
    const noConsent = await (await run()).text();
    assert.equal(calls, 1, 'no engine call without the consent cookie');
    assert.equal(section(noConsent, 'plan').attrs['data-pzn-variant'], 'agency');
    untouched(noConsent, 'extra');
  }));

  it('assigns split sections once per browser session', async () => {
    const { fetchFragment } = fragments();
    const run = async (cookie) => {
      const out = await personalizeResponse(request('https://www.example.com/', cookie ? { cookie } : {}), htmlResponse(sectionPage('msg', 'pick')), {
        config: baseConfig, cache: null, fetchFragment,
      });
      return { out, text: await out.text() };
    };
    const first = await run();
    const setCookie = first.out.headers.get('set-cookie');
    assert.match(setCookie, /^pzn-split=[^;]+; Path=\/; SameSite=Lax; Secure$/);
    const assigned = Object.fromEntries(decodeURIComponent(setCookie.split(';')[0].slice('pzn-split='.length))
      .split(',').map((pair) => pair.split(':')));
    assert.equal(assigned.pick, 'y', '0, 100 always assigns the second variant');
    assert.equal(section(first.text, 'pick').inner, '<p>Y</p>');
    assert.ok(['default', 'speed', 'team'].includes(assigned.msg));
    const msg = section(first.text, 'msg');
    assert.equal(msg.attrs['data-pzn-variant'], assigned.msg);
    assert.equal(msg.inner, { default: '<p>Authored msg</p>', speed: '<p>Speed</p>', team: '<p>Team</p>' }[assigned.msg]);

    const sticky = await run(`pzn-split=${encodeURIComponent('msg:team,other:z')}`);
    assert.equal(section(sticky.text, 'msg').inner, '<p>Team</p>');
    assert.equal(decodeURIComponent(sticky.out.headers.get('set-cookie').split(';')[0]), 'pzn-split=msg:team,other:z,pick:y');
    const known = await run(`pzn-split=${encodeURIComponent('msg:default,pick:y')}`);
    assert.equal(section(known.text, 'msg').inner, '<p>Authored msg</p>');
    assert.equal(known.out.headers.get('set-cookie'), null, 'nothing new to remember');
  });

  it('serves bots the authored content: no engine call, no fragment, no split cookie', async () => {
    let calls = 0;
    const counting = async () => { calls += 1; return Response.json({ decisions: {} }); };
    const { calls: fetched, fetchFragment } = fragments();
    const out = await personalizeResponse(
      request('https://www.example.com/?utm_source=agency', { 'user-agent': 'Googlebot/2.1', cookie: 'pzn-consent=1' }),
      htmlResponse(sectionPage('hero', 'plan', 'msg', 'offer')),
      {
        config: engineConfig, cf: { country: 'IN' }, cache: null, fetchImpl: counting, fetchFragment,
      },
    );
    const text = await out.text();
    ['hero', 'plan', 'msg'].forEach((id) => {
      const decided = section(text, id);
      assert.equal(decided.attrs['data-pzn-variant'], 'default', id);
      assert.match(decided.inner, /Authored/);
    });
    untouched(text, 'offer');
    assert.equal(calls, 0);
    assert.deepEqual(fetched, []);
    assert.equal(out.headers.get('set-cookie'), null);
  });

  it('leaves target, invalid and failing sections to the browser', quiet(async () => {
    const { calls, fetchFragment } = fragments();
    const page = sectionPage('offer', 'inline', 'invalid', 'missing');
    const out = await personalizeResponse(request(), htmlResponse(page), {
      config: baseConfig, cf: { country: 'IN' }, cache: null, fetchFragment,
    });
    const text = await out.text();
    ['offer', 'inline', 'invalid', 'missing'].forEach((name) => untouched(text, name));
    assert.deepEqual(calls, [`${F}/missing/india`]);
    assert.equal(out.headers.get('x-pzn'), 'deferred');
    assert.equal(out.headers.get('cache-control'), 'private, no-cache');
  }));

  it('leaves a section to the browser when its fragment is slow', quiet(async () => {
    const out = await personalizeResponse(request(), htmlResponse(sectionPage('promo')), {
      config: { ...baseConfig, fragmentTimeout: 20 }, cf: { country: 'IN' }, cache: null, fetchFragment: () => new Promise(() => {}),
    });
    untouched(await out.text(), 'promo');
  }));

  it('marks defaults but leaves variants to the browser without fetchFragment', async () => {
    const out = await personalizeResponse(request(), htmlResponse(sectionPage('promo', 'hero')), {
      config: baseConfig, cf: { country: 'IN' }, cache: null,
    });
    const text = await out.text();
    untouched(text, 'promo');
    untouched(text, 'hero');
  });

  it('reads quoted attribute values holding ">"', async () => {
    const { fetchFragment } = fragments();
    const out = await personalizeResponse(request('https://www.example.com/?q=a%3Eb'), htmlResponse(sectionPage('quoted')), {
      config: baseConfig, cache: null, fetchFragment,
    });
    const deal = section(await out.text(), 'deal');
    assert.equal(deal.attrs['data-note'], 'a > b');
    assert.equal(deal.attrs['data-personalization-rule-vip'], 'param: q=a>b');
    assert.equal(deal.inner, '<p>VIP deal</p>');
  });

  it('leaves sections to the browser while overrides are active', async () => {
    const { calls, fetchFragment } = fragments();
    const out = await personalizeResponse(request('https://www.example.com/?pzn=hero:india'), htmlResponse(sectionPage('hero', 'msg')), {
      config: { ...baseConfig, overrides: 'always' }, cf: { country: 'IN' }, cache: null, fetchFragment,
    });
    const text = await out.text();
    untouched(text, 'hero');
    untouched(text, 'msg');
    assert.deepEqual(calls, []);
    assert.equal(out.headers.get('set-cookie'), null);
  });

  it('flattens fragments and rewrites only relative URLs', () => {
    assert.equal(fragmentMarkup('<div>  </div>', `${F}/x/y`), null);
    assert.equal(fragmentMarkup('<p>loose</p>', `${F}/x/y`), '<p>loose</p>');
    assert.equal(absolutizeUrls('<img src=\'./media_a.png\'><a href="mailto:a@b.c">m</a><a href="tel:1">t</a><a href="?x=1">q</a> src="./not-a-tag"', `${F}/x/y`),
      '<img src=\'/fragments/personalization/x/media_a.png\'><a href="mailto:a@b.c">m</a><a href="tel:1">t</a><a href="?x=1">q</a> src="./not-a-tag"');
  });
});

describe('handleApiRoute', () => {
  const config = { ...baseConfig, api: { ...baseConfig.api, endpoint: '' } };
  const V1 = JSON.stringify({
    version: '1',
    page: { path: '/offers' },
    placeholders: [{ id: 'offer', candidates: ['india', 'default'] }],
    context: { geo: { country: 'IN' }, params: {}, consent: { personalization: true } },
    mode: 'client',
  });
  const SITE_HEADERS = { origin: 'https://www.example.com', 'sec-fetch-site': 'same-origin', cookie: 'pzn-consent=1' };
  const post = (body, headers = SITE_HEADERS, path = '/pzn/decide') => new Request(`https://www.example.com${path}`, { method: 'POST', body, headers });
  const env = { PZN_API_ENDPOINT: 'https://engine.example' };
  const engine = async () => Response.json({ decisions: {} });

  it('ignores other paths and rejects bad requests', async () => {
    assert.equal(await handleApiRoute(request(), {}, config), null);
    assert.equal(await handleApiRoute(post(V1), {}, { ...config, apiRoute: '' }), null);
    assert.equal((await handleApiRoute(new Request('https://www.example.com/pzn/decide'), {}, config)).status, 405);
    assert.equal((await handleApiRoute(post(V1), {}, config)).status, 503);
    assert.equal((await handleApiRoute(post('x'.repeat(20000)), env, config)).status, 413);
    // Multi-byte characters count as bytes, not characters.
    assert.equal((await handleApiRoute(post(`"${'é'.repeat(9000)}"`), env, config)).status, 413);
    assert.equal((await handleApiRoute(post('{bad'), env, config)).status, 400);
  });

  it('only forwards same-origin v1 requests with consent', async () => {
    let calls = 0;
    const counting = async () => { calls += 1; return Response.json({ decisions: {} }); };
    const send = (body, headers) => handleApiRoute(post(body, headers), env, config, counting);
    assert.equal((await send(V1, { ...SITE_HEADERS, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await send(V1, { cookie: 'pzn-consent=1' })).status, 403, 'no Origin header');
    assert.equal((await send(V1, { ...SITE_HEADERS, cookie: '' })).status, 403, 'no consent cookie');
    assert.equal((await send('{"version":"1"}')).status, 400, 'not a v1 request');
    assert.match(await (await send('{"slots":["offer"]}')).text(), /leave mapRequest\/mapResponse empty/);
    assert.equal(calls, 0);
    assert.equal((await handleApiRoute(post(V1, { ...SITE_HEADERS, cookie: '' }), env, {
      ...config, api: { ...config.api, sendWithoutConsent: true },
    }, counting)).status, 200);
    assert.equal(calls, 1);
  });

  it('rebuilds the body from contract fields only', async () => {
    let seen;
    const fetchImpl = async (url, init) => { seen = JSON.parse(init.body); return Response.json({ decisions: {} }); };
    const extra = JSON.parse(V1);
    extra.anything = 'x'.repeat(100);
    extra.context.state = { quiz: 'cn', nested: { a: 1 } };
    extra.mode = 'edge';
    await handleApiRoute(post(JSON.stringify(extra)), env, config, fetchImpl);
    assert.equal('anything' in seen, false);
    assert.deepEqual(seen.context.state, { quiz: 'cn' });
    assert.equal(seen.mode, 'client');
  });

  it('applies the optional rate limiter', async () => {
    const keys = [];
    const limiter = { limit: async ({ key }) => { keys.push(key); return { success: false }; } };
    const out = await handleApiRoute(post(V1, { ...SITE_HEADERS, 'cf-connecting-ip': '203.0.113.9' }), { ...env, PZN_RATE_LIMITER: limiter }, config, engine);
    assert.equal(out.status, 429);
    assert.deepEqual(keys, ['203.0.113.9']);
  });

  it('proxies to the engine with the secret and validates the answer', quiet(async () => {
    let seen;
    const fetchImpl = async (url, init) => {
      seen = { url, init };
      return Response.json({ decisions: { offer: { variant: 'x', junk: 1 } }, ttl: 10 });
    };
    const keyed = { ...env, PZN_API_KEY: 'secret' };
    const out = await handleApiRoute(post(V1), keyed, config, fetchImpl);
    assert.equal(out.status, 200);
    assert.equal(out.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(await out.json(), { decisions: { offer: { variant: 'x' } }, ttl: 10, cacheable: false });
    assert.equal(seen.url, 'https://engine.example');
    assert.equal(seen.init.headers.authorization, 'Bearer secret');
    const failed = await handleApiRoute(post(V1), keyed, config, async () => Response.json({ nope: 1 }));
    assert.equal(failed.status, 502);
    assert.deepEqual(await failed.json(), { decisions: {} });
  }));

  it('applies request and response adapters', async () => {
    const adapted = {
      ...config,
      api: {
        ...config.api,
        mapRequest: (body) => ({ url: 'https://vendor.example/v2', body: { slots: body.placeholders.map((p) => p.id) } }),
        mapResponse: (json) => ({ decisions: Object.fromEntries(json.results.map((r) => [r.slot, { variant: r.choice }])) }),
      },
    };
    let seen;
    const fetchImpl = async (url, init) => {
      seen = { url, body: JSON.parse(init.body) };
      return Response.json({ results: [{ slot: 'offer', choice: 'india' }] });
    };
    const out = await handleApiRoute(post(V1), env, adapted, fetchImpl);
    assert.deepEqual(seen, { url: 'https://vendor.example/v2', body: { slots: ['offer'] } });
    assert.deepEqual((await out.json()).decisions, { offer: { variant: 'india' } });
  });
});

describe('worker entry point (index.mjs)', () => {
  let worker;
  let originRequests;
  const realFetch = globalThis.fetch;

  before(async () => {
    ({ default: worker } = await bundle.load('index.mjs'));
    originRequests = [];
    globalThis.fetch = async (req) => {
      originRequests.push(req);
      const url = new URL(req.url);
      if (url.pathname === '/') return htmlResponse(PAGE, { age: '10', 'x-robots-tag': 'noindex' });
      if (url.pathname === '/sections') return htmlResponse(sectionPage('promo'));
      const fragment = FRAGMENTS[url.pathname.replace(/\.plain\.html$/, '')];
      if (fragment) return htmlResponse(fragment);
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    };
  });
  after(() => { globalThis.fetch = realFetch; });

  const env = { ORIGIN_HOSTNAME: 'main--site--org.aem.live' };
  const ctx = { waitUntil: () => {} };

  it('fetches the AEM origin with an unchanged cache key and personalizes the HTML', async () => {
    const req = new Request('https://www.example.com/?utm_campaign=x', { headers: { 'user-agent': BROWSER, host: 'www.example.com' } });
    req.cf = { country: 'IN' };
    const start = originRequests.length;
    const out = await worker.fetch(Object.assign(req, { cf: { country: 'IN' } }), env, ctx);
    const origin = originRequests[start];
    assert.equal(origin.url, 'https://main--site--org.aem.live/');
    assert.equal(originRequests.at(-1).url, 'https://main--site--org.aem.live/fragments/personalization/home-hero/india.plain.html');
    assert.equal(origin.headers.get('x-byo-cdn-type'), 'cloudflare');
    assert.equal(out.headers.get('x-robots-tag'), null);
    assert.equal(out.headers.get('x-pzn'), 'edge');
    assert.equal(section(await out.text(), 'home-hero').attrs['data-pzn-variant'], 'india');
  });

  it('fetches section fragments from the AEM origin', async () => {
    const req = new Request('https://www.example.com/sections', { headers: { 'user-agent': BROWSER, host: 'www.example.com' } });
    const out = await worker.fetch(Object.assign(req, { cf: { country: 'IN' } }), env, ctx);
    const origin = originRequests.at(-1);
    assert.equal(origin.url, 'https://main--site--org.aem.live/fragments/personalization/promo/india.plain.html');
    assert.equal(origin.headers.get('x-forwarded-host'), 'www.example.com');
    assert.equal(section(await out.text(), 'promo').inner, '<p>India promo</p>');
  });

  it('keeps the official worker behavior for non-HTML and invalid origins', async () => {
    const json = await worker.fetch(new Request('https://www.example.com/data.json?limit=1&x=2'), env, ctx);
    assert.equal(originRequests.at(-1).url, 'https://main--site--org.aem.live/data.json?limit=1');
    assert.equal(json.headers.get('x-pzn'), null);
    const invalid = await worker.fetch(new Request('https://www.example.com/'), { ORIGIN_HOSTNAME: 'evil.example' }, ctx);
    assert.equal(invalid.status, 500);
    const drafts = await worker.fetch(new Request('https://www.example.com/drafts/x'), env, ctx);
    assert.equal(drafts.status, 404);
  });

  it('routes /pzn/decide before the origin', async () => {
    const before = originRequests.length;
    const out = await worker.fetch(new Request('https://www.example.com/pzn/decide', { method: 'POST', body: '{}' }), env, ctx);
    assert.equal(out.status, 503);
    assert.equal(originRequests.length, before);
  });
});

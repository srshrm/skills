/*
 * Decision sources (scripts/personalization/sources/*.js) and the mock
 * engine, in Node: request and response shapes, the offer allowlist, split
 * assignment and the Web SDK mapping. The browser behaviour is covered by
 * sections.test.mjs.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { RUNTIME_DIR } from '../lib.mjs';

const load = (...parts) => import(pathToFileURL(join(RUNTIME_DIR, 'scripts', 'personalization', ...parts)).href);
const { parseSection, listedVariant } = await load('section-spec.js');
const split = await load('sources', 'split.js');
const target = await load('sources', 'target.js');
const websdk = await load('sources', 'target-websdk.js');
const api = await load('sources', 'api.js');
const rulesSource = (await load('sources', 'rules.js')).default;
const { engineDecide, targetDeliver, isDeliveryUrl } = await load('mock-engine.js');

const F = '/fragments/personalization';
const section = (pairs) => parseSection(Object.entries(pairs)
  .map(([key, value]) => [key ? `data-personalization-${key}` : 'data-personalization', value]));

describe('split source', () => {
  const spec = section({
    '': 'msg', source: 'split', variants: `${F}/msg/speed,${F}/msg/team`,
  });

  it('reads and writes the pzn-split cookie value', () => {
    assert.deepEqual(split.parseAssignments('msg:team, pick:y,broken,:x'), { msg: 'team', pick: 'y' });
    assert.equal(split.formatAssignments({ msg: 'team', pick: 'y' }), 'msg:team,pick:y');
  });

  it('keeps a listed earlier assignment, else picks by weight', () => {
    assert.equal(split.assign(spec, 'team', () => 0), 'team');
    assert.equal(split.assign(spec, 'default', () => 0.99), 'default');
    assert.equal(split.assign(spec, 'gone', () => 0), 'default', 'an assignment to a removed variant is redrawn');
    assert.equal(split.assign(spec, undefined, () => 0.5), 'speed');
    assert.equal(split.assign(spec, undefined, () => 0.9), 'team');
  });

  it('honors the authored weights', () => {
    const weighted = section({
      '': 'pick', source: 'split', variants: `${F}/pick/x,${F}/pick/y`, split: '0, 100',
    });
    [0, 0.25, 0.5, 0.999].forEach((random) => assert.equal(split.assign(weighted, undefined, () => random), 'y'));
  });
});

describe('rules source', () => {
  it('decides every section from its rules', async () => {
    const spec = section({
      '': 'hero', variants: `${F}/hero/india`, 'rule-india': 'geo: IN',
    });
    const { decisions } = await rulesSource.decide([{ id: 'hero', spec }], { geo: { country: 'IN' } }, { config: {} });
    assert.equal(decisions.hero.variant, 'india');
  });
});

describe('api source', () => {
  it('turns sections into contract specs, unruled variants included', () => {
    const spec = section({
      '': 'plan', source: 'api', variants: `${F}/plan/enterprise,${F}/plan/agency`, 'rule-agency': 'param: utm_source=agency',
    });
    const [contract] = api.contractSpecs([spec]);
    assert.deepEqual(contract.rules.map((rule) => [rule.variant, rule.clauses.length]), [['agency', 1], ['enterprise', 0]]);
  });

  it('fails without an endpoint', async () => {
    const spec = section({ '': 'plan', source: 'api', variants: `${F}/plan/a` });
    const result = await api.default.decide([{ id: 'plan', spec }], {}, { config: { api: {} }, fetch: () => assert.fail('no call') });
    assert.match(result.error, /endpoint/);
  });
});

describe('target source (Delivery API)', () => {
  it('builds the delivery URL, honoring the edge host and a proxy endpoint', () => {
    assert.equal(target.deliveryUrl({ clientCode: 'acme' }, 's1'), 'https://acme.tt.omtrdc.net/rest/v1/delivery?client=acme&sessionId=s1');
    assert.equal(target.deliveryUrl({ clientCode: 'acme' }, 's1', 'mboxedge37.tt.omtrdc.net'), 'https://mboxedge37.tt.omtrdc.net/rest/v1/delivery?client=acme&sessionId=s1');
    assert.equal(target.deliveryUrl({ clientCode: 'acme', endpoint: '/target/delivery' }, 's1', null, 'https://www.example.com/page'), 'https://www.example.com/target/delivery?client=acme&sessionId=s1');
  });

  it('prefetches every mbox in one request with device and visitor parameters', () => {
    const body = target.prefetchRequest(['plan', 'offer'], { device: 'mobile', visitor: 'returning', geo: { country: 'IN' } }, {
      requestId: 'r1', tntId: 't1', propertyToken: 'p1', page: { url: 'https://x/?a=1', referrer: '', screen: { width: 1, height: 2 }, viewport: { width: 3, height: 4 } },
    });
    assert.deepEqual(body, {
      requestId: 'r1',
      id: { tntId: 't1' },
      property: { token: 'p1' },
      context: {
        channel: 'web', address: { url: 'https://x/?a=1' }, screen: { width: 1, height: 2 }, window: { width: 3, height: 4 },
      },
      prefetch: {
        mboxes: [
          { index: 0, name: 'plan', parameters: { device: 'mobile', visitor: 'returning' } },
          { index: 1, name: 'offer', parameters: { device: 'mobile', visitor: 'returning' } },
        ],
      },
    });
    assert.equal(target.prefetchRequest(['x'], {}, { requestId: 'r', page: {} }).id, undefined, 'no tntId without consent');
  });

  it('turns JSON offers into decisions with their event tokens', () => {
    const mbox = {
      name: 'offer',
      options: [{
        type: 'json', content: { fragment: `${F}/offer/free-trial` }, eventToken: 'e1', responseTokens: { 'activity.name': 'Scroll offer' },
      }],
      metrics: [{ type: 'click', eventToken: 'c1' }, { type: 'display', eventToken: 'x' }],
    };
    assert.deepEqual(target.toDecision(mbox), {
      fragment: `${F}/offer/free-trial`,
      tracking: { 'activity.name': 'Scroll offer' },
      data: { display: ['e1'], click: ['c1'] },
    });
    assert.deepEqual(target.toDecision({ name: 'offer' }), { variant: null, tracking: {} });
    assert.match(target.toDecision({ options: [{ type: 'html', content: '<p>hi</p>' }] }).error, /not JSON/);
  });

  it('shows only allowed fragments: listed ones, or any under the prefixes for open sections', () => {
    const listed = section({ '': 'offer', source: 'target', variants: `${F}/offer/free-trial` });
    const decision = (fragment) => target.toDecision({ options: [{ type: 'json', content: { fragment } }] });
    assert.equal(listedVariant(listed, decision(`${F}/offer/free-trial`)).name, 'free-trial');
    assert.equal(listedVariant(listed, decision(`${F}/offer/other`)), undefined);
    const open = section({ '': 'offer', source: 'target' });
    assert.equal(listedVariant(open, decision(`${F}/offer/other`)).name, 'other');
    assert.equal(listedVariant(open, decision('/drafts/offer')), undefined);
    assert.equal(listedVariant(open, decision('javascript:alert(1)')), undefined);
  });

  it('builds display and click notifications', () => {
    const body = target.notificationRequest('click', 'offer', ['c1'], {
      requestId: 'r', id: 'n', tntId: null, page: { url: 'https://x/' }, timestamp: 1,
    });
    assert.deepEqual(body.notifications, [{
      id: 'n', type: 'click', timestamp: 1, mbox: { name: 'offer' }, tokens: ['c1'],
    }]);
    assert.equal(body.id, undefined);
  });
});

describe('target source (Web SDK)', () => {
  const proposition = (scope, fragment, schema = 'https://ns.adobe.com/personalization/json-content-item') => ({
    id: `p-${scope}`,
    scope,
    scopeDetails: { activity: { id: '1' }, characteristics: { eventToken: 't' } },
    items: [{ schema, data: { content: fragment === undefined ? '<p>x</p>' : { fragment } } }],
  });

  it('maps propositions to decisions per scope', () => {
    const decisions = websdk.toDecisions([
      proposition('offer', `${F}/offer/free-trial`),
      proposition('html', undefined),
      proposition('other', `${F}/x/y`, 'https://ns.adobe.com/personalization/dom-action'),
    ], ['offer', 'html', 'other', 'none']);
    assert.equal(decisions.offer.fragment, `${F}/offer/free-trial`);
    assert.deepEqual(decisions.offer.tracking, { eventToken: 't' });
    assert.equal(decisions.offer.data.proposition.id, 'p-offer');
    assert.match(decisions.html.error, /not JSON/);
    assert.deepEqual(decisions.other, { variant: null, tracking: {} });
    assert.deepEqual(decisions.none, { variant: null, tracking: {} });
  });

  it('reports display and click as proposition events', () => {
    const p = { id: 'p', scope: 'offer', scopeDetails: {} };
    assert.equal(websdk.propositionEvent('display', p).xdm.eventType, 'decisioning.propositionDisplay');
    const click = websdk.propositionEvent('click', p).xdm;
    assert.equal(click.eventType, 'decisioning.propositionInteract');
    assert.deepEqual(click._experience.decisioning.propositions, [p]);
  });
});

describe('mock engine', () => {
  it('decides like a table-driven engine', async () => {
    const table = {
      ttl: 0,
      placeholders: {
        plan: { 'param: utm_campaign=enterprise': 'enterprise', 'device: mobile': 'mobile', 'weather: x': 'bad' },
      },
    };
    const answer = await engineDecide(table, {
      placeholders: [{ id: 'plan' }, { id: 'none' }], context: { params: { utm_campaign: 'enterprise' }, device: 'mobile' },
    });
    assert.deepEqual(answer, {
      decisions: { plan: { variant: 'enterprise', tracking: { engine: 'mock', rule: 'param: utm_campaign=enterprise' } } },
      ttl: 0,
      cacheable: false,
    });
  });

  it('answers Target prefetch by experience audience, first match wins', async () => {
    const activities = {
      offer: {
        name: 'Scroll offer',
        experiences: [
          { name: 'Enterprise', audience: 'param: utm_campaign=enterprise', offer: `${F}/offer/enterprise` },
          { name: 'Returning', audience: 'visitor: returning', offer: `${F}/offer/welcome-back` },
          { name: 'Everyone', audience: null, offer: `${F}/offer/free-trial` },
        ],
      },
    };
    const prefetch = (url, parameters) => targetDeliver(activities, {
      requestId: 'r',
      context: { address: { url } },
      prefetch: { mboxes: [{ index: 0, name: 'offer', parameters }, { index: 1, name: 'unknown' }] },
    }, { clientCode: 'acme' });
    const offer = async (...args) => target.toDecision((await prefetch(...args)).prefetch.mboxes[0]).fragment;
    assert.equal(await offer('https://x/?utm_campaign=enterprise', { visitor: 'returning' }), `${F}/offer/enterprise`);
    assert.equal(await offer('https://x/', { visitor: 'returning' }), `${F}/offer/welcome-back`);
    assert.equal(await offer('https://x/', { visitor: 'new' }), `${F}/offer/free-trial`);
    const response = await prefetch('https://x/', {});
    assert.deepEqual(response.prefetch.mboxes[1], { index: 1, name: 'unknown' });
    assert.equal(response.client, 'acme');
    assert.equal(response.edgeHost, 'mboxedge37.tt.omtrdc.net');
    assert.equal(response.prefetch.mboxes[0].options[0].responseTokens['activity.name'], 'Scroll offer');
  });

  it('acknowledges notifications', async () => {
    const response = await targetDeliver({}, { requestId: 'r', id: { tntId: 't' }, notifications: [{ id: 'n1', type: 'display' }] });
    assert.deepEqual([response.notifications, response.id], [[{ id: 'n1' }], { tntId: 't' }]);
  });

  it('recognizes Delivery API URLs', () => {
    assert.equal(isDeliveryUrl('acme.tt.omtrdc.net', '/rest/v1/delivery'), true);
    assert.equal(isDeliveryUrl('mboxedge37.tt.omtrdc.net', '/rest/v1/delivery'), true);
    assert.equal(isDeliveryUrl('evil-tt.omtrdc.net.example', '/rest/v1/delivery'), false);
    assert.equal(isDeliveryUrl('acme.tt.omtrdc.net', '/m2/acme/mbox/json'), false);
  });
});

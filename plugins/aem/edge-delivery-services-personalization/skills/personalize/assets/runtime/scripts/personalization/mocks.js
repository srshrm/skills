/* eslint-disable no-console */
/*
 * In-browser mocks of the decision API and Adobe Target, used when
 * config.mock is set: demos then work on aem.page, where a local mock server
 * cannot be reached. mockFetch has the signature of window.fetch, so the real
 * transports still run (request building, timeouts, contract validation) and
 * only the network hop is simulated. Tables: config.mock.api (the mock
 * server's decisions.json) and config.mock.target (mock-engine.js).
 *
 * Preview knobs (preview hosts only, like the other pzn- overrides):
 *   ?pzn-mock-latency=3000   delay every answer (ms; default 250)
 *   ?pzn-mock-fail           answer HTTP 500, to show the fallback
 * Requests answered: window.hlx.personalizationMock.requests.
 */

import config from './config.js';
import { overridesEnabled } from './context.js';
import { engineDecide, targetDeliver, isDeliveryUrl } from './mock-engine.js';

const search = new URLSearchParams(window.location.search);
const knobs = overridesEnabled(config.overrides, window.location.hostname)
  ? search
  : new URLSearchParams();
const LATENCY = Number(knobs.get('pzn-mock-latency')) || 250;
const tables = typeof config.mock === 'object' && config.mock ? config.mock : {};

export const requests = [];

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

/**
 * Answers the decision API endpoint and the Target Delivery API.
 * @param {string} url
 * @param {RequestInit} init
 * @returns {Promise<Response>}
 */
export default async function mockFetch(url, init = {}) {
  const { pathname, hostname, href } = new URL(url, window.location.href);
  const body = JSON.parse(init.body || '{}');
  const entry = { url: href, body };
  requests.push(entry);
  await wait(LATENCY);
  if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
  if (knobs.has('pzn-mock-fail')) {
    entry.status = 500;
    return json({ error: 'mock failure (?pzn-mock-fail)' }, 500);
  }
  const apiPath = config.api?.endpoint
    && new URL(config.api.endpoint, window.location.href).pathname;
  let answer;
  if (pathname === apiPath) {
    answer = await engineDecide(tables.api, body);
    console.info('🧠 decision API (mock):', body, '→', answer);
  } else if (isDeliveryUrl(hostname, pathname) || (config.target?.endpoint
    && pathname === new URL(config.target.endpoint, window.location.href).pathname)) {
    answer = await targetDeliver(tables.target, body, { clientCode: config.target?.clientCode });
    console.info(`🎯 target (mock): ${body.notifications ? 'notifications' : 'prefetch'}`, body, '→', answer);
  } else {
    entry.status = 404;
    return json({ error: `no mock for ${href}` }, 404);
  }
  entry.status = 200;
  entry.answer = answer;
  return json(answer);
}

window.hlx = window.hlx || {};
window.hlx.personalizationMock = { requests };

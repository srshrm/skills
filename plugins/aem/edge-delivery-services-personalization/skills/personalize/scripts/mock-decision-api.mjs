#!/usr/bin/env node
/*
 * Mock decision engine implementing the v1 contract
 * (reference/decision-api-contract.md), with latency and failure injection.
 * For local testing only.
 *
 * Usage: node mock-decision-api.mjs [--port 4100] [--decisions decisions.json]
 *          [--target activities.json] [--latency 0] [--fail 500] [--invalid]
 *          [--ttl 300] [--cacheable]
 *
 * Endpoints: POST /decide (contract), POST /rest/v1/delivery (Adobe Target
 * Delivery API: prefetch and notifications, from --target), GET /requests
 * (bodies received, newest last), DELETE /requests, GET /health. CORS is open
 * so aem up can call it.
 *
 * decisions.json:
 * {
 *   "ttl": 300, "cacheable": true,
 *   "placeholders": {
 *     "home-hero": { "geo: IN": "india", "visitor: returning": { "fragment": "/fragments/x" }, "*": null },
 *     "welcome": { "*": "back" }
 *   }
 * }
 * Keys are conditions in the authoring grammar (or "*"), checked in order
 * against the request context; values are a variant name, null (control /
 * default) or a full decision object. A section with no match is omitted,
 * so the site falls back to its own rules.
 *
 * activities.json (Target): mbox -> activity; experiences are checked in
 * order, the first whose audience matches wins (mock-engine.js):
 * { "scroll-offer": { "name": "Scroll offer", "experiences": [
 *     { "name": "Returning", "audience": "visitor: returning", "offer": "/fragments/x/welcome-back" },
 *     { "name": "Everyone", "audience": null, "offer": "/fragments/x/free-trial" } ] } }
 */

import { createServer } from 'node:http';
import { resolve } from 'node:path';
import {
  importAsset, exitOnHelp, isMain, parseArgs, readJson,
} from './lib.mjs';

export const USAGE = `Usage: node mock-decision-api.mjs [--port 4100] [--decisions decisions.json]
         [--target activities.json] [--latency 0] [--fail 500] [--invalid]
         [--ttl 300] [--cacheable]
Local v1 decision-engine mock (reference/decision-api-contract.md) and Adobe
Target Delivery API mock (reference/target.md), with latency and failure
injection. Endpoints: POST /decide, POST /rest/v1/delivery, GET|DELETE /requests,
GET /health.`;


// The table-driven engine and Target mock shared with the in-browser mocks
// (config.mock), so local tests and aem.page demos decide alike.
const { engineDecide, targetDeliver } = await importAsset('runtime', 'scripts', 'personalization', 'mock-engine.js');

export { engineDecide, targetDeliver };

const MAX_BODY_BYTES = 65536;
export const DELIVERY_PATH = '/rest/v1/delivery';

/**
 * @param {object} body
 * @returns {string|null} error message for a non-conforming request
 */
export function checkRequest(body) {
  if (!body || typeof body !== 'object') return 'body must be a JSON object';
  if (body.version !== '1') return 'version must be "1"';
  if (!Array.isArray(body.placeholders)) return 'placeholders must be an array';
  if (body.placeholders.some((entry) => typeof entry?.id !== 'string')) return 'each placeholders entry needs an id';
  if (!body.context || typeof body.context !== 'object') return 'context must be an object';
  return null;
}

/**
 * @param {object} body
 * @returns {string|null} error message for a non-conforming Delivery API request
 */
export function checkDeliveryRequest(body) {
  if (!body || typeof body !== 'object') return 'body must be a JSON object';
  if (!Array.isArray(body.prefetch?.mboxes) && !Array.isArray(body.notifications)) {
    return 'expected prefetch.mboxes or notifications';
  }
  return null;
}

/**
 * @param {object} options
 * @returns {import('node:http').Server}
 */
export function createMockServer({
  decisions = {}, target = {}, latency = 0, fail, invalid = false, ttl, cacheable,
} = {}) {
  const requests = [];
  const file = {
    ...decisions,
    ...(ttl !== undefined ? { ttl } : {}),
    ...(cacheable !== undefined ? { cacheable } : {}),
  };
  const send = (res, status, payload, type = 'application/json') => {
    res.writeHead(status, {
      'content-type': type,
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-allow-methods': 'POST, GET, DELETE, OPTIONS',
    });
    res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  };
  return createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (req.method === 'OPTIONS') { send(res, 204, ''); return; }
    if (pathname === '/health') { send(res, 200, { ok: true }); return; }
    if (pathname === '/requests') {
      if (req.method === 'DELETE') requests.length = 0;
      send(res, 200, requests);
      return;
    }
    if (req.method !== 'POST') { send(res, 405, { error: 'POST only' }); return; }
    let text = '';
    req.on('data', (chunk) => {
      text += chunk;
      if (text.length > MAX_BODY_BYTES) req.destroy();
    });
    req.on('end', async () => {
      let body;
      try {
        body = JSON.parse(text);
      } catch (e) {
        send(res, 400, { error: 'invalid JSON' });
        return;
      }
      requests.push(body);
      if (pathname === DELIVERY_PATH) {
        const problem = checkDeliveryRequest(body);
        if (problem) { send(res, 400, { error: problem }); return; }
        if (latency) await new Promise((done) => { setTimeout(done, latency); });
        if (fail) { send(res, fail, { error: `injected ${fail}` }); return; }
        const client = new URL(req.url, 'http://localhost').searchParams.get('client') || 'mock';
        const result = await targetDeliver(target, body, { clientCode: client });
        const offers = result.prefetch?.mboxes.map((mbox) => `${mbox.name}=${mbox.options?.[0]?.content?.fragment || '-'}`);
        console.log(`✓ target ${body.notifications ? `notifications ${body.notifications.map((n) => n.type)}` : `prefetch ${offers}`}`);
        send(res, 200, result);
        return;
      }
      const problem = checkRequest(body);
      if (problem) {
        console.warn(`⚠️ mock engine: rejected request: ${problem}`);
        send(res, 400, { error: problem });
        return;
      }
      if (latency) await new Promise((done) => { setTimeout(done, latency); });
      if (fail) { send(res, fail, { error: `injected ${fail}` }); return; }
      if (invalid) { send(res, 200, '{"decisions": ', 'application/json'); return; }
      const result = await engineDecide(file, body);
      console.log(`✓ ${body.mode || '?'} ${body.page?.path || '?'} → ${JSON.stringify(result.decisions)}`);
      send(res, 200, result);
    });
  });
}

if (isMain(import.meta.url)) {
  exitOnHelp(USAGE);
  const args = parseArgs(process.argv.slice(2));
  const port = Number(args.port || 4100);
  const decisions = args.decisions ? readJson(resolve(args.decisions)) : {};
  const target = args.target ? readJson(resolve(args.target)) : {};
  [[args.decisions, decisions], [args.target, target]].forEach(([file, data]) => {
    if (file && !data) {
      console.error(`❌ could not read ${file}`);
      process.exit(2);
    }
  });
  const server = createMockServer({
    decisions,
    target,
    latency: Number(args.latency || 0),
    fail: args.fail ? Number(args.fail === true ? 500 : args.fail) : undefined,
    invalid: !!args.invalid,
    ttl: args.ttl !== undefined ? Number(args.ttl) : undefined,
    cacheable: args.cacheable ? true : undefined,
  });
  server.listen(port, () => {
    console.log(`✓ mock decision engine on http://localhost:${port}/decide`);
    console.log(`✓ mock Target Delivery API on http://localhost:${port}${DELIVERY_PATH}`);
    console.log('  set api.endpoint / target.endpoint in scripts/personalization/config.js to these URLs for local tests only');
  });
}

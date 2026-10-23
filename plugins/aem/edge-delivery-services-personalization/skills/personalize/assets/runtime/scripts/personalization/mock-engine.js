/* eslint-disable no-console */
/*
 * Mock decision engine and Adobe Target Delivery API, driven by tables in the
 * authoring grammar. Shared by the in-browser mocks (mocks.js, config.mock)
 * and the skill's local mock server (scripts/mock-decision-api.mjs), so a demo
 * on aem.page and a local test decide alike. Pure ES module.
 *
 * Decision API table (the mock server's decisions.json):
 *   { "ttl": 300, "cacheable": false, "placeholders": {
 *       "plan-offer": {
 *         "param: utm_campaign=enterprise": "enterprise",
 *         "device: mobile": "mobile",
 *         "*": null } } }
 * Conditions are checked in order against the request context; the value is
 * a variant name, null (control: the authored default) or a decision object.
 * A section with no match is left out of the answer.
 *
 * Target table: mbox -> activity; experiences are checked in order, like
 * Target's experience targeting, and the first whose audience matches wins:
 *   { "scroll-offer": { "name": "Scroll offer (XT)", "experiences": [
 *       { "name": "Returning", "audience": "visitor: returning", "offer": "/fragments/..." },
 *       { "name": "Everyone", "audience": null, "offer": "/fragments/..." } ] } }
 * Audiences see the mbox parameters (device, visitor) and the page's URL
 * params, as `device:`, `visitor:` and `param:` conditions.
 */

import { parseCondition, evaluate } from './rules.js';

let counter = 0;
const token = () => {
  counter += 1;
  return `${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
};

async function matches(condition, context, label) {
  if (!condition || condition === '*') return true;
  try {
    return await evaluate(parseCondition(condition), context, {});
  } catch (e) {
    console.warn(`⚠️ mock: bad condition "${condition}" for ${label}: ${e.message}`);
    return false;
  }
}

function toDecision(value) {
  if (value === null) return { variant: null };
  if (typeof value === 'string') return { variant: value };
  return value && typeof value === 'object' ? value : undefined;
}

/**
 * Decides like an engine configured with the given table.
 * @param {object} file decision API table
 * @param {object} body v1 request body
 * @returns {Promise<{decisions: object, ttl: number, cacheable: boolean}>}
 */
export async function engineDecide(file, body) {
  const table = file?.placeholders || {};
  const context = body?.context || {};
  const decisions = {};
  await Promise.all((body?.placeholders || []).map(async ({ id }) => {
    const entries = Object.entries(table[id] || {});
    const outcomes = await Promise.all(
      entries.map(([condition]) => matches(condition, context, id)),
    );
    const index = outcomes.indexOf(true);
    const decision = index === -1 ? undefined : toDecision(entries[index][1]);
    if (decision) decisions[id] = { ...decision, tracking: { engine: 'mock', rule: entries[index][0] } };
  }));
  return { decisions, ttl: file?.ttl ?? 300, cacheable: file?.cacheable ?? false };
}

async function prefetchMbox(activities, mbox, params) {
  const activity = activities?.[mbox.name];
  const empty = { index: mbox.index, name: mbox.name };
  if (!activity) return empty;
  const parameters = mbox.parameters || {};
  const context = {
    params: { ...params, ...parameters }, device: parameters.device, visitor: parameters.visitor,
  };
  const experiences = activity.experiences || [];
  const outcomes = await Promise.all(
    experiences.map((experience) => matches(experience.audience, context, mbox.name)),
  );
  const index = outcomes.indexOf(true);
  if (index === -1) return empty;
  const experience = experiences[index];
  return {
    ...empty,
    options: [{
      type: 'json',
      content: { fragment: experience.offer },
      eventToken: token(),
      responseTokens: {
        'activity.id': String(activity.id ?? Object.keys(activities).indexOf(mbox.name) + 1),
        'activity.name': activity.name || mbox.name,
        'experience.id': String(index),
        'experience.name': experience.name || `Experience ${index + 1}`,
        'offer.name': String(experience.offer).split('/').pop(),
      },
    }],
    metrics: [{ type: 'click', eventToken: token() }],
  };
}

/**
 * Answers a Target Delivery API request: prefetch or notifications.
 * @param {object} activities Target table
 * @param {object} body Delivery API request
 * @param {object} [options]
 * @param {string} [options.clientCode]
 * @returns {Promise<object>} Delivery API response
 */
export async function targetDeliver(activities, body, { clientCode = 'mock' } = {}) {
  const response = {
    status: 200,
    requestId: body?.requestId,
    client: clientCode,
    id: { tntId: body?.id?.tntId || `${token()}.37_0` },
    edgeHost: 'mboxedge37.tt.omtrdc.net',
  };
  if (Array.isArray(body?.notifications)) {
    return { ...response, notifications: body.notifications.map(({ id }) => ({ id })) };
  }
  let params = {};
  try {
    params = Object.fromEntries(new URL(body?.context?.address?.url).searchParams);
  } catch (e) {
    // no page URL: audiences see the mbox parameters only
  }
  const mboxes = await Promise.all((body?.prefetch?.mboxes || [])
    .map((mbox) => prefetchMbox(activities, mbox, params)));
  return { ...response, prefetch: { mboxes } };
}

/**
 * @param {string} hostname
 * @param {string} pathname
 * @returns {boolean} true for a Target Delivery API URL
 */
export function isDeliveryUrl(hostname, pathname) {
  return /(^|\.)tt\.omtrdc\.net$/.test(hostname) && pathname === '/rest/v1/delivery';
}

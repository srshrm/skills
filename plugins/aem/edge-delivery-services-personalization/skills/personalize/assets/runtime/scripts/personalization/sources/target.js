/*
 * `target` source: Adobe Target through the Delivery API
 * (https://<clientCode>.tt.omtrdc.net/rest/v1/delivery).
 *
 * Every target section on the page is one mbox, named by its id, prefetched
 * in one request with the mbox parameters `device` and `visitor`. An offer is
 * JSON: { "fragment": "/fragments/..." }; the runtime shows only listed
 * variants when the section lists any. Prefetch never counts as a visit to
 * the offer: notify() sends the `display` notification when the visitor
 * actually sees it and `click` when they follow one of its links.
 *
 * The session id lives in sessionStorage; the Target visitor id (tntId) is
 * kept in localStorage only with consent. Later requests go to the edge host
 * Target answered from, so the session stays on one edge cluster.
 *
 * Sites that already load the Web SDK (alloy) can swap this transport for
 * sources/target-websdk.js in config.providers.
 */

import { TNT_ID_STORAGE_KEY } from '../context.js';

export const TNT_ID_KEY = TNT_ID_STORAGE_KEY;
export const SESSION_KEY = 'pzn-tnt-session';
export const EDGE_HOST_KEY = 'pzn-tnt-edge';

const uuid = () => (window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);

/**
 * @param {object} target config.target
 * @param {string} sessionId
 * @param {string} [edgeHost] host Target answered from earlier in the session
 * @param {string} [base] page URL, for a relative config.target.endpoint
 * @returns {string}
 */
export function deliveryUrl(target, sessionId, edgeHost, base = 'https://target.invalid/') {
  const host = edgeHost || `${target.clientCode}.tt.omtrdc.net`;
  const url = new URL(target.endpoint || `https://${host}/rest/v1/delivery`, base);
  url.searchParams.set('client', target.clientCode || '');
  url.searchParams.set('sessionId', sessionId);
  return url.href;
}

/**
 * The Delivery API context of this page view.
 * @param {object} page { url, referrer, screen, viewport }
 * @returns {object}
 */
export function requestContext({
  url, referrer, screen, viewport,
}) {
  return {
    channel: 'web',
    address: { url, referringUrl: referrer || undefined },
    screen,
    window: viewport,
  };
}

/**
 * Prefetch request for a batch of sections.
 * @param {string[]} mboxes mbox names (section ids), in order
 * @param {object} context visitor context ({ device, visitor })
 * @param {object} request { requestId, tntId, propertyToken, page }
 * @returns {object}
 */
export function prefetchRequest(mboxes, context, {
  requestId, tntId, propertyToken, page,
}) {
  const { device, visitor } = context;
  const parameters = Object.fromEntries(
    Object.entries({ device, visitor }).filter(([, value]) => value),
  );
  return JSON.parse(JSON.stringify({
    requestId,
    id: tntId ? { tntId } : undefined,
    property: propertyToken ? { token: propertyToken } : undefined,
    context: requestContext(page),
    prefetch: { mboxes: mboxes.map((name, index) => ({ index, name, parameters })) },
  }));
}

/**
 * Turns a prefetched mbox into a decision.
 * @param {object|undefined} mbox prefetch.mboxes entry
 * @returns {object} { fragment, tracking, data } for an offer, { variant: null }
 *   when no experience qualifies, { error } for an offer that is not JSON
 */
export function toDecision(mbox) {
  const option = mbox?.options?.[0];
  if (!option) return { variant: null, tracking: {} };
  const tracking = option.responseTokens || {};
  if (option.type !== 'json' || typeof option.content?.fragment !== 'string') {
    return { error: `offer is not JSON { "fragment": ... } (${option.type})`, tracking };
  }
  return {
    fragment: option.content.fragment,
    tracking,
    data: {
      display: option.eventToken ? [option.eventToken] : [],
      click: (mbox.metrics || []).filter((metric) => metric.type === 'click' && metric.eventToken)
        .map((metric) => metric.eventToken),
    },
  };
}

/**
 * Notification request for a displayed or clicked offer.
 * @param {'display'|'click'} type
 * @param {string} mbox
 * @param {string[]} tokens event tokens
 * @param {object} request { requestId, id, tntId, propertyToken, page, timestamp }
 * @returns {object}
 */
export function notificationRequest(type, mbox, tokens, {
  requestId, id, tntId, propertyToken, page, timestamp,
}) {
  return JSON.parse(JSON.stringify({
    requestId,
    id: tntId ? { tntId } : undefined,
    property: propertyToken ? { token: propertyToken } : undefined,
    context: requestContext(page),
    notifications: [{
      id, type, timestamp, mbox: { name: mbox }, tokens,
    }],
  }));
}

function session(key, value) {
  try {
    if (value) window.sessionStorage.setItem(key, value);
    return window.sessionStorage.getItem(key);
  } catch (e) {
    return value || null;
  }
}

function currentSession() {
  return session(SESSION_KEY) || session(SESSION_KEY, uuid());
}

function storedTntId(consent, value) {
  if (!consent) return null;
  try {
    if (value) window.localStorage.setItem(TNT_ID_KEY, value);
    return window.localStorage.getItem(TNT_ID_KEY);
  } catch (e) {
    return value || null;
  }
}

function currentPage() {
  return {
    url: window.location.href,
    referrer: document.referrer,
    screen: { width: window.screen.width, height: window.screen.height },
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
}

async function send(target, body, { fetch, timeout }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout || target.timeout || 3000);
  try {
    const edgeHost = target.endpoint ? null : session(EDGE_HOST_KEY);
    const url = deliveryUrl(target, currentSession(), edgeHost, window.location.href);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      // A click notification must outlive the navigation it reports.
      keepalive: !!body.notifications,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    throw error.name === 'AbortError' ? new Error(`timed out after ${timeout || target.timeout || 3000}ms`) : error;
  } finally {
    clearTimeout(timer);
  }
}

export default {
  requiresConsent: true,

  /**
   * @param {object[]} entries { id, spec, section }
   * @param {object} context visitor context, with consent
   * @param {object} options { config, fetch, timeout }
   * @returns {Promise<{decisions?: object, error?: string}>}
   */
  async decide(entries, context, { config, fetch, timeout }) {
    const target = config.target || {};
    if (!target.clientCode) return { error: 'no clientCode (config.target)' };
    const json = await send(target, prefetchRequest(entries.map((entry) => entry.id), context, {
      requestId: uuid(),
      tntId: storedTntId(context.consent),
      propertyToken: target.propertyToken,
      page: currentPage(),
    }), { fetch, timeout });
    storedTntId(context.consent, json.id?.tntId);
    if (json.edgeHost && !target.endpoint) session(EDGE_HOST_KEY, json.edgeHost);
    const mboxes = json.prefetch?.mboxes || [];
    return {
      decisions: Object.fromEntries(entries.map((entry, index) => [
        entry.id, toDecision(mboxes.find((mbox) => mbox.index === index)),
      ])),
    };
  },

  /**
   * Tells Target the visitor saw or clicked an offer.
   * @param {{type: 'display'|'click', id: string, decision: object}} event
   * @param {object} options { config, fetch, consent }
   * @returns {Promise<void>}
   */
  async notify({ type, id, decision }, { config, fetch, consent }) {
    const tokens = decision.data?.[type];
    if (!tokens?.length) return;
    const target = config.target || {};
    await send(target, notificationRequest(type, id, tokens, {
      requestId: uuid(),
      id: uuid(),
      tntId: storedTntId(consent),
      propertyToken: target.propertyToken,
      page: currentPage(),
      timestamp: Date.now(),
    }), { fetch });
  },
};

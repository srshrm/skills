/*
 * `split` source: an A/B test. Each visitor gets a random variant (or the
 * authored default) by the "Personalization Split" weights, or an even split,
 * sticky for the browser session: sessionStorage pzn-split:<id>, mirrored in
 * the pzn-split session cookie the edge worker reads and writes. No consent
 * needed: nothing persists beyond the session. Bots are never assigned.
 */

import { parseCookies } from '../context.js';
import { splitWeights, pickWeighted, slug } from '../section-spec.js';

export const STORAGE_PREFIX = 'pzn-split:';
export const COOKIE = 'pzn-split';

/**
 * Reads the assignments of a pzn-split cookie value: `id:variant,id:variant`.
 * @param {string} value
 * @returns {object} id -> variant
 */
export function parseAssignments(value) {
  return Object.fromEntries(String(value || '').split(',')
    .map((pair) => pair.split(':').map((part) => part.trim()))
    .filter(([id, variant]) => id && variant));
}

/**
 * @param {object} assignments id -> variant
 * @returns {string} cookie value
 */
export function formatAssignments(assignments) {
  return Object.entries(assignments).map(([id, variant]) => `${id}:${variant}`).join(',');
}

/**
 * The variant a visitor gets: a still-listed earlier assignment, else a
 * weighted pick.
 * @param {object} spec section spec
 * @param {string|undefined} stored earlier assignment
 * @param {() => number} [random]
 * @returns {string} variant name or 'default'
 */
export function assign(spec, stored, random = Math.random) {
  const names = ['default', ...spec.variants.map((variant) => variant.name)];
  const kept = stored && names.find((name) => slug(name) === slug(stored));
  if (kept) return kept;
  return names[pickWeighted(splitWeights(spec.variants.length, spec.split), random())];
}

function remember(id, variant) {
  try {
    window.sessionStorage.setItem(STORAGE_PREFIX + id, variant);
  } catch (e) {
    // storage blocked: the cookie still keeps the assignment
  }
  const assignments = { ...parseAssignments(parseCookies(document.cookie)[COOKIE]), [id]: variant };
  document.cookie = `${COOKIE}=${encodeURIComponent(formatAssignments(assignments))}; path=/; SameSite=Lax; Secure`;
}

function storedAssignment(id) {
  try {
    const value = window.sessionStorage.getItem(STORAGE_PREFIX + id);
    if (value) return value;
  } catch (e) {
    // storage blocked: fall back to the cookie
  }
  return parseAssignments(parseCookies(document.cookie)[COOKIE])[id];
}

export default {
  /**
   * @param {object[]} entries { id, spec, section }
   * @returns {Promise<{decisions: object}>}
   */
  async decide(entries) {
    const decisions = {};
    entries.forEach(({ spec }) => {
      const variant = assign(spec, storedAssignment(spec.id));
      remember(spec.id, variant);
      decisions[spec.id] = { variant, tracking: { split: spec.split || 'even' } };
    });
    return { decisions };
  },
};

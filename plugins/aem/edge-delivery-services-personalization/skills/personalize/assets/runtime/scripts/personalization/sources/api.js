/*
 * `api` source: any decision engine behind the v1 contract
 * (reference/decision-api-contract.md in the skill). One batched request per
 * page; config.api.mapRequest / mapResponse adapt engines that speak another
 * shape. Candidates are the section's variants plus `default`; the runtime
 * accepts only listed variants.
 */

import { buildRequest } from '../contract.js';
import { fetchDecisions } from '../provider-api.js';

/**
 * Contract specs for a batch of sections. Every variant is a candidate; rule
 * clauses (the fallback) decide which URL params the engine may see.
 * @param {object[]} specs section specs
 * @returns {object[]}
 */
export function contractSpecs(specs) {
  return specs.map((spec) => ({
    id: spec.id,
    rules: [
      ...spec.rules,
      ...spec.variants
        .filter((variant) => !spec.rules.some((rule) => rule.variant === variant.name))
        .map((variant) => ({ variant: variant.name, clauses: [] })),
    ],
  }));
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
    const api = config.api || {};
    if (!api.endpoint) return { error: 'no endpoint (config.api.endpoint)' };
    const body = buildRequest({
      path: window.location.pathname,
      locale: document.documentElement.lang,
      specs: contractSpecs(entries.map((entry) => entry.spec)),
      context,
      consent: context.consent,
      mode: 'client',
    });
    const result = await fetchDecisions({
      endpoint: api.endpoint,
      body,
      timeout,
      mapRequest: api.mapRequest,
      mapResponse: api.mapResponse,
      storage: context.consent ? window.sessionStorage : undefined,
      fetchImpl: fetch,
    });
    return result.error ? { error: result.error } : { decisions: result.decisions };
  },
};

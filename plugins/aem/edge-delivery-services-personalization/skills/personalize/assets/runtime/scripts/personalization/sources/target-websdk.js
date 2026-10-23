/*
 * `target` source over the Web SDK (alloy), for sites that already load it
 * (directly or through Launch). Swap it in for the Delivery API transport:
 *
 *   providers: { target: () => import('./sources/target-websdk.js') },
 *
 * Each target section's id is a decision scope; a JSON offer
 * { "fragment": "/fragments/..." } in the scope's proposition is the variant.
 * Display and click are reported as decisioning.propositionDisplay /
 * propositionInteract events. alloy owns the visitor id and its own consent
 * (setConsent); this runtime still waits for config.hasConsent.
 *
 * Unverified against a live Edge Network datastream: the request and
 * proposition shapes follow the Web SDK documentation and are unit-tested
 * with a stub. Check one page with the Adobe Experience Platform Debugger
 * before relying on it.
 */

const JSON_ITEM = 'https://ns.adobe.com/personalization/json-content-item';

/**
 * Decisions from a sendEvent result's propositions.
 * @param {object[]} propositions
 * @param {string[]} scopes section ids
 * @returns {object} id -> decision
 */
export function toDecisions(propositions, scopes) {
  return Object.fromEntries(scopes.map((scope) => {
    const proposition = (propositions || []).find((candidate) => candidate.scope === scope);
    const item = proposition?.items?.find((candidate) => candidate.schema === JSON_ITEM);
    const fragment = item?.data?.content?.fragment;
    if (!proposition || !item) return [scope, { variant: null, tracking: {} }];
    if (typeof fragment !== 'string') return [scope, { error: 'offer is not JSON { "fragment": ... }' }];
    return [scope, {
      fragment,
      tracking: proposition.scopeDetails?.characteristics || {},
      data: { proposition: { id: proposition.id, scope, scopeDetails: proposition.scopeDetails } },
    }];
  }));
}

/**
 * The XDM event reporting a display or click of a proposition.
 * @param {'display'|'click'} type
 * @param {object} proposition { id, scope, scopeDetails }
 * @returns {object}
 */
export function propositionEvent(type, proposition) {
  return {
    xdm: {
      eventType: type === 'click' ? 'decisioning.propositionInteract' : 'decisioning.propositionDisplay',
      _experience: {
        decisioning: {
          propositions: [proposition],
          propositionEventType: type === 'click' ? { interact: 1 } : { display: 1 },
        },
      },
    },
  };
}

export default {
  requiresConsent: true,

  async decide(entries) {
    if (typeof window.alloy !== 'function') return { error: 'window.alloy is not loaded' };
    const scopes = entries.map((entry) => entry.id);
    const result = await window.alloy('sendEvent', {
      renderDecisions: false,
      personalization: { decisionScopes: scopes },
    });
    return { decisions: toDecisions(result?.propositions, scopes) };
  },

  async notify({ type, decision }) {
    const proposition = decision.data?.proposition;
    if (proposition && typeof window.alloy === 'function') {
      await window.alloy('sendEvent', propositionEvent(type, proposition));
    }
  },
};

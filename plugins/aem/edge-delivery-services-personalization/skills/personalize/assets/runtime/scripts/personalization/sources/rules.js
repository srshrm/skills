/*
 * `rules` source: the section's own "Personalization Rule <Variant>" rows,
 * evaluated in authoring order; the first match wins, no match keeps the
 * authored content. The edge worker decides the same rules with the same
 * section-spec.js.
 */

import { decideSection } from '../section-spec.js';

export default {
  /**
   * @param {object[]} entries { id, spec, section }
   * @param {object} context visitor context
   * @param {object} options { config, audiences }
   * @returns {Promise<{decisions: object}>}
   */
  async decide(entries, context, { config, audiences }) {
    const decisions = {};
    await Promise.all(entries.map(async ({ spec }) => {
      decisions[spec.id] = await decideSection(spec, context, {
        audiences, prefixes: config.fragmentPrefixes,
      });
    }));
    return { decisions };
  },
};

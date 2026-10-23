/*
 * Section personalization grammar.
 *
 * Authors personalize a section with Section Metadata rows; the pipeline turns
 * them into data-personalization* attributes on the section, in authoring
 * order. This module reads those attributes into a spec and decides rule and
 * forced variants. Shared, unchanged, by the browser runtime, the edge worker
 * and the skill's scripts. Pure ES module: no DOM, no network, no storage.
 *
 * | Section Metadata              |                                           |
 * | Personalization               | plan-offer   (id; for target, the mbox)   |
 * | Personalization Source        | rules | api | split | target              |
 * | Personalization Variants      | links to /fragments/personalization/...  |
 * | Personalization Rule <Variant>| geo: IN & device: mobile  (first match)   |
 * | Personalization Split         | 40, 30   (split: % per variant)           |
 * | Personalization Trigger       | scroll: 70% | view | load  (target popup) |
 * | Personalization Display       | popup | inline  (target)                  |
 */

import {
  parseCondition, evaluate, toFragmentPath, variantName, DEFAULT_FRAGMENT_PREFIXES,
} from './rules.js';

export const ATTRIBUTE = 'data-personalization';
export const SOURCES = ['rules', 'api', 'split', 'target'];
// inline replaces the section's content (the section stays hidden until
// decided); popup, target only, shows the offer over the authored content.
export const DISPLAYS = ['inline', 'popup'];
export const DEFAULT_TRIGGER = { type: 'scroll', ratio: 0.7 };
// aem-experimentation section metadata (Experiment, Campaign, Audience: <name>).
export const EXPERIMENTATION_ATTRIBUTE = /^data-(experiment|campaign|audience)\b/;

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;
const KNOWN_KEYS = ['', 'source', 'variants', 'split', 'trigger', 'display'];

/**
 * Comparable form of a variant name or rule key: lowercase, every run of
 * other characters a single dash. The pipeline keeps `_` in keys while older
 * aem.js turns it into `-`, so both compare equal.
 * @param {string} value
 * @returns {string}
 */
export function slug(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * @param {string} value `scroll: 70%`, `view` or `load`
 * @returns {{type: string, ratio?: number}|null} null when not a trigger
 */
export function parseTrigger(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'view' || text === 'load') return { type: text };
  const match = /^scroll\s*:?\s*(\d{1,3}(?:\.\d+)?)\s*%?$/.exec(text);
  if (!match || Number(match[1]) > 100) return null;
  return { type: 'scroll', ratio: Number(match[1]) / 100 };
}

/**
 * @param {string} value `40, 30`
 * @returns {number[]|null} percentages, or null when one is not a number
 */
export function parseSplit(value) {
  const parts = String(value ?? '').split(',').map((part) => part.trim().replace(/%$/, '')).filter(Boolean);
  const numbers = parts.map(Number);
  return numbers.every((number) => Number.isFinite(number) && number >= 0) ? numbers : null;
}

/**
 * Traffic weights of a split, default first: the authored percentages per
 * variant, the rest to the default; an even split when none are authored.
 * @param {number} variants number of variants
 * @param {number[]|null} split authored percentages
 * @returns {number[]} weights for [default, ...variants]
 */
export function splitWeights(variants, split) {
  if (!split || !split.length) return Array(variants + 1).fill(1);
  const own = Array.from({ length: variants }, (_, index) => split[index] || 0);
  return [Math.max(0, 100 - own.reduce((sum, weight) => sum + weight, 0)), ...own];
}

/**
 * Picks an index in proportion to its weight.
 * @param {number[]} weights
 * @param {number} random a number in [0, 1)
 * @returns {number}
 */
export function pickWeighted(weights, random) {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!total) return 0;
  let left = random * total;
  const index = weights.findIndex((weight) => {
    left -= weight;
    return left < 0;
  });
  return index === -1 ? weights.length - 1 : index;
}

/**
 * The variant a rule key names: an exact match, else the key without a
 * trailing number (`india-2` -> `india`), so a variant can have several rules.
 * @param {string} suffix key after data-personalization-rule-
 * @param {{name: string}[]} variants
 * @returns {object|undefined}
 */
export function ruleVariant(suffix, variants) {
  const key = slug(suffix);
  return variants.find((variant) => slug(variant.name) === key)
    || variants.find((variant) => slug(variant.name) === key.replace(/-\d+$/, ''));
}

/**
 * Reads a section's attributes into a spec.
 * @param {[string, string][]|object} attributes name -> value, in document order
 * @param {object} [options]
 * @param {string[]} [options.prefixes] allowed fragment prefixes
 * @param {string[]} [options.sources] extra source names registered by the site
 * @returns {{id: string, source: string, variants: {name: string, path: string}[],
 *   rules: {variant: string, condition: string, clauses: object[], key: string}[],
 *   split: number[]|null, trigger: object|null, display: string|null, held: boolean,
 *   errors: string[], warnings: string[]}}
 */
export function parseSection(attributes, {
  prefixes = DEFAULT_FRAGMENT_PREFIXES, sources = [],
} = {}) {
  const entries = Array.isArray(attributes) ? attributes : Object.entries(attributes || {});
  const spec = {
    id: '', source: 'rules', variants: [], rules: [], split: null, trigger: null, display: null, held: true, errors: [], warnings: [],
  };
  const raw = {};
  const ruleRows = [];
  entries.forEach(([name, value]) => {
    const attribute = String(name).toLowerCase();
    if (EXPERIMENTATION_ATTRIBUTE.test(attribute)) {
      spec.errors.push(`also carries aem-experimentation metadata (${attribute.slice(5)}); personalize or experiment on a section, not both`);
      return;
    }
    if (attribute !== ATTRIBUTE && !attribute.startsWith(`${ATTRIBUTE}-`)) return;
    const key = attribute.slice(ATTRIBUTE.length + 1);
    if (key === 'rule' || key.startsWith('rule-')) ruleRows.push([key.slice(5), String(value ?? '')]);
    else if (KNOWN_KEYS.includes(key)) raw[key] = String(value ?? '').trim();
    else spec.warnings.push(`unknown row "Personalization ${key.replace(/-/g, ' ')}" is ignored`);
  });

  spec.id = raw[''] || '';
  if (!ID_PATTERN.test(spec.id)) spec.errors.push(`id "${spec.id}" must be letters, digits, - or _ (row "Personalization")`);
  const known = [...SOURCES, ...sources];
  const source = (raw.source || 'rules').toLowerCase();
  if (known.includes(source)) spec.source = source;
  else spec.errors.push(`source must be one of ${known.join(', ')}, got "${raw.source}"`);

  const items = String(raw.variants || '').split(',').map((item) => item.trim());
  items.filter(Boolean).forEach((item) => {
    const path = toFragmentPath(item, prefixes);
    if (!path) {
      spec.errors.push(`"Personalization Variants" holds only fragment links under ${prefixes.join(' or ')}; "${item}" is not one (write conditions in "Personalization Rule <Variant>" rows)`);
      return;
    }
    const name = variantName(path);
    if (slug(name) === 'default') {
      spec.errors.push(`variant ${path} cannot be named "default": the authored content is the default`);
      return;
    }
    const clash = spec.variants.find((variant) => slug(variant.name) === slug(name));
    if (clash) {
      if (clash.path !== path) spec.errors.push(`variants ${clash.path} and ${path} share the name "${name}"; rename one fragment`);
      return;
    }
    spec.variants.push({ name, path });
  });

  ruleRows.forEach(([suffix, condition]) => {
    const label = suffix ? `"Personalization Rule ${suffix.replace(/-/g, ' ')}"` : '"Personalization Rule"';
    const variant = suffix ? ruleVariant(suffix, spec.variants) : undefined;
    if (!variant) {
      spec.errors.push(`${label} names no variant in "Personalization Variants"${suffix ? '' : ' (add the variant name after "Rule")'}`);
      return;
    }
    try {
      spec.rules.push({
        variant: variant.name,
        condition: condition.trim(),
        clauses: parseCondition(condition),
        key: suffix,
      });
    } catch (e) {
      spec.errors.push(`${label}: ${e.message}`);
    }
  });

  if (raw.split !== undefined) {
    spec.split = parseSplit(raw.split);
    if (!spec.split) spec.errors.push(`"Personalization Split" must be percentages such as "40, 30", got "${raw.split}"`);
  }
  if (raw.trigger !== undefined) {
    spec.trigger = parseTrigger(raw.trigger);
    if (!spec.trigger) spec.errors.push(`"Personalization Trigger" must be "scroll: <n>%", "view" or "load", got "${raw.trigger}"`);
  }
  if (raw.display !== undefined) {
    spec.display = raw.display.toLowerCase();
    if (!DISPLAYS.includes(spec.display)) spec.errors.push(`"Personalization Display" must be ${DISPLAYS.join(' or ')}, got "${raw.display}"`);
  }

  const ignored = (row, why) => spec.warnings.push(`"Personalization ${row}" is ignored ${why}`);
  if (spec.source === 'target') {
    // A trigger means a popup; without one the offer replaces the section.
    spec.display = spec.display || (raw.trigger !== undefined ? 'popup' : 'inline');
    if (spec.display === 'popup') spec.trigger = spec.trigger || DEFAULT_TRIGGER;
    else {
      if (raw.trigger !== undefined) ignored('Trigger', 'with "Display | inline"');
      spec.trigger = null;
    }
    spec.held = spec.display === 'inline';
  } else {
    if (raw.trigger !== undefined) ignored('Trigger', 'outside target sections');
    if (raw.display !== undefined) ignored('Display', 'outside target sections');
    spec.display = 'inline';
    spec.trigger = null;
    if (!spec.variants.length && !spec.errors.some((error) => error.includes('Variants'))) {
      spec.errors.push(`a ${spec.source} section needs "Personalization Variants" links under ${prefixes.join(' or ')}`);
    }
  }
  if (spec.source !== 'split' && raw.split !== undefined) ignored('Split', 'outside split sections');
  if (spec.source === 'split' && spec.split) {
    const total = spec.split.reduce((sum, weight) => sum + weight, 0);
    if (spec.split.length > spec.variants.length) spec.errors.push(`"Personalization Split" has ${spec.split.length} values for ${spec.variants.length} variant(s)`);
    if (total > 100) spec.errors.push(`"Personalization Split" adds up to ${total}%; at most 100 (the default gets the rest)`);
  }
  if (['split', 'target'].includes(spec.source) && spec.rules.length) {
    ignored('Rule rows', `in a ${spec.source} section`);
    spec.rules = [];
  }
  if (spec.source === 'rules' && !ruleRows.length && spec.variants.length) {
    spec.errors.push('a rules section needs at least one "Personalization Rule <Variant>" row');
  }
  if (spec.source === 'rules') {
    spec.variants.filter((variant) => !spec.rules.some((rule) => rule.variant === variant.name))
      .forEach((variant) => spec.warnings.push(`variant "${variant.name}" has no rule: only ?pzn= previews show it`));
  }
  return spec;
}

/**
 * The listed variant a decision names, by name or by fragment path. A target
 * section without variants accepts any allowed fragment.
 * @param {object} spec
 * @param {{variant?: string|null, fragment?: string}} decision
 * @param {string[]} [prefixes]
 * @returns {{name: string, path?: string}|null|undefined} the variant;
 *   { name: 'default' } for a control decision; undefined when not allowed
 */
export function listedVariant(spec, decision, prefixes = DEFAULT_FRAGMENT_PREFIXES) {
  if (!decision || typeof decision !== 'object') return undefined;
  if (decision.variant === null || slug(decision.variant) === 'default') return { name: 'default' };
  if (typeof decision.variant === 'string' && decision.variant) {
    const named = spec.variants.find((variant) => slug(variant.name) === slug(decision.variant));
    if (named) return named;
  }
  const path = typeof decision.fragment === 'string' ? toFragmentPath(decision.fragment, prefixes) : null;
  if (!path) return undefined;
  const listed = spec.variants.find((variant) => variant.path === path);
  if (listed) return listed;
  return !spec.variants.length && spec.source === 'target' ? { name: variantName(path), path } : undefined;
}

/**
 * Decides a section from a forced variant, an engine decision or its rules.
 * Order: forced -> engine (listed variants only) -> rules, first match -> default.
 * @param {object} spec from parseSection
 * @param {object} context { geo, device, visitor, params, state }
 * @param {object} [options]
 * @param {object} [options.audiences] name -> boolean | (context) => boolean
 * @param {object} [options.apiDecision] the engine's entry for this section
 * @param {string} [options.forcedVariant] preview override
 * @param {string[]} [options.deferCriteria] criteria the caller cannot evaluate
 * @param {string[]} [options.prefixes]
 * @returns {Promise<{variant: string, path?: string, source: string, rule?: string,
 *   tracking?: object}|{deferred: true}>}
 */
export async function decideSection(spec, context = {}, options = {}) {
  const {
    audiences = {}, apiDecision, forcedVariant, deferCriteria = [],
    prefixes = DEFAULT_FRAGMENT_PREFIXES,
  } = options;
  const pick = (variant, source, extra = {}) => (variant && variant.path
    ? {
      variant: variant.name, path: variant.path, source, ...extra,
    }
    : { variant: 'default', source, ...extra });
  if (forcedVariant) {
    const forced = listedVariant(spec, { variant: forcedVariant }, prefixes);
    if (forced) return pick(forced, 'override');
  }
  if (apiDecision) {
    const chosen = listedVariant(spec, apiDecision, prefixes);
    const tracking = apiDecision.tracking && typeof apiDecision.tracking === 'object' ? apiDecision.tracking : undefined;
    if (chosen) return pick(chosen, 'api', tracking ? { tracking } : {});
  }
  const outcomes = await Promise.all(spec.rules.map((rule) => {
    if (rule.clauses.some((clause) => deferCriteria.includes(clause.criterion))) return 'deferred';
    return evaluate(rule.clauses, context, audiences);
  }));
  const index = outcomes.findIndex((outcome) => outcome === true || outcome === 'deferred');
  if (index === -1) return pick(null, 'default');
  if (outcomes[index] === 'deferred') return { deferred: true };
  const rule = spec.rules[index];
  return pick(spec.variants.find((variant) => variant.name === rule.variant), 'rule', { rule: rule.condition });
}

/**
 * Criteria referenced by a section's rules.
 * @param {object} spec
 * @returns {Set<string>}
 */
export function sectionCriteria(spec) {
  const rules = spec.rules || [];
  return new Set(rules.flatMap((rule) => rule.clauses.map((clause) => clause.criterion)));
}

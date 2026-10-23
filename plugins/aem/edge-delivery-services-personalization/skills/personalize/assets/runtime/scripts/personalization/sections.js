/* eslint-disable no-console */
/*
 * Section personalization runtime.
 *
 * Authors personalize a whole section with Section Metadata (grammar:
 * section-spec.js). The section's authored content is the default: it stays
 * where authors wrote it, and it is what bots, failures, timeouts and
 * visitors without a matching variant see.
 *
 * Lifecycle:
 * 1. personalizeSections(main), from loadEager right after decorateMain,
 *    marks every section it must decide data-section-status="pzn-pending", so
 *    aem.js loadSection skips it and it stays hidden, and asks each source
 *    once for all of its sections. The sections after the first held one
 *    wait too ("pzn-waiting"): sections appear in page order, as aem.js
 *    loadSections shows them, so nothing shifts when a held section appears.
 * 2. A decided section gets the variant fragment's content (host classes and
 *    data attributes stay) or keeps its own, then loads like any section, in
 *    page order. Within its budget (config.budgets), whatever happens.
 * 3. personalizeSectionsLazy(main), from loadLazy after loadSections, arms
 *    target popups: the offer opens over the page when its trigger fires.
 * 4. setState() and refresh() (window.hlx.personalization) re-decide the
 *    sections that depend on them.
 *
 * Sources are providers: { decide(entries, context, options), notify?(event,
 * options), requiresConsent? }. rules, api, split and target are built in;
 * config.providers adds or replaces them.
 */

import { loadSection, loadCSS } from '../aem.js';
import config from './config.js';
import {
  parseSection, listedVariant, decideSection, sectionCriteria,
} from './section-spec.js';
import { stateKeysUsed } from './rules.js';
import {
  overrides, previewHost, debug, hasConsent, isCrawler, getContext, getAudiences, track, log,
  register,
} from './visitor.js';
import { onTrigger, openPopup } from './popup.js';

export const PENDING = 'pzn-pending';
// Decided, waiting for the sections above it to show.
export const READY = 'pzn-ready';
// Not personalized, below a held section.
export const WAITING = 'pzn-waiting';
const SELECTOR = ':scope > .section[data-personalization]';

const BUILT_IN = {
  rules: () => import('./sources/rules.js'),
  api: () => import('./sources/api.js'),
  split: () => import('./sources/split.js'),
  target: () => import('./sources/target.js'),
};
const registry = { ...BUILT_IN, ...(config.providers || {}) };
const budgets = { eager: 800, lazy: 2000, ...(config.budgets || {}) };
const prefixes = config.fragmentPrefixes;
const entries = [];
let order = [];
let releasing = Promise.resolve();
const loaded = {};
let transport;

function provider(source) {
  loaded[source] = loaded[source] || registry[source]().then((module) => module.default || module);
  return loaded[source];
}

// config.mock answers the decision API and Target in the browser (mocks.js).
function fetcher() {
  transport = transport || (config.mock
    ? import('./mocks.js').then((module) => module.default)
    : Promise.resolve((...args) => window.fetch(...args)));
  return transport;
}

function readEntry(section, first, seen) {
  const attributes = section.getAttributeNames().map((name) => [name, section.getAttribute(name)]);
  const spec = parseSection(attributes, { prefixes, sources: Object.keys(registry) });
  if (spec.id && seen.has(spec.id)) spec.errors.push(`id "${spec.id}" is used by another section on this page`);
  seen.add(spec.id);
  return {
    id: spec.id,
    spec,
    section,
    eager: section === first,
    edge: section.dataset.pznSource === 'edge',
    generation: 0,
    decision: null,
    authored: null,
    row: null,
  };
}

const live = (entry) => !entry.spec.errors.length && !entry.edge;
const choice = (variant, source, extra = {}) => (variant?.path
  ? {
    variant: variant.name, path: variant.path, source, ...extra,
  }
  : { variant: 'default', source, ...extra });

/**
 * One request per source for a batch of its sections.
 * @returns {Promise<{decisions?: object, error?: string}>}
 */
async function ask(source, batch, timeout) {
  try {
    const module = await provider(source);
    const options = config[source] || {};
    if (module.requiresConsent && !hasConsent() && !options.sendWithoutConsent) {
      return { error: 'no consent' };
    }
    const context = await getContext({ needGeo: batch.some((entry) => sectionCriteria(entry.spec).has('geo')) });
    return await module.decide(batch, context, {
      config,
      audiences: getAudiences(),
      fetch: await fetcher(),
      timeout: options.timeout || timeout,
    });
  } catch (error) {
    return { error: error.message };
  }
}

// An api section's rule rows decide when the engine cannot.
async function fallback(entry, reason) {
  if (entry.spec.rules.length && entry.spec.source !== 'rules') {
    const context = await getContext({ needGeo: sectionCriteria(entry.spec).has('geo') });
    const decision = await decideSection(entry.spec, context, {
      audiences: getAudiences(), prefixes,
    });
    if (decision.source === 'rule') return { ...decision, reason };
  }
  return { variant: 'default', source: 'fallback', reason };
}

async function decide(entry, pending, bot) {
  const { spec } = entry;
  const forced = overrides.forced[spec.id];
  if (forced) {
    const variant = listedVariant(spec, { variant: forced }, prefixes);
    if (variant) return choice(variant, 'override');
    console.warn(`⚠️ personalization: ?pzn= variant "${forced}" is not listed in section "${spec.id}"`);
  }
  if (bot) return choice(null, 'bot');
  const result = await pending;
  const answer = result.decisions?.[spec.id];
  if (result.error || answer?.error) return fallback(entry, result.error || answer.error);
  if (!answer) return fallback(entry, 'no decision');
  const variant = listedVariant(spec, answer, prefixes);
  if (!variant) return { variant: 'default', source: 'fallback', reason: `not listed: ${answer.variant || answer.fragment}` };
  return choice(variant, answer.source || spec.source, {
    tracking: answer.tracking, data: answer.data, rule: answer.rule,
  });
}

/**
 * The content of a variant fragment, flattened from its sections.
 * @param {string} path
 * @returns {Promise<Node[]|null>}
 */
async function fragmentNodes(path) {
  try {
    // fragment.js imports scripts.js, which loads this module dynamically.
    // eslint-disable-next-line import/no-cycle
    const { loadFragment } = await import('../../blocks/fragment/fragment.js');
    const fragment = await loadFragment(path);
    if (!fragment) return null;
    const sections = [...fragment.querySelectorAll(':scope > .section')];
    const nodes = sections.length
      ? sections.flatMap((section) => [...section.childNodes])
      : [...fragment.childNodes];
    return nodes.some((node) => node.nodeType === Node.ELEMENT_NODE) ? nodes : null;
  } catch (e) {
    return null;
  }
}

async function decideAndLoad(entry, pending, bot) {
  const decision = await decide(entry, pending, bot);
  if (!decision.path) return decision;
  const nodes = await fragmentNodes(decision.path);
  if (nodes) return { ...decision, nodes };
  console.warn(`⚠️ personalization: fragment ${decision.path} failed; section "${entry.id}" shows its authored content`);
  return { variant: 'default', source: 'fallback', reason: `fragment failed: ${decision.path}` };
}

// display and click notifications for providers that want them (target).
function notify(entry, decision, type) {
  const row = entry.row || {};
  Promise.all([provider(entry.spec.source), fetcher()])
    .then(async ([module, fetch]) => {
      if (!module.notify) return;
      await module.notify({
        type, id: entry.id, spec: entry.spec, decision,
      }, { config, fetch, consent: hasConsent() });
      row.notified = [row.notified, type].filter(Boolean).join(', ');
      log(row);
      entry.section.dispatchEvent(new CustomEvent('personalization:notified', {
        bubbles: true, detail: { id: entry.id, variant: decision.variant, type },
      }));
    })
    .catch((error) => console.warn(`⚠️ personalization: ${type} notification for "${entry.id}" failed:`, error.message));
}

function watchExposure(entry, decision, container, { visible = false } = {}) {
  entry.exposure?.abort();
  if (!decision.data) return;
  const controller = new AbortController();
  entry.exposure = controller;
  const { signal } = controller;
  container.addEventListener('click', (event) => {
    if (!event.target.closest('a[href]')) return;
    controller.abort();
    notify(entry, decision, 'click');
  }, { signal });
  if (visible) {
    notify(entry, decision, 'display');
    return;
  }
  // Seen, not just rendered: a section below the fold counts once it shows.
  const observer = new IntersectionObserver((records) => {
    if (!records.some((record) => record.isIntersecting)) return;
    observer.disconnect();
    notify(entry, decision, 'display');
  }, { threshold: 0.25 });
  observer.observe(container);
  signal.addEventListener('abort', () => observer.disconnect());
}

async function show(entry, decision, started) {
  const { section } = entry;
  const previous = entry.decision;
  if (previous && previous.variant === decision.variant && previous.path === decision.path) {
    // Re-decided to what is already shown: no re-render, no second exposure.
    entry.row = log(Object.assign(entry.row || {}, {
      source: decision.source, reason: decision.reason,
    }));
    return;
  }
  if (decision.nodes) {
    entry.authored = entry.authored || [...section.childNodes];
    section.replaceChildren(...decision.nodes);
  } else if (previous?.path && entry.authored) {
    section.replaceChildren(...entry.authored);
  }
  if (entry.eager) {
    // The LCP image, as aem.js waitForFirstImage would treat it.
    const image = section.querySelector('img');
    if (image) {
      image.loading = 'eager';
      image.fetchPriority = 'high';
    }
  }
  const { nodes, ...kept } = decision;
  entry.decision = kept;
  Object.assign(section.dataset, {
    pznVariant: decision.variant, pznSource: decision.source, pznStatus: 'applied',
  });
  if (decision.reason) section.dataset.pznReason = decision.reason;
  else delete section.dataset.pznReason;
  if ([PENDING, READY].includes(section.dataset.sectionStatus)) {
    // Not shown yet: shown once every section above it is.
    section.dataset.sectionStatus = READY;
    // eslint-disable-next-line no-use-before-define
    release();
    // eslint-disable-next-line no-use-before-define
    await whenRevealed(section);
  } else {
    // eslint-disable-next-line no-use-before-define
    await reveal(section, entry.id);
  }
  entry.row = log(Object.assign(entry.row || {}, {
    kind: 'section',
    id: entry.id,
    variant: decision.variant,
    source: decision.source,
    reason: decision.reason,
    ms: Math.round(performance.now() - started),
  }));
  track(section, {
    id: entry.id, variant: decision.variant, source: decision.source, tracking: decision.tracking,
  });
  if (decision.path) watchExposure(entry, decision, section);
  else entry.exposure?.abort();
}

const revealed = new WeakMap();

// Resolves once the section has loaded (shown).
function whenRevealed(section) {
  if (section.dataset.sectionStatus === 'loaded') return Promise.resolve();
  if (!revealed.has(section)) {
    let done;
    const promise = new Promise((settle) => { done = settle; });
    revealed.set(section, { promise, done });
  }
  return revealed.get(section).promise;
}

async function reveal(section, id) {
  section.dataset.sectionStatus = 'initialized';
  try {
    await loadSection(section);
  } catch (error) {
    console.error(`❌ personalization: section "${id || '?'}" failed to load:`, error);
    section.dataset.sectionStatus = 'loaded';
    section.style.display = null;
  }
  revealed.get(section)?.done();
}

let watcher;

/**
 * Shows decided and waiting sections in page order, up to the first section
 * not shown yet: still being decided, or still loading in aem.js (the first
 * section waits for its image). Runs again whenever a section's status
 * changes.
 * @param {{force?: boolean}} [options] force: show every decided and waiting section
 * @returns {Promise<void>}
 */
async function revealFrom(index, force) {
  const section = order[index];
  if (!section) {
    watcher?.disconnect();
    return;
  }
  const status = section.dataset.sectionStatus;
  if (status === READY || status === WAITING) {
    await reveal(section, section.dataset.personalization);
  } else if (status !== 'loaded' && !force) {
    return;
  }
  await revealFrom(index + 1, force);
}

function release({ force = false } = {}) {
  releasing = releasing.then(() => revealFrom(0, force));
  return releasing;
}

/**
 * Decides one section within its budget and shows the result. A newer call
 * for the same section wins; an older one leaves the DOM alone.
 */
async function resolve(entry, pending, bot) {
  entry.generation += 1;
  const { generation } = entry;
  const started = performance.now();
  let timer;
  const budget = new Promise((done) => {
    timer = setTimeout(() => done(choice(null, 'timeout')), entry.eager ? budgets.eager : budgets.lazy);
  });
  let decision;
  try {
    decision = await Promise.race([decideAndLoad(entry, pending, bot), budget]);
  } catch (error) {
    console.error(`❌ personalization: section "${entry.id}" shows its authored content after an error:`, error);
    decision = choice(null, 'error', { reason: error.message });
  } finally {
    clearTimeout(timer);
  }
  if (generation === entry.generation) await show(entry, decision, started);
}

/**
 * Decides held sections: one provider call per source, then each section
 * within its own budget. Popup offers of a source already being asked ride
 * along (entry.prefetched), so a page makes one Target request.
 * @param {object[]} list held sections
 * @param {object[]} [riders] popup sections
 * @returns {Promise<void>}
 */
function decideSections(list, riders = []) {
  const bot = isCrawler();
  const bySource = {};
  list.forEach((entry) => {
    bySource[entry.spec.source] = [...(bySource[entry.spec.source] || []), entry];
  });
  return Promise.all(Object.entries(bySource).map(([source, group]) => {
    const asking = (entry) => !bot && !overrides.forced[entry.id];
    const along = riders.filter((entry) => entry.spec.source === source && asking(entry));
    const batch = [...group.filter(asking), ...along];
    const budget = (entry) => (entry.eager ? budgets.eager : budgets.lazy);
    const timeout = Math.max(...group.map(budget)) + 250;
    const pending = batch.length ? ask(source, batch, timeout) : Promise.resolve({ decisions: {} });
    along.forEach((entry) => { entry.prefetched = pending; });
    return Promise.all(group.map((entry) => {
      entry.resolving = resolve(entry, pending, bot);
      return entry.resolving;
    }));
  }));
}

/**
 * Shows a target offer as a popup when its trigger fires; once per page view.
 */
async function arm(entry, decision) {
  const { spec } = entry;
  entry.popup = 'armed';
  Object.assign(entry.row, { variant: decision.variant, source: decision.source, status: 'armed' });
  log(entry.row);
  const ready = Promise.all([
    fragmentNodes(decision.path),
    loadCSS(`${window.hlx?.codeBasePath || ''}/styles/target-popup.css`).catch(() => {}),
  ]);
  onTrigger(spec.trigger, entry.section, async () => {
    const [nodes] = await ready;
    if (!nodes) {
      entry.row.status = 'offer failed';
      log(entry.row);
      return;
    }
    const dialog = openPopup(nodes, {
      label: decision.tracking?.['activity.name'] || 'Offer',
      onClose: () => {
        entry.row.status = 'closed';
        log(entry.row);
      },
    });
    entry.popup = 'displayed';
    entry.row.status = 'displayed';
    log(entry.row);
    track(entry.section, {
      id: entry.id, variant: decision.variant, source: decision.source, tracking: decision.tracking,
    });
    watchExposure(entry, decision, dialog.querySelector('.target-popup-content'), { visible: true });
  });
}

async function runPopups(list) {
  const bot = isCrawler();
  const batch = [];
  list.forEach((entry) => {
    entry.row = entry.row || { kind: 'popup', id: entry.id, trigger: entry.spec.trigger.type };
    const forced = overrides.forced[entry.id];
    if (forced) {
      const variant = listedVariant(entry.spec, { variant: forced }, prefixes);
      entry.popup = variant ? 'done' : entry.popup;
      if (variant?.path) {
        arm(entry, choice(variant, 'override'));
        return;
      }
      if (variant) {
        log(Object.assign(entry.row, { variant: 'default', source: 'override', status: 'no offer' }));
        return;
      }
      console.warn(`⚠️ personalization: ?pzn= offer "${forced}" is not listed in section "${entry.id}"`);
    }
    if (bot) Object.assign(entry.row, { variant: 'default', source: 'bot', status: 'no offer' });
    else batch.push(entry);
    log(entry.row);
  });
  if (!batch.length) return;
  const { source } = batch[0].spec;
  const module = await provider(source).catch(() => null);
  if (module?.requiresConsent && !hasConsent() && !(config[source] || {}).sendWithoutConsent) {
    batch.forEach((entry) => {
      entry.popup = 'waiting';
      Object.assign(entry.row, { variant: 'default', source, status: 'waiting for consent' });
      log(entry.row);
    });
    return;
  }
  // Prefetched with the held sections, else one request now.
  const prefetched = await Promise.all(batch.map((entry) => entry.prefetched));
  const missing = batch.filter((entry, i) => !prefetched[i] || prefetched[i].error === 'no consent');
  const asked = missing.length ? await ask(source, missing, 3000) : null;
  batch.forEach((entry, i) => {
    delete entry.prefetched;
    const result = missing.includes(entry) ? asked : prefetched[i];
    if (result.error) console.warn(`⚠️ personalization: ${source} failed for "${entry.id}", no offer:`, result.error);
    const answer = result.decisions?.[entry.id];
    const variant = answer && !answer.error
      ? listedVariant(entry.spec, answer, prefixes)
      : undefined;
    entry.popup = 'done';
    if (variant?.path) {
      arm(entry, choice(variant, answer.source || source, {
        tracking: answer.tracking, data: answer.data,
      }));
      return;
    }
    let status = 'no offer';
    if (result.error || answer?.error) status = `error: ${result.error || answer.error}`;
    else if (answer && !variant) status = `offer not listed: ${answer.fragment || answer.variant}`;
    Object.assign(entry.row, { variant: 'default', source, status });
    log(entry.row);
  });
}

/**
 * Call from loadEager right after decorateMain(main), and await it: when the
 * first section (LCP) is personalized, loadEager continues once it shows
 * (within the eager budget), so nothing (footer, lazy sections) appears above
 * the fold before it. Other sections are decided in the background.
 * @param {Element} main
 * @returns {Promise<void>}
 */
export async function personalizeSections(main) {
  if (entries.length) return;
  const first = main.querySelector(':scope > .section');
  const seen = new Set();
  main.querySelectorAll(SELECTOR)
    .forEach((section) => entries.push(readEntry(section, first, seen)));
  const held = [];
  entries.forEach((entry) => {
    const { spec, section } = entry;
    if (spec.errors.length) {
      console.warn(`⚠️ personalization: section "${spec.id || '?'}" shows its authored content; fix its Section Metadata:\n- ${spec.errors.join('\n- ')}`);
      section.dataset.pznStatus = 'invalid';
      log({
        kind: 'section', id: spec.id, variant: 'default', source: 'invalid', reason: spec.errors[0],
      });
      return;
    }
    if (entry.edge) {
      // The edge worker already rendered the decision into the section.
      const variant = section.dataset.pznVariant || 'default';
      // An A/B test decided at the edge still reports as one.
      const tracking = spec.source === 'split' ? { split: spec.split || 'even' } : undefined;
      entry.decision = { variant, source: 'edge' };
      entry.row = log({
        kind: 'section', id: spec.id, variant, source: 'edge',
      });
      track(section, {
        id: spec.id, variant, source: 'edge', tracking,
      });
      return;
    }
    if (!spec.held) return;
    section.dataset.sectionStatus = PENDING;
    held.push(entry);
    if (entry.eager && (previewHost || debug)) {
      console.warn(`⚠️ personalization: section "${spec.id}" is the first section (LCP) and stays hidden until decided (up to ${budgets.eager} ms); decide it at the edge (reference/edge-cloudflare.md) or personalize a later section`);
    }
  });
  if (!held.length) return;
  order = [...main.querySelectorAll(':scope > .section')];
  order.slice(order.indexOf(held[0].section) + 1).forEach((section) => {
    if (section.dataset.sectionStatus === 'initialized') section.dataset.sectionStatus = WAITING;
  });
  watcher = new MutationObserver(() => release());
  order.forEach((section) => watcher.observe(section, { attributes: true, attributeFilter: ['data-section-status'] }));
  // Budgets bound every decision; this only guards against a runtime fault.
  setTimeout(() => {
    held.filter((entry) => entry.section.dataset.sectionStatus === PENDING).forEach((entry) => {
      console.error(`❌ personalization: section "${entry.id}" was still undecided; showing its authored content`);
      entry.generation += 1;
      show(entry, choice(null, 'timeout', { reason: 'failsafe' }), performance.now());
    });
    release({ force: true });
  }, Math.max(budgets.eager, budgets.lazy) + 2000);
  decideSections(held, entries.filter((entry) => live(entry) && !entry.spec.held));
  await held.find((entry) => entry.eager)?.resolving;
}

/**
 * Call from loadLazy after loadSections(main): arms target popups.
 * @param {Element} main
 */
// eslint-disable-next-line no-unused-vars
export function personalizeSectionsLazy(main) {
  const popups = entries.filter((entry) => live(entry) && !entry.spec.held && !entry.popup);
  if (popups.length) runPopups(popups);
}

register({
  refresh: () => {
    const waiting = entries.filter((entry) => entry.popup === 'waiting');
    return Promise.all([
      decideSections(entries.filter((entry) => live(entry) && entry.spec.held), waiting),
      runPopups(waiting),
    ]);
  },
  stateChanged: (key) => decideSections(entries.filter((entry) => live(entry) && entry.spec.held
    && (stateKeysUsed(entry.spec).has(key) || sectionCriteria(entry.spec).has('audience')))),
});

export default personalizeSections;

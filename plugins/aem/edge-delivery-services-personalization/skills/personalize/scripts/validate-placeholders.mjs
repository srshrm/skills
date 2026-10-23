#!/usr/bin/env node
/*
 * Validates personalized sections (Section Metadata) in local content
 * (.html / .plain.html). Read-only; exits 1 when any section has errors.
 *
 * Source content is read the way the pipeline renders it (Section Metadata
 * rows -> data-* attributes, html.js renderSectionMetadata), then parsed by
 * the runtime's own grammar (section-spec.js), so what passes here is what
 * the browser and the edge worker see.
 *
 * Section checks: grammar (ids, sources, variants, rules, split, trigger,
 * display), unique ids per page, rows the pipeline
 * mangles (a repeated key keeps only its last value; a condition over several
 * paragraphs is comma-joined), aem-experimentation metadata on the same
 * section, fragments under the allowed prefixes and present (locally under
 * content/, or on --base-url), no nesting, TODO copy, the same H1 structure as
 * the authored content, registered audiences, configured sources (API
 * endpoint, Target client code, providers), the first section (LCP).
 *
 * Usage: node validate-placeholders.mjs [files or dirs...] [--repo .]
 *          [--base-url http://localhost:3000] [--json]
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  importAsset, exitOnHelp, isMain, parseArgs, readText, sitePrefixes, status,
} from './lib.mjs';

export const USAGE = `Usage: node validate-placeholders.mjs [files or dirs...] [--repo .]
         [--base-url http://localhost:3000] [--json]
Validates personalized sections (Section Metadata) in local content
(content/<path>.html or .plain.html): grammar, unique ids, rows the pipeline
mangles, experimentation overlap, fragment prefixes and existence, nesting,
TODO copy, H1 structure, registered audiences, source config (API endpoint,
Target client code, providers), LCP. Read-only.
Exit 1 when any section has errors.`;

const { stateKeysUsed } = await importAsset('runtime', 'scripts', 'personalization', 'rules.js');
const {
  parseSection, sectionCriteria, SOURCES, ATTRIBUTE,
} = await importAsset('runtime', 'scripts', 'personalization', 'section-spec.js');
const {
  findSections, sections, renderSectionMetadata,
} = await importAsset('edge', 'cloudflare', 'src', 'personalization', 'html.js');

const PERSONALIZED = /section-metadata|data-personalization/;

function htmlFiles(target) {
  if (!existsSync(target)) return [];
  if (!statSync(target).isDirectory()) return target.endsWith('.html') ? [target] : [];
  return readdirSync(target).flatMap((name) => (name.startsWith('.') ? [] : htmlFiles(join(target, name))));
}

/**
 * Local file for a fragment path: content/<path>.html (the local DA
 * content tree) or content/<path>.plain.html.
 * @param {string} repo
 * @param {string} path
 * @returns {string|null}
 */
export function localFragment(repo, path) {
  const candidates = [`${path}.html`, `${path}.plain.html`].map((file) => join(repo, 'content', file));
  return candidates.find((file) => existsSync(file)) || null;
}

async function remoteFragment(baseUrl, path) {
  try {
    const response = await fetch(new URL(`${path}.plain.html`, baseUrl));
    return response.ok ? await response.text() : null;
  } catch (e) {
    return null;
  }
}

// The object literal after `key:` in a config source, braces balanced.
function configBlock(text, key) {
  const match = new RegExp(`(?:^|[\\s,{])${key}\\s*:\\s*\\{`).exec(text);
  if (!match) return null;
  let depth = 0;
  for (let i = match.index + match[0].length - 1; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    if (text[i] === '}') depth -= 1;
    if (depth === 0) return text.slice(match.index + match[0].length, i);
  }
  return null;
}

const stringValue = (block, key) => {
  const match = block && new RegExp(`(?:^|[\\s,{])${key}\\s*:\\s*['"\`]([^'"\`]*)['"\`]`).exec(block);
  return match ? match[1] : '';
};

/**
 * What the validator needs from scripts/personalization/config.js, read
 * textually (the browser module is never executed in Node).
 * @param {string} source config.js source
 * @returns {{present: boolean, apiEndpoint: string, targetClientCode: string, mock: boolean,
 *   providers: string[], audiences: string}}
 */
export function readSiteConfig(source = '') {
  const text = String(source || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const providers = configBlock(text, 'providers') || '';
  return {
    present: !!text.trim(),
    apiEndpoint: stringValue(configBlock(text, 'api'), 'endpoint'),
    targetClientCode: stringValue(configBlock(text, 'target'), 'clientCode'),
    mock: /(?:^|[\s,{])mock\s*:\s*(?!false\b|null\b|undefined\b|0\b)\S/.test(text),
    providers: [...providers.matchAll(/(?:^|[\s,{])['"]?([a-z][\w-]*)['"]?\s*:/gi)].map((m) => m[1]),
    audiences: configBlock(text, 'audiences') || '',
  };
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function audienceWarnings(rules, site) {
  const warnings = [];
  rules.forEach((rule) => rule.clauses
    .filter((clause) => clause.criterion === 'audience')
    .forEach((clause) => clause.values.forEach((name) => {
      const registered = new RegExp(`['"\`]?${escapeRegExp(name)}['"\`]?\\s*:`).test(site.audiences);
      if (!registered) warnings.push(`audience "${name}" is not registered in scripts/personalization/config.js`);
    })));
  return warnings;
}

/**
 * Finds each fragment locally or on the preview and checks its content.
 * @returns {Promise<object[]>}
 */
async function checkFragments(targets, {
  repo, baseUrl, errors, warnings,
}) {
  return Promise.all(targets.map(async ({ variant, path }) => {
    const local = localFragment(repo, path);
    let content = local ? readText(local) : null;
    let where = local ? relative(repo, local) : null;
    if (!content && baseUrl) {
      content = await remoteFragment(baseUrl, path);
      where = content ? `${baseUrl}${path}` : null;
    }
    if (!content) {
      const message = `fragment for "${variant}" not found: ${path} (expected content${path}.html${baseUrl ? ` or ${baseUrl}${path}.plain.html` : ''})`;
      if (existsSync(join(repo, 'content')) || baseUrl) errors.push(message);
      else warnings.push(`${message}; pass --base-url to check a preview`);
      return { variant, path, found: false };
    }
    const nested = renderSectionMetadata(content).sections
      .some((section) => section.attributes.some(([name]) => name === ATTRIBUTE))
      || /\sdata-personalization=/.test(content);
    if (nested) errors.push(`fragment "${variant}" has a personalized section (nesting is not supported)`);
    if (/TODO:/.test(content)) warnings.push(`fragment "${variant}" still has TODO copy`);
    return {
      variant, path, found: true, where, h1: /<h1\b/i.test(content),
    };
  }));
}

function h1Warnings(fragments, authoredH1) {
  // Every variant keeps the authored heading structure: warn only on a mismatch.
  return fragments.filter((fragment) => fragment.found && fragment.h1 !== authoredH1)
    .map(({ variant, h1 }) => `fragment "${variant}" ${h1 ? 'adds an H1 the authored content lacks' : "drops the authored content's H1"}: keep the same heading structure in every variant (no cloaking)`);
}

/**
 * Validates the personalized sections of one page.
 * @returns {Promise<object[]>}
 */
async function validateSections(html, {
  repo, prefixes, site, baseUrl, seen,
}) {
  if (!PERSONALIZED.test(html)) return [];
  const rendered = renderSectionMetadata(html);
  const source = sections(html);
  const sources = [...SOURCES, ...site.providers];
  const list = findSections(rendered.html)
    .map((section, index) => ({ section, index }))
    .filter(({ section }) => section.attributes.some(([name]) => name === ATTRIBUTE || name.startsWith(`${ATTRIBUTE}-`)));
  return Promise.all(list.map(async ({ section, index }) => {
    const spec = parseSection(section.attributes, { prefixes, sources });
    const errors = [...spec.errors];
    const warnings = [...spec.warnings];
    const info = [];
    if (spec.id) {
      if (seen.has(spec.id)) errors.push(`id "${spec.id}" is used by more than one section on this page`);
      seen.add(spec.id);
    }
    // Rows the pipeline changes before the runtime sees them.
    const authored = rendered.sections.find((entry) => entry.index === index);
    (authored?.repeated || []).filter((key) => /^personalization/i.test(key.trim())).forEach((key) => {
      errors.push(`row "${key.trim()}" appears more than once: only its last value reaches the page${/rule/i.test(key) ? '; number further rules for a variant ("Personalization Rule India 2")' : ''}`);
    });
    (authored?.rows || []).filter((row) => /^personalization-rule/.test(row.name) && row.paragraphs > 1).forEach((row) => {
      errors.push(`"${row.key.trim()}" holds ${row.paragraphs} paragraphs: the pipeline joins them with "," which changes the condition; write it on one line (& for AND)`);
    });
    const range = source[index];
    const inner = range ? html.slice(range.openEnd, range.closeStart) : '';
    if (/TODO:/.test(inner.replace(/<div\b[^>]*class="section-metadata"[\s\S]*$/, ''))) warnings.push('the authored content still has TODO copy');

    const used = sectionCriteria(spec);
    warnings.push(...audienceWarnings(spec.rules, site));
    if (spec.source === 'api' && site.present && !site.apiEndpoint && !site.mock) {
      warnings.push(`source is api but config.api.endpoint is empty: ${spec.rules.length ? 'the rule rows decide' : 'visitors see the authored content'}`);
    }
    if (spec.source === 'target' && site.present && !site.targetClientCode && !site.mock && !site.providers.includes('target')) {
      warnings.push('source is target but config.target.clientCode is empty: visitors see the authored content');
    }
    if (spec.source === 'split') {
      info.push(`A/B test: ${spec.split ? `${spec.split.join('% / ')}% to the variants, the rest to the authored content` : `even split across the authored content and ${spec.variants.length} variant(s)`}; sticky per session, no consent needed`);
    }
    if (spec.source === 'target' && spec.display === 'popup') {
      info.push(`offer opens as a popup on ${spec.trigger.type === 'scroll' ? `scroll past ${Math.round(spec.trigger.ratio * 100)}%` : spec.trigger.type}; the authored content stays in place`);
    }
    if (index === 0 && spec.held && !errors.length) {
      warnings.push(`first section (LCP) stays hidden until decided (eager budget); ${spec.source === 'target' ? 'target is client-only: personalize a later section or show it as a popup' : 'decide it at the edge (reference/edge-cloudflare.md) or personalize a later section'}`);
    }
    if (['device', 'state', 'audience'].some((criterion) => used.has(criterion))) {
      info.push('uses browser-only criteria (device/state/audience): always decided in the browser');
    }
    const keys = [...stateKeysUsed(spec)];
    if (keys.length) info.push(`state keys: ${keys.join(', ')} (set with window.hlx.personalization.setState)`);

    const fragments = await checkFragments(spec.variants.map(({ name, path }) => ({ variant: name, path })), {
      repo, baseUrl, errors, warnings,
    });
    warnings.push(...h1Warnings(fragments, /<h1\b/i.test(inner)));
    return {
      id: spec.id || null,
      section: index,
      source: spec.source,
      display: spec.display,
      trigger: spec.trigger,
      split: spec.split,
      variants: spec.variants,
      rules: spec.rules.map((rule) => ({ variant: rule.variant, condition: rule.condition })),
      fragments,
      errors,
      warnings,
      info,
    };
  }));
}

/**
 * Validates one page.
 * @param {string} html page HTML (source content or delivered)
 * @param {object} options
 * @param {string} options.repo
 * @param {string[]} options.prefixes
 * @param {string} [options.config] scripts/personalization/config.js source
 * @param {string} [options.baseUrl]
 * @returns {Promise<{sections: object[]}>}
 */
export async function validatePage(html, {
  repo, prefixes, config = '', baseUrl,
}) {
  const personalized = await validateSections(html, {
    repo, prefixes, site: readSiteConfig(config), baseUrl, seen: new Set(),
  });
  return { sections: personalized };
}

/**
 * @param {string[]} targets files or directories
 * @param {object} options
 * @returns {Promise<object>} report
 */
export async function validate(targets, { repo, baseUrl } = {}) {
  const root = resolve(repo || process.cwd());
  const prefixes = sitePrefixes(root);
  const config = readText(join(root, 'scripts', 'personalization', 'config.js')) || '';
  const list = (targets.length ? targets : ['content']).flatMap((target) => htmlFiles(resolve(root, target)));
  const pages = [];
  await Promise.all(list.map(async (file) => {
    const html = readText(file);
    if (!PERSONALIZED.test(html)) return;
    const result = await validatePage(html, {
      repo: root, prefixes, config, baseUrl,
    });
    if (result.sections.length) pages.push({ file: relative(root, file), ...result });
  }));
  pages.sort((a, b) => a.file.localeCompare(b.file));
  const count = (items) => items.reduce((sum, item) => sum + item.errors.length, 0);
  const errorCount = pages.reduce((sum, page) => sum + count(page.sections), 0);
  return {
    prefixes, pages, errorCount, ok: errorCount === 0,
  };
}

function print(file, item, label) {
  status(!item.errors.length, `${file} → ${label}`);
  item.errors.forEach((message) => console.log(`   ❌ ${message}`));
  item.warnings.forEach((message) => console.log(`   ⚠️ ${message}`));
  item.info.forEach((message) => console.log(`   ℹ️ ${message}`));
}

if (isMain(import.meta.url)) {
  exitOnHelp(USAGE);
  const args = parseArgs(process.argv.slice(2));
  const report = await validate(args._, { repo: args.repo, baseUrl: args['base-url'] });
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    if (!report.pages.length) console.log('⚠️ no personalized sections found');
    report.pages.forEach((page) => {
      page.sections.forEach((section) => print(page.file, section, `section ${section.section + 1} "${section.id ?? '?'}" (${section.source}${section.source === 'target' ? `, ${section.display}` : ''}, ${section.variants.length} variant(s) + authored content)`));
    });
    console.log(report.ok ? '\n✓ PASS all sections valid' : `\n❌ FAIL ${report.errorCount} error(s)`);
  }
  process.exit(report.ok ? 0 : 1);
}

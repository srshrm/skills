import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { RUNTIME_DIR } from '../lib.mjs';

const {
  slug, parseTrigger, parseSplit, splitWeights, pickWeighted, ruleVariant, parseSection,
  listedVariant, decideSection, sectionCriteria, DEFAULT_TRIGGER,
} = await import(pathToFileURL(join(RUNTIME_DIR, 'scripts', 'personalization', 'section-spec.js')).href);

const F = '/fragments/personalization';
const attrs = (pairs) => Object.entries(pairs).map(([key, value]) => [key ? `data-personalization-${key}` : 'data-personalization', value]);

const HERO = attrs({
  '': 'home-hero',
  variants: `${F}/home-hero/india,${F}/home-hero/na-mobile,${F}/home-hero/returning`,
  'rule-india': 'geo: IN',
  'rule-na-mobile': 'geo: US, CA & device: mobile',
  'rule-returning': 'visitor: returning',
  'rule-india-2': 'param: utm_campaign=diwali',
});

describe('section grammar', () => {
  it('reads id, source, variants and rules in attribute order', () => {
    const spec = parseSection(HERO);
    assert.equal(spec.id, 'home-hero');
    assert.equal(spec.source, 'rules');
    assert.deepEqual(spec.variants.map((variant) => variant.name), ['india', 'na-mobile', 'returning']);
    assert.deepEqual(spec.rules.map((rule) => [rule.variant, rule.condition]), [
      ['india', 'geo: IN'],
      ['na-mobile', 'geo: US, CA & device: mobile'],
      ['returning', 'visitor: returning'],
      ['india', 'param: utm_campaign=diwali'],
    ]);
    assert.deepEqual(spec.errors, []);
    assert.deepEqual(spec.warnings, []);
    assert.equal(spec.held, true);
    assert.equal(spec.display, 'inline');
  });

  it('accepts an object of attributes and matches rule keys loosely', () => {
    const spec = parseSection({
      'data-personalization': 'quiz',
      'data-personalization-variants': `${F}/quiz/Persona_A`,
      // older aem.js turns _ into -
      'data-personalization-rule-persona-a': 'state: persona=a',
    });
    assert.deepEqual(spec.errors, []);
    assert.equal(spec.rules[0].variant, 'Persona_A');
  });

  it('numbers rules so a variant can have several (OR across criteria)', () => {
    const variants = [{ name: 'india' }, { name: 'team-2' }];
    assert.equal(ruleVariant('india-3', variants).name, 'india');
    assert.equal(ruleVariant('team-2', variants).name, 'team-2', 'an exact name wins over the numbered form');
    assert.equal(ruleVariant('team', variants), undefined);
  });

  it('rejects ids, sources, conditions and rules that name no variant', () => {
    const spec = parseSection(attrs({
      '': 'bad id!',
      source: 'magic',
      variants: `${F}/x/a`,
      'rule-a': 'weather: sunny',
      'rule-b': 'geo: IN',
      rule: 'geo: US',
    }));
    assert.equal(spec.errors.length, 5, spec.errors.join('\n'));
    assert.match(spec.errors[0], /id "bad id!"/);
    assert.match(spec.errors[1], /source must be one of rules, api, split, target, got "magic"/);
    assert.match(spec.errors.join('\n'), /Rule a": unknown criterion|Rule a"/);
    assert.match(spec.errors.join('\n'), /"Personalization Rule b" names no variant/);
    assert.match(spec.errors.join('\n'), /"Personalization Rule" names no variant .*add the variant name/);
  });

  it('accepts sources registered by the site', () => {
    assert.equal(parseSection(attrs({ '': 'x', source: 'optimizely', variants: `${F}/x/a` }), { sources: ['optimizely'] }).source, 'optimizely');
  });

  it('keeps conditions out of Variants and the name default out of variants', () => {
    const spec = parseSection(attrs({
      '': 'hero', variants: `geo: IN,${F}/hero/default,${F}/a/india,${F}/b/india`, 'rule-india': 'geo: IN',
    }));
    assert.equal(spec.errors.length, 3, spec.errors.join('\n'));
    assert.match(spec.errors[0], /"geo: IN" is not one/);
    assert.match(spec.errors[1], /cannot be named "default"/);
    assert.match(spec.errors[2], /share the name "india"/);
  });

  it('needs variants and rules for a rules section, and warns about unreachable variants', () => {
    assert.match(parseSection(attrs({ '': 'x' })).errors[0], /needs "Personalization Variants"/);
    assert.match(parseSection(attrs({ '': 'x', variants: `${F}/x/a` })).errors[0], /needs at least one "Personalization Rule/);
    const spec = parseSection(attrs({
      '': 'x', variants: `${F}/x/a,${F}/x/b`, 'rule-a': 'geo: IN',
    }));
    assert.deepEqual(spec.warnings, ['variant "b" has no rule: only ?pzn= previews show it']);
  });

  it('flags sections that also run aem-experimentation', () => {
    const spec = parseSection([...HERO, ['data-experiment', 'hero-test'], ['data-audience-mobile', '/x']]);
    assert.equal(spec.errors.length, 2);
    assert.match(spec.errors[0], /aem-experimentation metadata \(experiment\)/);
  });

  it('warns about unknown Personalization rows', () => {
    assert.deepEqual(parseSection([...HERO, ['data-personalization-audience', 'x']]).warnings, [
      'unknown row "Personalization audience" is ignored',
    ]);
  });
});

describe('split sections', () => {
  const split = (value, variants = 2) => parseSection(attrs({
    '': 'msg',
    source: 'split',
    variants: Array.from({ length: variants }, (_, index) => `${F}/msg/v${index}`).join(','),
    ...(value === undefined ? {} : { split: value }),
  }));

  it('parses percentages and gives the rest to the default', () => {
    assert.deepEqual(parseSplit('40, 30'), [40, 30]);
    assert.deepEqual(parseSplit('50%,50%'), [50, 50]);
    assert.equal(parseSplit('half, half'), null);
    assert.deepEqual(splitWeights(2, [40, 30]), [30, 40, 30]);
    assert.deepEqual(splitWeights(2, [0, 100]), [0, 0, 100]);
    assert.deepEqual(splitWeights(2, [50]), [50, 50, 0]);
    assert.deepEqual(splitWeights(3, null), [1, 1, 1, 1], 'even across the default and every variant');
  });

  it('picks in proportion to the weights', () => {
    assert.equal(pickWeighted([0, 0, 100], 0), 2);
    assert.equal(pickWeighted([0, 0, 100], 0.999), 2);
    assert.equal(pickWeighted([30, 40, 30], 0.29), 0);
    assert.equal(pickWeighted([30, 40, 30], 0.3), 1);
    assert.equal(pickWeighted([30, 40, 30], 0.7), 2);
    assert.equal(pickWeighted([0, 0], 0.5), 0);
    const counts = [0, 0, 0];
    for (let i = 0; i < 3000; i += 1) counts[pickWeighted(splitWeights(2, null), i / 3000)] += 1;
    assert.deepEqual(counts, [1000, 1000, 1000]);
  });

  it('validates the split row', () => {
    assert.deepEqual(split('0, 100').errors, []);
    assert.deepEqual(split(undefined).split, null);
    assert.match(split('60, 50').errors[0], /adds up to 110%/);
    assert.match(split('10, 10, 10').errors[0], /3 values for 2 variant/);
    assert.match(split('ten').errors[0], /must be percentages/);
  });

  it('ignores rule rows, triggers and a split outside split sections', () => {
    const spec = parseSection(attrs({
      '': 'msg', source: 'split', variants: `${F}/msg/a`, 'rule-a': 'geo: IN', trigger: 'view',
    }));
    assert.deepEqual(spec.rules, []);
    assert.deepEqual(spec.warnings, [
      '"Personalization Trigger" is ignored outside target sections',
      '"Personalization Rule rows" is ignored in a split section',
    ]);
    assert.deepEqual(parseSection([...HERO, ['data-personalization-split', '50']]).warnings, [
      '"Personalization Split" is ignored outside split sections',
    ]);
  });
});

describe('target sections', () => {
  const target = (extra = {}) => parseSection(attrs({
    '': 'offer', source: 'target', variants: `${F}/offer/free-trial,${F}/offer/demo`, ...extra,
  }));

  it('parses triggers', () => {
    assert.deepEqual(parseTrigger('scroll: 70%'), { type: 'scroll', ratio: 0.7 });
    assert.deepEqual(parseTrigger('Scroll 35'), { type: 'scroll', ratio: 0.35 });
    assert.deepEqual(parseTrigger('view'), { type: 'view' });
    assert.deepEqual(parseTrigger('LOAD'), { type: 'load' });
    assert.equal(parseTrigger('scroll: 120%'), null);
    assert.equal(parseTrigger('exit intent'), null);
  });

  it('is inline (held) without a trigger, a popup with one', () => {
    const inline = target();
    assert.deepEqual([inline.display, inline.held, inline.trigger], ['inline', true, null]);
    const popup = target({ trigger: 'scroll: 40%' });
    assert.deepEqual([popup.display, popup.held, popup.trigger], ['popup', false, { type: 'scroll', ratio: 0.4 }]);
    const defaulted = target({ display: 'popup' });
    assert.deepEqual([defaulted.held, defaulted.trigger], [false, DEFAULT_TRIGGER]);
    const ignored = target({ display: 'inline', trigger: 'view' });
    assert.deepEqual([ignored.held, ignored.trigger, ignored.warnings], [true, null, ['"Personalization Trigger" is ignored with "Display | inline"']]);
  });

  it('rejects bad triggers and displays', () => {
    assert.match(target({ trigger: 'exit' }).errors[0], /"Personalization Trigger" must be/);
    assert.match(target({ display: 'banner' }).errors[0], /"Personalization Display" must be inline or popup/);
  });

  it('needs no variants: any allowed fragment is then an offer', () => {
    const open = parseSection(attrs({ '': 'offer', source: 'target' }));
    assert.deepEqual(open.errors, []);
    assert.deepEqual(listedVariant(open, { fragment: `${F}/offer/anything` }), { name: 'anything', path: `${F}/offer/anything` });
    assert.equal(listedVariant(open, { fragment: '/etc/evil' }), undefined, 'the fragment allowlist still applies');
    // Only the path is kept, so the fragment always loads from the site itself.
    assert.equal(listedVariant(open, { fragment: 'https://evil.example/fragments/x' }).path, '/fragments/x');
  });
});

describe('listedVariant', () => {
  const spec = parseSection(HERO);

  it('finds variants by name or by path, and only those', () => {
    assert.equal(listedVariant(spec, { variant: 'INDIA' }).path, `${F}/home-hero/india`);
    assert.equal(listedVariant(spec, { fragment: `${F}/home-hero/returning` }).name, 'returning');
    assert.equal(listedVariant(spec, { fragment: `${F}/other/returning` }), undefined);
    assert.equal(listedVariant(spec, { variant: 'mars' }), undefined);
    assert.equal(listedVariant(spec, null), undefined);
  });

  it('treats null and default as the authored content', () => {
    assert.deepEqual(listedVariant(spec, { variant: null }), { name: 'default' });
    assert.deepEqual(listedVariant(spec, { variant: 'default' }), { name: 'default' });
  });
});

describe('decideSection', () => {
  const spec = parseSection(HERO);

  it('takes the first matching rule, else the authored content', async () => {
    assert.deepEqual(await decideSection(spec, { geo: { country: 'IN' } }), {
      variant: 'india', path: `${F}/home-hero/india`, source: 'rule', rule: 'geo: IN',
    });
    assert.equal((await decideSection(spec, { geo: { country: 'US' }, device: 'mobile', visitor: 'returning' })).variant, 'na-mobile');
    assert.equal((await decideSection(spec, { params: { utm_campaign: 'diwali' } })).variant, 'india');
    assert.deepEqual(await decideSection(spec, { geo: { country: 'FR' } }), { variant: 'default', source: 'default' });
  });

  it('puts forced variants first, then listed engine decisions', async () => {
    const context = { geo: { country: 'IN' } };
    assert.equal((await decideSection(spec, context, { forcedVariant: 'returning' })).source, 'override');
    assert.equal((await decideSection(spec, context, { forcedVariant: 'default' })).variant, 'default');
    assert.equal((await decideSection(spec, context, { forcedVariant: 'mars' })).variant, 'india', 'an unknown forced variant is ignored');
    assert.deepEqual(await decideSection(spec, context, { apiDecision: { variant: 'returning', tracking: { a: '1' } } }), {
      variant: 'returning', path: `${F}/home-hero/returning`, source: 'api', tracking: { a: '1' },
    });
    assert.equal((await decideSection(spec, context, { apiDecision: { variant: 'mars' } })).source, 'rule', 'unlisted engine answers fall back to the rules');
  });

  it('defers when a client-only criterion could match first', async () => {
    assert.deepEqual(await decideSection(spec, { geo: { country: 'US' } }, { deferCriteria: ['device'] }), { deferred: true });
    assert.equal((await decideSection(spec, { geo: { country: 'IN' } }, { deferCriteria: ['device'] })).variant, 'india');
  });

  it('lists the criteria a section uses', () => {
    assert.deepEqual([...sectionCriteria(spec)].sort(), ['device', 'geo', 'param', 'visitor']);
  });

  it('slugs names', () => {
    assert.equal(slug(' Persona_A '), 'persona-a');
    assert.equal(slug('--Na  Mobile--'), 'na-mobile');
  });
});

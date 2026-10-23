import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readSiteConfig, validate, validatePage } from '../validate-placeholders.mjs';
import { readText } from '../lib.mjs';
import { SITE, runHelp, tempDir } from './helpers.mjs';

describe('validate', () => {
  const section = (id, rows, body = '<h1>Title</h1>') => `<div>${body}<div class="section-metadata">`
    + `<div><div>Personalization</div><div>${id}</div></div>`
    + `${rows.map(([key, value]) => `<div><div>${key}</div><div>${value}</div></div>`).join('')}</div></div>`;

  it('passes the fixture site', async () => {
    const report = await validate([], { repo: SITE });
    assert.equal(report.ok, true, JSON.stringify(report.pages.map((p) => p.sections.map((x) => x.errors))));
    assert.deepEqual(report.pages.map((page) => page.file), ['content/index.html', 'content/offer.plain.html']);
    const [hero, welcome] = report.pages[0].sections;
    assert.deepEqual([hero.id, hero.section, welcome.id, welcome.section], ['home-hero', 0, 'welcome', 2]);
    assert.match(hero.warnings.join(), /first section \(LCP\)/);
    assert.match(welcome.info.join(), /state keys: quiz-persona/);
    assert.ok(hero.fragments.every((fragment) => fragment.found));
    const [offer] = report.pages[1].sections;
    assert.equal(offer.source, 'api');
  });

  it('warns about the H1 only when a variant differs from the authored content', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const base = join(dir, 'content', 'fragments', 'p');
      mkdirSync(base, { recursive: true });
      writeFileSync(join(base, 'in.html'), '<body><main><div><h1>Namaste</h1></div></main></body>');
      writeFileSync(join(base, 'us.html'), '<body><main><div><h2>Hey</h2></div></main></body>');
      const page = section('p', [['Personalization Variants', '/fragments/p/in, /fragments/p/us'], ['Personalization Rule In', 'geo: IN'], ['Personalization Rule Us', 'geo: US']]);
      const { sections: [result] } = await validatePage(page, { repo: dir, prefixes: ['/fragments/'] });
      const h1 = result.warnings.filter((warning) => /H1/.test(warning));
      assert.deepEqual(h1, ['fragment "us" drops the authored content\'s H1: keep the same heading structure in every variant (no cloaking)']);
    } finally {
      cleanup();
    }
  });

  it('only warns about missing fragments when there is no local content to check', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const page = section('a', [['Personalization Variants', '/fragments/a/in'], ['Personalization Rule In', 'geo: IN']], '<p>x</p>');
      const { sections } = await validatePage(page, { repo: dir, prefixes: ['/fragments/'] });
      assert.deepEqual(sections[0].errors, []);
      assert.match(sections[0].warnings.join(), /pass --base-url/);
    } finally {
      cleanup();
    }
  });
});

describe('validate sections', () => {
  const F = '/fragments/personalization';
  const cell = (value) => (Array.isArray(value) ? value.join('') : `<p>${value}</p>`);
  const metadata = (rows) => `<div class="section-metadata">${rows.map(([key, value]) => `<div><div><p>${key}</p></div><div>${cell(value)}</div></div>`).join('')}</div>`;
  const link = (path) => `<p><a href="https://main--site--org.aem.page${path}">https://main--site--org.aem.page${path}</a></p>`;
  const page = (...sections) => `<body><header></header><main>${sections.map((body) => `<div>${body}</div>`).join('')}</main></body>`;

  function site(files) {
    const temp = tempDir();
    Object.entries(files).forEach(([path, body]) => {
      const file = join(temp.dir, path);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, body);
    });
    return temp;
  }

  it('reads source content the way the pipeline renders it', async () => {
    const { dir, cleanup } = site({
      [`content${F}/plan/enterprise.html`]: '<body><main><div><h2>Enterprise</h2></div></main></body>',
      [`content${F}/plan/agency.html`]: '<body><main><div><h2>Agency</h2></div></main></body>',
      'scripts/personalization/config.js': "export default { api: { endpoint: '/decide' }, target: { clientCode: '' }, audiences: {}, mock: false };",
    });
    try {
      const html = page('<h1>Hero</h1>', `<h2>Plans</h2>${metadata([
        ['Style', 'dark'],
        ['Personalization', 'plan'],
        ['Personalization Source', 'api'],
        ['Personalization Variants', [link(`${F}/plan/enterprise`), link(`${F}/plan/agency`)]],
        ['Personalization Rule Agency', 'param: utm_source=agency'],
      ])}`);
      const { sections: [plan] } = await validatePage(html, {
        repo: dir, prefixes: ['/fragments/'], config: readText(join(dir, 'scripts/personalization/config.js')),
      });
      assert.deepEqual(plan.errors, []);
      assert.deepEqual(plan.warnings, []);
      assert.equal(plan.section, 1);
      assert.equal(plan.source, 'api');
      assert.deepEqual(plan.variants.map((variant) => variant.path), [`${F}/plan/enterprise`, `${F}/plan/agency`]);
      assert.deepEqual(plan.rules, [{ variant: 'agency', condition: 'param: utm_source=agency' }]);
      assert.ok(plan.fragments.every((fragment) => fragment.found));
    } finally {
      cleanup();
    }
  });

  it('catches rows the pipeline mangles, overlap, nesting, missing fragments and LCP', async () => {
    const { dir, cleanup } = site({
      [`content${F}/hero/india.html`]: '<body><main><div><h2>India</h2><p>TODO: copy</p></div></main></body>',
      [`content${F}/hero/nested.html`]: `<body><main><div>${metadata([['Personalization', 'inner']])}</div></main></body>`,
      'scripts/personalization/config.js': 'export default { audiences: {} };',
    });
    try {
      const html = page(`<h1>Hero</h1>${metadata([
        ['Personalization', 'hero'],
        ['Personalization Variants', [link(`${F}/hero/india`), link(`${F}/hero/nested`), link(`${F}/hero/gone`)]],
        ['Personalization Rule India', 'geo: IN'],
        ['Personalization Rule India', 'param: utm_campaign=diwali'],
        ['Personalization Rule Nested', ['<p>geo: US</p>', '<p>device: mobile</p>']],
        ['Personalization Rule Gone', 'audience: vip'],
        ['Experiment', 'hero-test'],
      ])}`, `<p>x</p>${metadata([['Personalization', 'hero'], ['Personalization Source', 'split'], ['Personalization Variants', link(`${F}/hero/india`)]])}`);
      const { sections: [hero, second] } = await validatePage(html, {
        repo: dir, prefixes: ['/fragments/'], config: readText(join(dir, 'scripts/personalization/config.js')),
      });
      const errors = hero.errors.join('\n');
      assert.match(errors, /aem-experimentation metadata \(experiment\)/);
      assert.match(errors, /row "Personalization Rule India" appears more than once.*Rule India 2/);
      assert.match(errors, /"Personalization Rule Nested" holds 2 paragraphs/);
      assert.match(errors, /fragment for "gone" not found/);
      assert.match(errors, /fragment "nested" has a personalized section/);
      const warnings = hero.warnings.join('\n');
      assert.match(warnings, /audience "vip" is not registered/);
      assert.match(warnings, /fragment "india" still has TODO copy/);
      assert.match(warnings, /fragment "india" drops the authored content's H1/);
      assert.match(second.errors.join(), /id "hero" is used by more than one section on this page/);
      const clean = await validatePage(page(`<h1>Hero</h1>${metadata([
        ['Personalization', 'hero'], ['Personalization Variants', link(`${F}/hero/india`)], ['Personalization Rule India', 'geo: IN'],
      ])}`), { repo: dir, prefixes: ['/fragments/'] });
      assert.match(clean.sections[0].warnings.join(), /first section \(LCP\) stays hidden.*edge/);
    } finally {
      cleanup();
    }
  });

  it('checks source configuration and describes splits and popups', async () => {
    const html = page('<h1>Hi</h1>', metadata([
      ['Personalization', 'offer'], ['Personalization Source', 'target'], ['Personalization Trigger', 'scroll: 40%'],
    ]), metadata([
      ['Personalization', 'msg'], ['Personalization Source', 'split'], ['Personalization Split', '30, 20'],
      ['Personalization Variants', [link(`${F}/msg/a`), link(`${F}/msg/b`)]],
    ]), metadata([
      ['Personalization', 'opt'], ['Personalization Source', 'optimizely'], ['Personalization Variants', link(`${F}/opt/a`)],
    ]));
    const { dir, cleanup } = tempDir();
    try {
      const { sections: [offer, msg, opt] } = await validatePage(html, {
        repo: dir,
        prefixes: ['/fragments/'],
        config: "export default {\n  target: { clientCode: '' },\n  // providers: { nope: 1 },\n  providers: { optimizely: () => import('./x.js') },\n};",
      });
      assert.match(offer.warnings.join(), /config.target.clientCode is empty/);
      assert.match(offer.info.join(), /popup on scroll past 40%/);
      assert.match(msg.info.join(), /30% \/ 20% to the variants/);
      assert.deepEqual(opt.errors, []);
    } finally {
      cleanup();
    }
  });

  it('reads config.js textually', () => {
    assert.deepEqual(readSiteConfig(`export default {
      api: { endpoint: '/pzn/decide', mapRequest: (body) => { return { body }; } },
      target: { clientCode: 'acme', endpoint: '' },
      /* mock: { api: {} }, */
      mock: false,
      providers: { target: () => import('./sources/target-websdk.js'), 'my-engine': () => import('./x.js') },
      audiences: { vip: () => true },
    };`), {
      present: true,
      apiEndpoint: '/pzn/decide',
      targetClientCode: 'acme',
      mock: false,
      providers: ['target', 'my-engine'],
      audiences: ' vip: () => true ',
    });
    assert.equal(readSiteConfig('export default { mock: { api: {} } };').mock, true);
  });
});

describe('validate-placeholders.mjs --help', () => {
  it('prints the usage, exits 0 and writes nothing', () => {
    const { status, stdout, wrote } = runHelp('validate-placeholders.mjs');
    assert.equal(status, 0);
    assert.match(stdout, /^Usage/);
    assert.deepEqual(wrote, []);
  });
});

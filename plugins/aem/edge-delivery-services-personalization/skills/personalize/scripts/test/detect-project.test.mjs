import assert from 'node:assert/strict';
import {
  cpSync, mkdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { detect, projectType } from '../detect-project.mjs';
import { installRuntime } from '../install-runtime.mjs';
import { SITE, runHelp, siteRepo, tempDir } from './helpers.mjs';

describe('detect', () => {
  it('reports project type, hooks and personalized pages', () => {
    const { dir, cleanup } = siteRepo();
    try {
      cpSync(join(SITE, 'content'), join(dir, 'content'), { recursive: true });
      const before = detect(dir);
      assert.equal(before.projectType, 'da');
      assert.equal(before.supported, true);
      assert.equal(before.scriptsJs.decorateMainInLoadEager, true);
      assert.equal(before.scriptsJs.sectionsHookInstalled, false);
      assert.equal(before.runtime.installed, false);
      assert.equal(before.sectionMetadata.renderedBy, 'pipeline');
      assert.deepEqual(before.content.pagesWithSections.sort(), ['content/index.html', 'content/offer.plain.html']);
      assert.equal(before.edge.cloudflare, false);
      writeFileSync(join(dir, 'wrangler.toml'), 'name = "site"\n');
      assert.equal(detect(dir).edge.cloudflare, true);
      rmSync(join(dir, 'wrangler.toml'));
      installRuntime(dir, { applyHook: true });
      const after = detect(dir);
      assert.equal(after.scriptsJs.sectionsHookInstalled, true);
      assert.equal(after.runtime.installed, true);
      assert.equal(after.runtime.popupStyles, true);
      assert.ok(Object.values(after.runtime.files).every((state) => state === 'current'));
    } finally {
      cleanup();
    }
  });

  it('finds personalized and experimentation sections, Target libraries and aem.js section metadata', () => {
    const { dir, cleanup } = siteRepo();
    try {
      mkdirSync(join(dir, 'content'));
      const metadata = (rows) => `<div class="section-metadata">${rows.map(([key, value]) => `<div><div><p>${key}</p></div><div><p>${value}</p></div></div>`).join('')}</div>`;
      writeFileSync(join(dir, 'content', 'source.html'), `<main><div>${metadata([['Personalization', 'plan'], ['Personalization Source', 'split']])}<p>x</p></div></main>`);
      writeFileSync(join(dir, 'content', 'test.html'), `<main><div>${metadata([['Experiment', 'hero-test']])}<p>x</p></div></main>`);
      writeFileSync(join(dir, 'content', 'delivered.plain.html'), '<div data-personalization="x"><p>x</p></div>');
      writeFileSync(join(dir, 'content', 'style.html'), `<main><div>${metadata([['Style', 'dark']])}<p>format.js</p></div></main>`);
      writeFileSync(join(dir, 'head.html'), '<script src="https://assets.adobedtm.com/launch-abc.min.js"></script><script src="/scripts/at.js"></script>');
      writeFileSync(join(dir, 'scripts', 'aem.js'), "function decorateSections(main) {\n  const sectionMeta = section.querySelector('div.section-metadata');\n}\n");
      const report = detect(dir);
      assert.deepEqual(report.content.pagesWithSections.sort(), ['content/delivered.plain.html', 'content/source.html']);
      assert.deepEqual(report.content.pagesWithExperiments, ['content/test.html']);
      assert.deepEqual([report.integrations.atjs, report.integrations.websdk, report.integrations.launch], [true, false, true]);
      assert.equal(report.sectionMetadata.renderedBy, 'aem.js');
    } finally {
      cleanup();
    }
  });

  it('fails fast on xwalk and doc projects', () => {
    const { dir, cleanup } = tempDir();
    try {
      writeFileSync(join(dir, 'component-models.json'), '[]');
      assert.equal(projectType(dir).type, 'xwalk');
      assert.equal(detect(dir).supported, false);
      rmSync(join(dir, 'component-models.json'));
      writeFileSync(join(dir, 'fstab.yaml'), 'mountpoints:\n  /: https://drive.google.com/drive/folders/x\n');
      assert.equal(projectType(dir).type, 'doc');
      assert.match(detect(dir).reason, /DA projects only/);
    } finally {
      cleanup();
    }
  });
});

describe('detect-project.mjs --help', () => {
  it('prints the usage, exits 0 and writes nothing', () => {
    const { status, stdout, wrote } = runHelp('detect-project.mjs');
    assert.equal(status, 0);
    assert.match(stdout, /^Usage/);
    assert.deepEqual(wrote, []);
  });
});

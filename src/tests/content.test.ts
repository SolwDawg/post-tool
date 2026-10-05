import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { loadStory, sanitizeHtml } from '../content.js';
import { findContentFolders, readContained } from '../safe-path.js';
import { previewHtml } from '../plan.js';
import { fixture, metadata, workspace } from './helpers.js';

test('ten chapters keep numeric order and TXT/HTML content; source stays byte-identical', async t => {
  const root = await workspace(t); const folder = await fixture(root, 10);
  const before = await readFile(path.join(folder, 'metadata.json'));
  const loaded = await loadStory(folder);
  assert.equal(loaded.ready, true, JSON.stringify(loaded.issues));
  assert.deepEqual(loaded.story!.chapters.map(c => c.order), [1,2,3,4,5,6,7,8,9,10]);
  assert.equal(loaded.story!.chapters[9]!.title, 'Chapter 10 - Part 10');
  assert.deepEqual(await readFile(path.join(folder, 'metadata.json')), before);
  assert.deepEqual(await findContentFolders(root), [folder]);
});
test('title-only fake chapter, shifted numbering and HTML mismatch block ready', async t => {
  const folder = await fixture(await workspace(t));
  await writeFile(path.join(folder, 'chapter_1.txt'), 'A Family Story 009');
  await writeFile(path.join(folder, 'chapter_2.txt'), 'Chapter 1 - Real opening\n\nActual story.');
  const loaded = await loadStory(folder);
  assert.equal(loaded.ready, false);
  for (const code of ['TITLE_ONLY','BODY_NUMBER_MISMATCH','HTML_TEXT_MISMATCH']) assert(loaded.issues.some(i => i.code === code));
});
test('short actual story is not removed or rejected because of length', async t => {
  const folder = await fixture(await workspace(t), 1);
  await writeFile(path.join(folder, 'chapter_1.txt'), 'He returned home.');
  await writeFile(path.join(folder, 'article_seo_ready.html'), '<section id="chapter-1"><h2>Chapter 1 - Part 1</h2><p>He returned home.</p></section>');
  const loaded = await loadStory(folder);
  assert.equal(loaded.ready, true, JSON.stringify(loaded.issues));
  assert.equal(loaded.story!.chapters[0]!.text, 'He returned home.');
});
test('undeclared files, repeated bodies and non-contiguous order block publication', async t => {
  const folder = await fixture(await workspace(t));
  const data = metadata(); data.chapters[1]!.order = 3;
  await writeFile(path.join(folder, 'metadata.json'), JSON.stringify(data));
  await writeFile(path.join(folder, 'chapter_3.txt'), 'Unlisted chapter.');
  await writeFile(path.join(folder, 'chapter_2.txt'), await readFile(path.join(folder, 'chapter_1.txt')));
  const loaded = await loadStory(folder);
  for (const code of ['MISSING_ORDER','UNDECLARED_CHAPTER','DUPLICATE_BODY']) assert(loaded.issues.some(i => i.code === code));
});
test('absolute and traversal metadata references cannot read outside the selected folder', async t => {
  const root = await workspace(t); const folder = await fixture(root);
  await writeFile(path.join(root, 'outside.txt'), 'SHOULD NOT READ');
  for (const name of ['../../outside.txt', '..\\..\\outside.txt', 'C:\\secrets.txt', '/etc/passwd', 'C:secret.txt']) {
    await assert.rejects(readContained(folder, name));
  }
  const data = metadata(); data.chapters[0]!.content_file = '../../outside.txt';
  await writeFile(path.join(folder, 'metadata.json'), JSON.stringify(data));
  assert.equal((await loadStory(folder)).ready, false);
});
test('junctions in a referenced file path are rejected', async t => {
  const root = await workspace(t); const folder = await fixture(root); const outside = path.join(root, 'outside');
  await mkdir(outside); await writeFile(path.join(outside, 'body.txt'), 'Outside');
  try { await symlink(outside, path.join(folder, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('OS does not allow test symlink'); return; } throw error; }
  await assert.rejects(readContained(folder, 'linked/body.txt'), /symlink|junction/);
});
test('active HTML blocks publishing and preview escapes titles, disables outbound assets', async t => {
  const folder = await fixture(await workspace(t));
  const file = path.join(folder, 'article_seo_ready.html');
  await writeFile(file, (await readFile(file, 'utf8')).replace('</body>', '<script>alert(1)</script></body>'));
  const loaded = await loadStory(folder);
  assert(loaded.issues.some(i => i.code === 'ACTIVE_HTML'));
  const story = loaded.story!;
  story.title = '<img src=x onerror=alert(1)>';
  story.chapters[0]!.html += '<a href="https://external.example">link</a><img src="https://external.example/i.png">';
  const preview = previewHtml(story, []);
  assert(preview.includes('Content-Security-Policy'));
  assert(!preview.includes('href="https://') && !preview.includes('src="https://'));
  assert(preview.includes('&lt;img'));
  assert(!sanitizeHtml('<script>bad()</script><p onclick="bad()" style="color:red;background:url(x)">safe</p>').includes('bad'));
});

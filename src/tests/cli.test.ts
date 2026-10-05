import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, workspace } from './helpers.js';
const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../cli.js', import.meta.url));

test('CLI offline dry-run does not contact unreachable site; preview writes outside source only', async t => {
  const root = await workspace(t); const folder = await fixture(root);
  const state = path.join(root, 'state');
  const before = await readFile(path.join(folder, 'chapter_1.txt'));
  const dryRun = await execute(process.execPath, [cli, 'publish', folder, '--site', 'http://127.0.0.1:1']);
  const plan = JSON.parse(dryRun.stdout);
  assert.equal(plan.mode, 'offline-dry-run'); assert.equal(plan.visibility, 'draft');
  const preview = await execute(process.execPath, [cli, 'preview', folder, '--state', state]);
  const result = JSON.parse(preview.stdout);
  assert.equal(result.status, 'ready'); assert(path.resolve(result.preview).startsWith(path.resolve(state) + path.sep));
  assert((await readFile(result.preview, 'utf8')).includes('Part 1'));
  assert.deepEqual(await readFile(path.join(folder, 'chapter_1.txt')), before);
  const json = JSON.parse(await readFile(result.plan, 'utf8'));
  assert.equal(json.payload.chapters.length, 2);
  assert.equal(json.payload.chapters[0].title, 'Part 1');
});
test('CLI validation failure exits 2, and execute is blocked before network access', async t => {
  const root = await workspace(t); const folder = await fixture(root);
  await writeFile(path.join(folder, 'chapter_1.txt'), 'A Family Story 009');
  await assert.rejects(execute(process.execPath, [cli, 'validate', folder, '--json']), error => {
    const result = error as Error & { code: number; stdout: string };
    assert.equal(result.code, 2); assert.equal(JSON.parse(result.stdout)[0].status, 'needs_review'); return true;
  });
  await assert.rejects(execute(process.execPath, [cli, 'publish', folder, '--execute', '--site', 'http://127.0.0.1:1']), /content chưa đạt/);
});
test('CLI refuses tool state inside content and ambiguous visibility flags', async t => {
  const folder = await fixture(await workspace(t));
  await assert.rejects(execute(process.execPath, [cli, 'preview', folder, '--state', path.join(folder, 'state')]), /không được nằm trong folder content/);
  await assert.rejects(execute(process.execPath, [cli, 'publish', folder, '--draft', '--public']), /không chọn cả hai/);
});

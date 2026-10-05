import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { request,HttpClient } from '../http.js';
import { SessionApi, siteOrigin } from '../api.js';
import {captureBrowserSession} from '../browser.js';
import {SessionStore} from '../session.js';
import { detailsFor, fixture, options, requireStory, workspace } from './helpers.js';
import { loadStory } from '../content.js';
import { buildPayload } from '../plan.js';
import { Journal } from '../journal.js';
import { publishStory } from '../publisher.js';
import path from 'node:path';
import type { Post, Payload } from '../types.js';

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const server = createServer((req, res) => { void Promise.resolve(handler(req, res)).catch(() => { res.statusCode = 500; res.end(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
function json(res: ServerResponse, data: unknown) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, data })); }

test('real HTTP session adapter creates draft batch once and validates GET detail contract', async t => {
  const root = await workspace(t); const story = requireStory(await loadStory(await fixture(root, 3)));
  let posts: Post[] = []; let mutations = 0;
  const server = await serve(async (req, res) => {
    assert.equal(req.headers['x-csrf-token'], 'test-csrf');
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname.endsWith('/taxonomies/categories')) { json(res, [{ id: 1, title: 'Drama' }]); return; }
    if (url.pathname.endsWith('/taxonomies/tags')) { json(res, [{ id: 2, title: 'family' }]); return; }
    if (url.pathname.endsWith('/taxonomies/series')) { json(res, []); return; }
    if (url.pathname.endsWith('/posts/chapter-batch') && req.method === 'POST') {
      mutations++; let body = ''; for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body) as Payload;
      assert.equal(payload.chapters?.length, 3); assert.equal(payload.is_active, false);
      posts = detailsFor(payload); json(res, posts.map(({id,title,slug})=>({id,title,slug,is_active:0}))); return;
    }
    if (url.pathname.endsWith('/posts')) { json(res, { data: posts, current_page: 1, last_page: 1 }); return; }
    const id = Number(url.pathname.split('/').at(-1));
    if (posts.some(p => p.id === id)) { json(res, posts.find(p => p.id === id)); return; }
    res.statusCode = 404; res.end();
  });
  t.after(server.close);
  const context = await request.newContext(); t.after(() => context.dispose());
  const api = new SessionApi(context, server.origin, 'test-csrf');
  const receipt = await publishStory(api, await Journal.open(path.join(root, 'state')), server.origin, story, options);
  assert.equal(receipt.status, 'verified'); assert.equal(mutations, 1);
  assert.equal(receipt.creationResponseShape?.[0]?.isActiveType,'number');
});
test('all pagination pages are read and malformed pagination fails closed', async t => {
  const pages: number[] = []; let broken = false;
  const server = await serve((req, res) => {
    const page = Number(new URL(req.url!, 'http://localhost').searchParams.get('page')); pages.push(page);
    json(res, broken ? { data: [] } : { current_page: page, last_page: 2, data: [{ id: page, title: `Title ${page}`, slug: `title-${page}`, is_active: false }] });
  });
  t.after(server.close); const context = await request.newContext(); t.after(() => context.dispose());
  const api = new SessionApi(context, server.origin, 'test');
  assert.equal((await api.posts()).length, 2); assert.deepEqual(pages, [1, 2]);
  broken = true; await assert.rejects(api.posts(), /phân trang/);
});
test('a failed POST is never automatically retried by native fetch transport', async t => {
  const story = requireStory(await loadStory(await fixture(await workspace(t)))); let calls = 0;
  const server = await serve((_req, res) => { calls++; res.destroy(); });
  t.after(server.close); const context = await request.newContext(); t.after(() => context.dispose());
  await assert.rejects(new SessionApi(context, server.origin, 'test').create('/posts/chapter-batch', buildPayload(story, options, [], [])));
  assert.equal(calls, 1);
});
test('API redirects are refused instead of forwarding a session to another origin', async t => {
  let leakedRequests = 0;
  const destination = await serve((_req, res) => { leakedRequests++; json(res, []); }); t.after(destination.close);
  const source = await serve((_req, res) => { res.statusCode = 302; res.setHeader('Location', `${destination.origin}/capture`); res.end(); }); t.after(source.close);
  const context = await request.newContext(); t.after(() => context.dispose());
  await assert.rejects(new SessionApi(context, source.origin, 'test').posts(), /HTTP 302/);
  assert.equal(leakedRequests, 0);
});
test('site destinations require secure origin; login URL is accepted as same-origin site input', () => {
  assert.equal(siteOrigin('https://aftertheuniform.cfx.bz/admin/dashboard'), 'https://aftertheuniform.cfx.bz');
  assert.equal(siteOrigin('http://127.0.0.1:123'), 'http://127.0.0.1:123');
  for (const url of ['http://external.example', 'https://user:secret@example.com', 'file:///C:/x', 'https://example.com/?token=abc']) assert.throws(() => siteOrigin(url));
});

test('native CDP syncs dedicated Chrome session into persistent HTTP cookie jar without Playwright', async t => {
  const root = await workspace(t); const journal = await Journal.open(path.join(root, 'state'));
  let authenticatedReads = 0;
  const server = await serve((req, res) => {
    if (req.url === '/favicon.ico') { res.statusCode = 204; res.end(); return; }
    if (req.url === '/admin/posts') {
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Set-Cookie', 'test-session=authenticated; Path=/; Max-Age=900; HttpOnly');
      res.end('<!doctype html><html><head><meta name="csrf-token" content="test-csrf"></head><body>Mock admin</body></html>'); return;
    }
    assert(req.headers.cookie?.includes('test-session=authenticated'));
    authenticatedReads++; json(res, { data: [], current_page: 1, last_page: 1 });
  });
  t.after(server.close);
  for (let run = 0; run < 2; run++) {
    const captured=await captureBrowserSession(journal.root,server.origin,'chrome',true);
    const store=new SessionStore(journal.root,server.origin);await store.save(captured.jar);
    const jar=await store.load();assert(jar);
    const context=new HttpClient({origin:server.origin,jar});
    try {
      assert((await jar.getCookies(server.origin)).some(c=>c.key==='test-session'));
      const api = await SessionApi.fromHttp(context,server.origin);
      assert.deepEqual(await api.posts(), []);
    } finally { await context.dispose(); }
  }
  assert.equal(authenticatedReads, 4);
});

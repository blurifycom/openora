import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { asAdmin, type TestDb, type TestApp, bootE2e, closeE2e } from '../index.js';

/**
 * HTTP-layer coverage for the `httpCache` etag gate (create-app.ts): the etag
 * middleware must only run for GET/HEAD, so a conditional PUT/DELETE under a
 * cached path prefix (eg `/cms/pages/{id}`, under the `/cms/pages` cache prefix)
 * always returns its real response instead of an empty 304.
 */

let db: TestDb;
let app: TestApp;

async function readJson(res: Response): Promise<unknown> {
  return res.json();
}

type CmsPage = { id: string; title: string };
const isCmsPage = (value: unknown): value is CmsPage =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as CmsPage).id === 'string' &&
  typeof (value as CmsPage).title === 'string';

beforeAll(async () => {
  ({ db, app } = await bootE2e());
}, 60_000);

afterAll(async () => {
  await closeE2e({ app, db });
});

describe('httpCache etag gate (GET/HEAD only)', () => {
  it('a PUT under a cached prefix returns the real response even when If-None-Match matches the prior GET etag', async () => {
    const admin = await asAdmin(app.app);
    const slug = `etag-put-${randomUUID()}`;

    const createRes = await admin.post('/cms/pages', {
      slug,
      title: 'Original title',
      publishedAt: new Date().toISOString(),
    });
    expect(createRes.status).toBe(200);
    const createdJson = await readJson(createRes);
    if (!isCmsPage(createdJson)) {
      throw new Error('expected a CMS page in the create response');
    }
    const page = createdJson;

    // The etag middleware IS applied to GET under this prefix - capture the real etag.
    const getRes = await admin.get(`/cms/pages/${slug}`);
    expect(getRes.status).toBe(200);
    const etag = getRes.headers.get('etag');
    expect(etag).toBeTruthy();

    // A no-op PUT (same title) produces the byte-identical response body a matching
    // GET would - the exact scenario where the old bug swallowed the mutation's
    // response into an empty 304.
    const putRes = await admin.request(`/cms/pages/${page.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-none-match': etag ?? '' },
      body: JSON.stringify({ title: 'Original title' }),
    });

    expect(putRes.status).toBe(200);
    const putJson = await readJson(putRes);
    if (!isCmsPage(putJson)) {
      throw new Error('expected a CMS page in the put response');
    }
    expect(putJson.title).toBe('Original title');
    expect(putJson.id).toBe(page.id);
  });
});

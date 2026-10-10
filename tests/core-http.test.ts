import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { coreBaseUrl, coreFetch } from '../packages/domain/core-http.ts';

test('core base rejects external hosts, credentials, alternate protocols and URL suffixes', () => {
  for (const url of ['https://evil.example', 'http://core.evil:3000', 'http://core:4000', 'http://user:pass@localhost:3000',
    'https://localhost:3000', 'http://localhost:3000/path', 'http://localhost:3000?x=1', 'http://localhost:3000#x']) {
    assert.throws(() => coreBaseUrl(url), url);
  }
  assert.equal(coreBaseUrl('http://core:3000/'), 'http://core:3000');
  assert.equal(coreBaseUrl('http://[::1]:3000'), 'http://[::1]:3000');
  assert.throws(() => coreFetch('http://evil.example', { headers: { Authorization: 'Bearer test' } }));
});

test('core HTTP refuses even same-origin redirects with credentials', async () => {
  let leaked = false;
  const server = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(307, { Location: '/unexpected' }); res.end(); }
    else { leaked = true; res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    await assert.rejects(coreFetch(`http://127.0.0.1:${address.port}/redirect`, {
      headers: { Authorization: 'Bearer test' }, redirect: 'follow'
    }));
    assert.equal(leaked, false);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

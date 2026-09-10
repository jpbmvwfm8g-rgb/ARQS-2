'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');

const PORT = 3217;
const HOST = '127.0.0.1';
const BASE_ENV = { ...process.env, PORT: String(PORT) };

function request(pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port: PORT, path: pathname, method }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForServer(child) {
  const deadline = Date.now() + 10000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited before QA began (code ${child.exitCode})`);
    try {
      const health = await request('/healthz');
      if (health.status === 200) return health;
      lastError = new Error(`healthz returned ${health.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw lastError || new Error('server did not become ready');
}

function assertPrivateHtml(name, body) {
  assert.match(body, /<meta\s+name="robots"\s+content="noindex,nofollow"/i, `${name}: robots fail-closed control missing`);
  assert.match(body, /<body\s+data-public-live="false"/i, `${name}: public-live flag must remain false`);
  assert.match(body, /disabled/i, `${name}: expected disabled release-control action missing`);
  assert.doesNotMatch(body, /href=["'][^"']*drive\.google\.com/i, `${name}: internal Drive link exposed`);
  assert.doesNotMatch(body, /href=["'][^"']*docs\.google\.com/i, `${name}: internal Docs link exposed`);
  assert.doesNotMatch(body, /stripe\.com|client_secret|api[_-]?key|bearer\s+[a-z0-9._-]+/i, `${name}: payment/credential material exposed`);
}

(async () => {
  const child = spawn(process.execPath, ['server.cjs'], { env: BASE_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });

  try {
    const health = await waitForServer(child);
    const healthJson = JSON.parse(health.body);
    assert.equal(healthJson.status, 'ok');
    assert.equal(healthJson.service, 'arqs-web');

    const manifestResponse = await request('/press/storefront-manifest.json');
    assert.equal(manifestResponse.status, 200);
    assert.match(String(manifestResponse.headers['content-type']), /^application\/json/i);
    const manifest = JSON.parse(manifestResponse.body);
    assert.equal(manifest.state, 'PRIVATE_STAGING');
    assert.equal(manifest.website_ready, true);
    assert.equal(manifest.public_live, false);
    assert.equal(manifest.checkout_enabled, false);
    assert.equal(manifest.founder_authorization_required, true);
    assert.equal(manifest.currency, 'CAD');
    assert.equal(manifest.products.length, 3);
    assert.deepEqual(Object.values(manifest.release_controls), [false, false, false, false, false, false]);

    const skuSet = new Set(manifest.products.map(product => product.sku));
    assert.equal(skuSet.size, manifest.products.length, 'duplicate storefront SKU');
    const pathSet = new Set(manifest.products.map(product => product.detail_path));
    assert.equal(pathSet.size, manifest.products.length, 'duplicate product detail path');

    const expected = new Map([
      ['/press', 'ARQS Press — Private Storefront Staging'],
      ['/press/how-whales-talk', 'How Whales Talk'],
      ['/press/shark-signals', 'Shark Signals'],
      ['/press/ocean-science-starter-bundle', 'Ocean Science Starter Bundle']
    ]);

    for (const [pathname, marker] of expected) {
      const response = await request(pathname);
      assert.equal(response.status, 200, `${pathname}: expected HTTP 200`);
      assert.match(String(response.headers['content-type']), /^text\/html/i, `${pathname}: expected HTML content type`);
      assert.match(response.body, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `${pathname}: expected product marker missing`);
      assertPrivateHtml(pathname, response.body);

      const head = await request(pathname, 'HEAD');
      assert.equal(head.status, 200, `${pathname}: HEAD expected HTTP 200`);
      assert.equal(head.body, '', `${pathname}: HEAD response body must be empty`);
    }

    for (const product of manifest.products) {
      assert.ok(expected.has(product.detail_path), `${product.sku}: manifest detail path is not routed by runtime QA`);
      assert.match(product.publication_state, /^WEBSITE_READY_PRIVATE_STAGING$/, `${product.sku}: publication state drift`);
      assert.ok(product.price_hypothesis > 0, `${product.sku}: price hypothesis must be positive`);
      assert.ok(product.authors.includes('E.H. Ackerman') && product.authors.includes('J.D. Ackerman'), `${product.sku}: author lock drift`);
    }

    const bundle = manifest.products.find(product => product.sku === 'ARQS-SF-OCN-BDL-001');
    assert.ok(bundle, 'bundle SKU missing');
    assert.deepEqual(bundle.component_skus, ['ARQS-SF-OCN-001', 'ARQS-SF-OCN-002']);
    for (const componentSku of bundle.component_skus) assert.ok(skuSet.has(componentSku), `bundle component ${componentSku} missing`);

    const missing = await request('/press/definitely-not-a-product');
    assert.equal(missing.status, 404, 'unknown storefront route must fail with 404');

    const post = await request('/press', 'POST');
    assert.equal(post.status, 405, 'non-GET/HEAD storefront request must fail with 405');
    assert.equal(post.headers.allow, 'GET, HEAD');

    console.log('ARQS PRESS STAGING RUNTIME QA: PASS');
    console.log(`Release state: ${healthJson.release}`);
    console.log('Verified: healthz, catalogue, 3 product routes, manifest controls, HEAD, 404, 405, author lock, bundle references, fail-closed privacy/payment controls.');
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  }
})().catch(error => {
  console.error('ARQS PRESS STAGING RUNTIME QA: FAIL');
  console.error(error.stack || error.message || error);
  process.exit(1);
});

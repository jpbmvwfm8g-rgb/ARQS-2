'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.join(__dirname, 'site');
const ART = require('./site/assets/approved-artwork.json');
const FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/about.html', ['about.html', 'text/html; charset=utf-8']],
  ['/assets/styles.css', ['assets/styles.css', 'text/css; charset=utf-8']],
  ['/assets/app.js', ['assets/app.js', 'text/javascript; charset=utf-8']],
  ['/assets/sentinel-mark.svg', ['assets/sentinel-mark.svg', 'image/svg+xml']]
]);
let artwork = null;
let pendingArtwork = null;
function verifyArtwork(bytes) {
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== ART.bytes || digest !== ART.sha256) throw new Error('Approved artwork integrity check failed.');
  return bytes;
}
async function getArtwork() {
  if (artwork) return artwork;
  if (pendingArtwork) return pendingArtwork;
  pendingArtwork = (async () => {
    const assetPath = path.join(ROOT, 'assets', 'approved-landing.jpg');
    try { return (artwork = verifyArtwork(await fs.readFile(assetPath))); }
    catch (error) { if (error.code !== 'ENOENT') console.warn('Local artwork unavailable or invalid:', error.message); }
    const response = await fetch(ART.source_url, {redirect: 'follow', signal: AbortSignal.timeout(20000)});
    if (!response.ok || !response.body) throw new Error(`Artwork source returned HTTP ${response.status}.`);
    const chunks = [];
    let count = 0;
    for await (const chunk of response.body) {
      count += chunk.length;
      if (count > ART.bytes) throw new Error('Artwork source exceeded its approved size.');
      chunks.push(Buffer.from(chunk));
    }
    artwork = verifyArtwork(Buffer.concat(chunks));
    try {
      await fs.writeFile(assetPath + '.tmp', artwork);
      await fs.rename(assetPath + '.tmp', assetPath);
    } catch (error) { console.warn('Artwork verified; disk cache unavailable:', error.code); }
    return artwork;
  })();
  try { return await pendingArtwork; }
  finally { pendingArtwork = null; }
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, {'Allow': 'GET, HEAD'}); return res.end('Method not allowed.');
  }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.statusCode = 400; return res.end('Invalid request path.'); }
  if (pathname === '/healthz') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    const content = JSON.stringify({status: 'ok', service: 'arqs-web', build: ART.version, artworkVerified: Boolean(artwork)});
    return res.end(req.method === 'HEAD' ? undefined : content);
  }
  try {
    if (pathname === '/assets/approved-landing.jpg') {
      const bytes = await getArtwork();
      const etag = '"' + ART.sha256 + '"';
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('ETag', etag);
      if (req.headers['if-none-match'] === etag) { res.statusCode = 304; return res.end(); }
      res.setHeader('Content-Length', bytes.length);
      return res.end(req.method === 'HEAD' ? undefined : bytes);
    }
    const file = FILES.get(pathname);
    if (!file) { res.statusCode = 404; return res.end('Page not found.'); }
    const content = await fs.readFile(path.join(ROOT, file[0]));
    res.setHeader('Content-Type', file[1]);
    res.setHeader('Cache-Control', file[1].startsWith('text/html') ? 'no-cache' : 'public, max-age=3600');
    return res.end(req.method === 'HEAD' ? undefined : content);
  } catch (error) {
    console.error('ARQS request failed:', pathname, error.message);
    res.statusCode = pathname === '/assets/approved-landing.jpg' ? 503 : 500;
    res.setHeader('Cache-Control', 'no-store');
    return res.end('This resource is temporarily unavailable.');
  }
});
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('PORT must be an integer from 1 to 65535.'); process.exit(1); }
server.on('error', error => {console.error('ARQS server could not start:', error.code); process.exit(1);});
server.listen(port, '0.0.0.0', () => {
  console.log(`ARQS ${ART.version} listening on port ${port}`);
  getArtwork().catch(error => console.error('Artwork preload failed:', error.message));
});

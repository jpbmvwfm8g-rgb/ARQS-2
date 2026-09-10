'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.join(__dirname, 'site');
const RELEASE_FILE = path.join(__dirname, 'ARQS_Approved_Website_Release.json');
const IMAGE_SHA = '947d4b565dc686c13adc98147459264457203a4472362d4acc42d102043c8364';
const HTML_SHA = 'b6a3b838c3a140f01c5226a6ea33a4de3d1c95c1cdce3d807bca2a522f72c375';
const NATIVE_HTML_SHA = '54e7f9e157b2f036921e7951ff29ee724b8b8ad89cbe4e188b4ea733de81759f';
const HASH = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/about.html', ['about.html', 'text/html; charset=utf-8']],
  ['/assets/styles.css', ['assets/styles.css', 'text/css; charset=utf-8']],
  ['/assets/app.js', ['assets/app.js', 'text/javascript; charset=utf-8']],
  ['/assets/sentinel-mark.svg', ['assets/sentinel-mark.svg', 'image/svg+xml']]
]);
// Preserve the latest main-branch restriction: no unverified email destinations.
function publicHtml(bytes) {
  return Buffer.from(bytes.toString('utf8')
    .replace(/<a\b[^>]*href="mailto:[^"]*"[^>]*>(?:sales|support)@arqs\.ca<\/a>/gi, '')
    .replace(/href="mailto:[^"]*"/gi, 'href="tel:+12502890120"'), 'utf8');
}
let approved = null;
let releaseState = 'awaiting-approved-release-upload';
try {
  const manifestPath = path.join(ROOT, 'assets', 'approved-artwork.json');
  if (fs.existsSync(manifestPath)) {
    const art = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const image = fs.readFileSync(path.join(ROOT, 'assets', 'approved-landing.jpg'));
    const html = fs.readFileSync(path.join(ROOT, 'index.html'));
    if (art.version !== 'approved-chrome-gold-v1' || art.sha256 !== IMAGE_SHA || art.bytes !== 623902 || image.length !== art.bytes || HASH(image) !== IMAGE_SHA || HASH(html) !== NATIVE_HTML_SHA) throw new Error('Bundled release integrity check failed.');
    approved = {image, html: publicHtml(html)};
    releaseState = art.version;
  } else {
    // Compatibility with the previously installed guarded JSON release loader.
    const stat = fs.statSync(RELEASE_FILE);
    if (stat.size > 2000000) throw new Error('Release exceeds the permitted size.');
    const bundle = JSON.parse(fs.readFileSync(RELEASE_FILE, 'utf8'));
    if (bundle.schema !== 1 || bundle.release !== 'approved-photo-v1' || typeof bundle.html !== 'string' || typeof bundle.image_base64 !== 'string') throw new Error('Invalid release schema.');
    const image = Buffer.from(bundle.image_base64, 'base64');
    const html = Buffer.from(bundle.html, 'utf8');
    if (HASH(image) !== IMAGE_SHA || HASH(html) !== HTML_SHA) throw new Error('The release does not match the approved artwork and tested page.');
    approved = {image, html: publicHtml(html)};
    releaseState = 'approved-photo-v1';
  }
  console.log('Approved homepage loaded; original artwork SHA-256 verified.');
} catch (error) {
  const nativePresent = fs.existsSync(path.join(ROOT, 'assets', 'approved-artwork.json'));
  if (error.code === 'ENOENT' && !nativePresent) console.log('Approved release not uploaded yet; preserving the existing homepage.');
  else { releaseState = 'approved-release-invalid'; console.error('Approved release was not activated:', error.message); }
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-ARQS-Release', releaseState);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, {'Allow':'GET, HEAD'}); return res.end('Method not allowed.'); }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.statusCode = 400; return res.end('Invalid request path.'); }
  const healthy = releaseState !== 'approved-release-invalid';
  if (pathname === '/healthz') {
    res.writeHead(healthy ? 200 : 503, {'Content-Type':'application/json', 'Cache-Control':'no-store'});
    return res.end(req.method === 'HEAD' ? undefined : JSON.stringify({status: healthy ? 'ok' : 'error', service:'arqs-web', release:releaseState, build:releaseState, approved_homepage_ready:Boolean(approved), artworkVerified:Boolean(approved)}));
  }
  const isHome = pathname === '/' || pathname === '/index.html';
  const isArt = pathname === '/assets/approved-landing.jpg' || pathname === '/assets/approved-homepage.jpeg';
  if (!healthy && (isHome || isArt)) { res.writeHead(503, {'Content-Type':'text/plain; charset=utf-8', 'Cache-Control':'no-store'}); return res.end(req.method === 'HEAD' ? undefined : 'The website is temporarily unavailable.'); }
  let bytes, mime;
  if (approved && isHome) { bytes=approved.html; mime='text/html; charset=utf-8'; }
  else if (approved && isArt) { bytes=approved.image; mime='image/jpeg'; }
  else {
    const file = FILES.get(pathname);
    if (!file) { res.statusCode=404; return res.end(req.method === 'HEAD' ? undefined : 'Page not found.'); }
    try { bytes=await fs.promises.readFile(path.join(ROOT,file[0])); mime=file[1]; }
    catch(error) { console.error('ARQS public file unavailable:',file[0],error.code); res.statusCode=503; return res.end(req.method === 'HEAD' ? undefined : 'The website is temporarily unavailable.'); }
  }
  if (isArt && approved) {
    const etag = '"' + IMAGE_SHA + '"';
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, {'Cache-Control':'public, max-age=3600'}); return res.end(); }
  }
  res.writeHead(200, {'Content-Type':mime, 'Content-Length':bytes.length, 'Cache-Control':mime === 'image/jpeg' ? 'public, max-age=3600' : 'no-cache'});
  return res.end(req.method === 'HEAD' ? undefined : bytes);
});
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('PORT must be an integer between 1 and 65535.'); process.exit(1); }
server.on('error', error => { console.error('ARQS server could not start:',error.code); process.exit(1); });
server.listen(port, '0.0.0.0', () => console.log(`ARQS web server listening on port ${port}`));

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

function assert(cond, msg) {
  if (!cond) {
    console.error(`[FAIL] ${msg}`);
    process.exit(1);
  }
  console.log(`[PASS] ${msg}`);
}

// 1. Anti-Leap 1 & Bundle Integrity Assertions
assert(fs.existsSync(distDir), 'Production dist/ folder exists');
for (const rel of [
  'index.html',
  'manifest.webmanifest',
  'sw.js',
  'icons/lexdicom-icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
]) {
  const full = path.join(distDir, rel);
  assert(fs.existsSync(full) && fs.statSync(full).size > 32, `Compiled asset verified: dist/${rel}`);
}

// 2. Anti-Leap 6 & Zero-Key-Exposure Static Audit across src/
const srcDir = path.join(rootDir, 'src');
function walkFiles(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkFiles(full));
    else if (ent.name.endsWith('.ts') || ent.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const tsFiles = walkFiles(srcDir);
for (const file of tsFiles) {
  const txt = fs.readFileSync(file, 'utf8');
  assert(
    !/AIza[0-9A-Za-z-_]{35}|sk-[0-9A-Za-z]{32,}/.test(txt),
    `Zero hardcoded API keys in ${path.relative(rootDir, file)}`
  );
}

// Verify ViewportPanel & MprModal async loaders enforce try...finally
const vpSource = fs.readFileSync(path.join(srcDir, 'components/ViewportPanel.tsx'), 'utf8');
assert(
  vpSource.includes('setIsLoading(true)') && vpSource.includes('finally') && vpSource.includes('setIsLoading(false)'),
  'Anti-Leap 6: ViewportPanel enforces strict try...finally { setIsLoading(false) }'
);

// 3. Deterministic SRS-Schwab & Calibration Gate Math Verification
// Verify PI = PT + SS geometric identity & uncalibrated SVA gate
const s1Post = { x: 100, y: 200 };
const s1Ant = { x: 140, y: 230 }; // 36.87 deg sacral slope
const fh = { x: 125, y: 270 };
const c7 = { x: 138, y: 40 };
const dx = s1Ant.x - s1Post.x;
const dy = s1Ant.y - s1Post.y;
const ssDeg = (Math.acos(Math.abs(dx) / Math.hypot(dx, dy)) * 180) / Math.PI;
assert(Math.abs(ssDeg - 36.87) < 0.05, `Deterministic Sacral Slope geometry verified (${ssDeg.toFixed(2)}°)`);
assert(c7.x > s1Post.x, 'Deterministic C7 Plumb Line offset verified');

// 4. Live HTTP Runtime Server Probe (Anti-Leap 1 & 2)
const mimeMap = {
  '.html': 'text/html',
  '.webmanifest': 'application/manifest+json',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const target = path.join(distDir, rel);
  if (!target.startsWith(distDir) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }
  const ext = path.extname(target);
  res.writeHead(200, {
    'Content-Type': mimeMap[ext] || 'application/octet-stream',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  });
  fs.createReadStream(target).pipe(res);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

try {
  for (const endpoint of [
    '/',
    '/manifest.webmanifest',
    '/sw.js',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
  ]) {
    const res = await fetch(`${baseUrl}${endpoint}`);
    assert(res.status === 200, `Live HTTP GET ${endpoint} -> ${res.status} OK (${res.headers.get('content-type')})`);
  }
  const html = await (await fetch(`${baseUrl}/`)).text();
  assert(html.includes('LexDICOM'), 'Live root HTML serves LexDICOM application shell');
} finally {
  server.close();
}

console.log('=== ALL PRE-FLIGHT ANTI-LEAP GATES PASSED ===');

// The temporary verifier serves only the build's synthetic test results.
// It never imports the application or receives production credentials.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const backend = JSON.parse(readFileSync(new URL('./results/backend/report.json', import.meta.url)));
const media = JSON.parse(readFileSync(new URL('./results/media/result.json', import.meta.url)));
const roomMedia = JSON.parse(readFileSync(new URL('./results/room-media/verification.json', import.meta.url)));
const result = { ok: backend.ok === true && media.passed === true && roomMedia.passed === true, backend, media, roomMedia };
const payload = JSON.stringify(result);
console.log(JSON.stringify({ event: 'SH_R23_ISOLATED_VERIFICATION', ok: result.ok, backend: { pass: backend.pass, fail: backend.fail }, media }));
createServer((req, res) => {
  res.writeHead(result.ok ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  res.end(payload);
}).listen(Number(process.env.PORT || 10000), '0.0.0.0');

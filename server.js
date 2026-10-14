const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const { scan } = require('./lib/scanner');
const { buildDocx } = require('./lib/docx');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const ID_RE = /^[a-f0-9]{16}$/;

app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
const INDEX = path.join(__dirname, 'public', 'index.html');
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const originOf = (req) => (process.env.SITE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

// Serves the SPA shell with page-specific <head> values (good link previews when sharing)
async function sendPage(req, res, report) {
  const origin = originOf(req);
  const page = report
    ? {
        title: `${report.host} scored ${report.overall}/100: SEO & GEO report | Beacon`,
        desc: `${report.modes.map((m) => m.toUpperCase()).join(' + ')} audit of ${report.host}. ${report.seo ? `SEO ${report.seo.score}/100. ` : ''}${report.geo ? `GEO ${report.geo.score}/100. ` : ''}See what to fix first.`,
        url: `${origin}/r/${report.id}`,
        robots: 'noindex, nofollow',
      }
    : {
        title: 'Beacon: free SEO & GEO audit for search and AI answer engines',
        desc: 'Scan any page for SEO and GEO (generative engine optimization). Get a score, a prioritised fix list, and a report you can share or download as Word.',
        url: `${origin}/`,
        robots: 'index, follow',
      };
  let html = await fs.readFile(INDEX, 'utf8');
  html = html.replace(/%%TITLE%%/g, esc(page.title)).replace(/%%DESC%%/g, esc(page.desc))
    .replace(/%%URL%%/g, esc(page.url)).replace(/%%ROBOTS%%/g, page.robots).replace(/%%ORIGIN%%/g, esc(origin));
  if (report) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.type('html').send(html);
}

app.get('/', (req, res) => sendPage(req, res, null));
app.get('/robots.txt', (req, res) => res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /r/\nDisallow: /api/\n\nSitemap: ${originOf(req)}/sitemap.xml\n`));
app.get('/sitemap.xml', (req, res) => res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${originOf(req)}/</loc></url></urlset>\n`));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Tiny in-memory rate limit: 6 scans / minute / IP
const hits = new Map();
function limiter(req, res, next) {
  const now = Date.now();
  const recent = (hits.get(req.ip) || []).filter((t) => now - t < 60_000);
  if (recent.length >= 6) return res.status(429).json({ error: 'Too many scans. Wait a minute and try again.' });
  recent.push(now);
  hits.set(req.ip, recent);
  next();
}

const reportPath = (id) => path.join(DATA_DIR, `${id}.json`);
async function loadReport(id) {
  if (!ID_RE.test(id)) return null;
  try { return JSON.parse(await fs.readFile(reportPath(id), 'utf8')); } catch { return null; }
}

app.post('/api/scan', limiter, async (req, res) => {
  const { url, modes } = req.body || {};
  const chosen = (Array.isArray(modes) ? modes : []).filter((m) => m === 'seo' || m === 'geo');
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'Enter a URL to scan.' });
  if (!chosen.length) return res.status(400).json({ error: 'Choose SEO, GEO, or both.' });
  try {
    const report = await scan(url, chosen);
    report.id = crypto.randomBytes(8).toString('hex');
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(reportPath(report.id), JSON.stringify(report));
    res.json(report);
  } catch (err) {
    const msg = err.name === 'TimeoutError' ? 'The site took too long to respond.' : err.message || 'Scan failed.';
    res.status(422).json({ error: msg });
  }
});

app.get('/api/reports/:id', async (req, res) => {
  const report = await loadReport(req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found.' });
  res.json(report);
});

app.get('/api/reports/:id/docx', async (req, res) => {
  const report = await loadReport(req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found.' });
  const buf = await buildDocx(report);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${report.host.replace(/[^a-z0-9.-]/gi, '_')}-seo-geo-report.docx"`);
  res.send(buf);
});

// Shareable report page (front-end loads the report by id)
app.get('/r/:id', async (req, res) => sendPage(req, res, await loadReport(req.params.id)));

app.listen(PORT, () => console.log(`Beacon running on http://localhost:${PORT}`));

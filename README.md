<div align="center">

# Beacon

**See how search engines and AI answer engines see your site.**

Free, self-hosted SEO + GEO audit dashboard. Paste a URL, get a score, a prioritised fix list, and a report you can share or download as Word.

![Node](https://img.shields.io/badge/node-%3E%3D18-3c873a) ![Express](https://img.shields.io/badge/express-4-000) ![License](https://img.shields.io/badge/license-MIT-blue)

![Beacon preview](public/og-image.png)

</div>

## What is GEO?

**GEO (Generative Engine Optimization)** is SEO for AI answers. Instead of ranking in a list of blue links, the goal is to be read, trusted and cited by ChatGPT, Claude, Perplexity, Google AI Overviews and similar tools. Beacon audits both: the classic signals that decide rankings, and the signals that decide whether an AI can access and quote your page.

## Features

- **One-field scan.** Enter a URL, choose SEO, GEO or both.
- **Scores and grades.** Overall, per mode and per category (A to F).
- **Fix these first.** Issues ranked by severity and weight, each with a concrete how-to-fix.
- **Shareable reports.** Every scan gets an unguessable link (`/r/<id>`) with its own social preview.
- **Export.** Download a formatted `.docx`, or print to PDF.
- **Recent scans** remembered in the browser. Dark mode, mobile friendly, keyboard accessible.
- **Safe fetching.** Private and internal addresses are blocked (SSRF guard), redirects are capped, and scans are rate limited.

## What it checks

| Mode | Category | Checks |
| --- | --- | --- |
| SEO | Content | Title, meta description, H1, heading order, content depth |
| SEO | Technical | HTTPS, indexability, canonical, viewport, language, robots.txt, sitemap, response time, compression, render-blocking scripts, structured data |
| SEO | Links & Media | Image alt text, internal links, anchor text |
| SEO | Social & Branding | Open Graph, Twitter/X card, favicon |
| GEO | AI Access | Rules for GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot, Google-Extended and more; `llms.txt`; content present in server HTML |
| GEO | Structured Data | Schema.org depth, Organization `sameAs`, FAQ markup |
| GEO | Content Structure | Question-style headings, answer-first intro, lists and tables, semantic HTML |
| GEO | Trust & Authority | Author attribution, trust pages, freshness dates, statistics and citations |

Scoring is weighted per check: pass = 1, warn = 0.5, fail = 0. These are heuristics for guidance, not a ranking guarantee.

## Quick start

```bash
git clone https://github.com/<you>/beacon.git
cd beacon
npm install
npm start
```

Open http://localhost:3000. Requires Node 18 or newer.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `SITE_URL` | request host | Public base URL used in canonical and social-preview tags (set this in production) |
| `ALLOW_PRIVATE` | unset | Set to `1` to allow scanning localhost/private IPs. **Development only.** |

## API

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/scan` | Body: `{ "url": "example.com", "modes": ["seo","geo"] }`. Returns the full report incl. `id`. |
| `GET` | `/api/reports/:id` | Report JSON |
| `GET` | `/api/reports/:id/docx` | Word download |
| `GET` | `/r/:id` | Shareable report page (`noindex`) |

```bash
curl -X POST localhost:3000/api/scan \
  -H 'content-type: application/json' \
  -d '{"url":"example.com","modes":["seo","geo"]}'
```

## Project structure

```
server.js          Express app, routes, per-page <head> injection
lib/scanner.js     Safe fetching and all SEO/GEO checks
lib/docx.js        Word report builder
public/index.html  Dashboard UI (no build step)
data/              Saved reports (JSON)
```

## Add your own check

In `lib/scanner.js`, add a line inside `seoChecks` or `geoChecks`:

```js
out.push(C('geo', 'Content Structure', 'tldr', 'TL;DR block', 'warn', 1,
  'No summary found.', 'Add a short summary at the top.'));
```

Arguments: `mode, category, id, title, status ('pass'|'warn'|'fail'), weight (1-3), detail, fix`.

## Deploying

- Set `SITE_URL` and run behind a reverse proxy (Nginx, Caddy) with HTTPS.
- Swap the in-memory rate limiter for Redis if you run more than one instance.
- Reports are plain files in `data/`. Mount it as a volume, or replace `loadReport` and the write in `server.js` with a database.
- Consider pinning resolved IPs per request to close DNS-rebinding gaps.

## Limitations

- Audits one page plus `robots.txt`, `sitemap.xml` and `llms.txt`.
- Reads raw HTML only (no JavaScript rendering). This is deliberate for GEO, since most AI crawlers do not run JS, but it can under-report on client-rendered sites.
- No Core Web Vitals yet.

## Roadmap

- [ ] Multi-page crawl from the sitemap
- [ ] Core Web Vitals via PageSpeed Insights
- [ ] Score history per domain
- [ ] Accounts and private reports
- [ ] AI-written rewrite suggestions (title, meta, FAQ)
- [ ] Competitor comparison

## Contributing

Issues and pull requests are welcome. Keep checks explainable: every check needs a plain-language finding and a specific fix.

## License

MIT

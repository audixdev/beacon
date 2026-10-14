const dns = require('dns/promises');
const net = require('net');
const cheerio = require('cheerio');

const UA = 'Mozilla/5.0 (compatible; BeaconScanner/1.0)';
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE === '1'; // dev/testing only

/* ---------- Safe fetching (SSRF protection) ---------- */

function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80')) return true;
    if (l.startsWith('::ffff:')) { const v4 = l.slice(7); return net.isIPv4(v4) ? isPrivateIp(v4) : true; }
    return false;
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

async function safeFetch(url, { timeout = 12000, maxRedirects = 5 } = {}) {
  let current = url;
  const start = Date.now();
  let hops = 0;
  for (;;) {
    const u = new URL(current);
    if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs are supported.');
    if (!ALLOW_PRIVATE) {
      const host = u.hostname.replace(/^\[|\]$/g, '');
      const addrs = await dns.lookup(host, { all: true }).catch(() => { throw new Error(`Could not resolve ${u.hostname}.`); });
      if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('That address is not publicly reachable.');
    }
    const res = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeout),
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,text/plain,*/*' },
    });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      if (++hops > maxRedirects) throw new Error('Too many redirects.');
      current = new URL(loc, current).href;
      continue;
    }
    const ttfb = Date.now() - start;
    const buf = Buffer.from(await res.arrayBuffer()).subarray(0, 3_000_000);
    return { status: res.status, headers: res.headers, body: buf.toString('utf8'), finalUrl: current, ms: Date.now() - start, ttfb, bytes: buf.length, hops };
  }
}

async function tryFetch(url) {
  try {
    const r = await safeFetch(url, { timeout: 6000, maxRedirects: 3 });
    return { ok: r.status === 200, status: r.status, body: r.body, type: r.headers.get('content-type') || '' };
  } catch { return { ok: false, status: 0, body: '', type: '' }; }
}

/* ---------- robots.txt ---------- */

function parseRobots(txt) {
  const groups = [];
  let cur = null, lastAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase(), v = line.slice(i + 1).trim();
    if (k === 'user-agent') {
      if (!cur || !lastAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(v.toLowerCase());
      lastAgent = true;
    } else if (k === 'disallow' || k === 'allow') {
      if (cur) cur.rules.push([k, v]);
      lastAgent = false;
    } else lastAgent = false;
  }
  return groups;
}

function botBlocked(groups, bot) {
  const g = groups.find((x) => x.agents.includes(bot.toLowerCase())) || groups.find((x) => x.agents.includes('*'));
  if (!g) return false;
  const dis = g.rules.some(([k, v]) => k === 'disallow' && v === '/');
  const allow = g.rules.some(([k, v]) => k === 'allow' && v === '/');
  return dis && !allow;
}

const AI_BOTS = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'CCBot'];

/* ---------- helpers ---------- */

const C = (mode, category, id, title, status, weight, detail, fix = '') => ({ mode, category, id, title, status, weight, detail, fix });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function collectJsonLd($) {
  const types = new Set(), sameAs = new Set(), dates = [];
  let hasAuthor = false;
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    [].concat(n['@type'] || []).forEach((t) => types.add(String(t)));
    [].concat(n.sameAs || []).forEach((s) => typeof s === 'string' && sameAs.add(s));
    if (n.author) hasAuthor = true;
    ['dateModified', 'datePublished'].forEach((k) => n[k] && dates.push(n[k]));
    Object.values(n).forEach(walk);
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    try { walk(JSON.parse($(el).contents().text())); } catch { /* ignore invalid blocks */ }
  });
  return { types: [...types], sameAs: [...sameAs], hasAuthor, dates };
}

function scoreOf(checks) {
  const val = { pass: 1, warn: 0.5, fail: 0 };
  const total = checks.reduce((s, c) => s + c.weight, 0);
  if (!total) return 0;
  return Math.round((checks.reduce((s, c) => s + c.weight * val[c.status], 0) / total) * 100);
}
const gradeOf = (s) => (s >= 90 ? 'A' : s >= 80 ? 'B' : s >= 65 ? 'C' : s >= 50 ? 'D' : 'F');

function section(checks) {
  const names = [...new Set(checks.map((c) => c.category))];
  const score = scoreOf(checks);
  return {
    score, grade: gradeOf(score), checks,
    counts: { pass: checks.filter((c) => c.status === 'pass').length, warn: checks.filter((c) => c.status === 'warn').length, fail: checks.filter((c) => c.status === 'fail').length },
    categories: names.map((name) => ({ name, score: scoreOf(checks.filter((c) => c.category === name)) })),
  };
}

/* ---------- SEO checks ---------- */

function seoChecks(x) {
  const { $, title, metaDesc, words, page, robotsOk, sitemapOk } = x;
  const out = [];
  const M = 'seo';

  // Content
  out.push(title.length === 0
    ? C(M, 'Content', 'title', 'Page title', 'fail', 3, 'No <title> tag found.', 'Add a unique, descriptive title of 30–60 characters with your main keyword near the start.')
    : title.length >= 30 && title.length <= 60
      ? C(M, 'Content', 'title', 'Page title', 'pass', 3, `Good length (${title.length} chars): “${title}”`)
      : C(M, 'Content', 'title', 'Page title', 'warn', 3, `${title.length} characters: “${title}”`, title.length < 30 ? 'Expand the title to 30–60 characters so it describes the page fully.' : 'Shorten the title to under 60 characters so it is not truncated in search results.'));

  out.push(!metaDesc
    ? C(M, 'Content', 'desc', 'Meta description', 'fail', 2, 'No meta description found.', 'Write a 70–160 character summary that makes people want to click.')
    : metaDesc.length >= 70 && metaDesc.length <= 160
      ? C(M, 'Content', 'desc', 'Meta description', 'pass', 2, `Good length (${metaDesc.length} chars).`)
      : C(M, 'Content', 'desc', 'Meta description', 'warn', 2, `${metaDesc.length} characters.`, 'Aim for 70–160 characters so it displays fully in search results.'));

  const h1s = $('h1');
  out.push(h1s.length === 1
    ? C(M, 'Content', 'h1', 'H1 heading', 'pass', 2, `One H1: “${h1s.first().text().trim().slice(0, 80)}”`)
    : h1s.length === 0
      ? C(M, 'Content', 'h1', 'H1 heading', 'fail', 2, 'No H1 found.', 'Add exactly one H1 that states what the page is about.')
      : C(M, 'Content', 'h1', 'H1 heading', 'warn', 2, `${h1s.length} H1 tags found.`, 'Use a single H1 and demote the others to H2 or H3.'));

  const levels = $('h1,h2,h3,h4,h5,h6').map((_, e) => +e.tagName[1]).get();
  const skips = levels.filter((l, i) => i > 0 && l - levels[i - 1] > 1).length;
  out.push(levels.filter((l) => l === 2).length === 0
    ? C(M, 'Content', 'hier', 'Heading structure', 'warn', 1, 'No H2 headings found.', 'Break content into sections with descriptive H2 headings.')
    : skips
      ? C(M, 'Content', 'hier', 'Heading structure', 'warn', 1, `${plural(skips, 'heading level skip')} (e.g. H2 → H4).`, 'Keep headings in order without skipping levels.')
      : C(M, 'Content', 'hier', 'Heading structure', 'pass', 1, `${plural(levels.length, 'heading')} in a logical order.`));

  out.push(words >= 600
    ? C(M, 'Content', 'len', 'Content depth', 'pass', 2, `${words} words of visible text.`)
    : words >= 300
      ? C(M, 'Content', 'len', 'Content depth', 'warn', 2, `${words} words — on the thin side.`, 'Expand the page with useful detail, examples and answers to related questions (aim for 600+ words for informational pages).')
      : C(M, 'Content', 'len', 'Content depth', 'fail', 2, `Only ${words} words of visible text.`, 'Add substantial, original content. Thin pages rarely rank. If the page is built with JavaScript, make sure the text is in the server HTML.'));

  // Technical
  const t = 'Technical';
  out.push(page.finalUrl.startsWith('https://')
    ? C(M, t, 'https', 'HTTPS', 'pass', 3, 'Page is served over HTTPS.')
    : C(M, t, 'https', 'HTTPS', 'fail', 3, 'Page is served over plain HTTP.', 'Install a TLS certificate and redirect all HTTP traffic to HTTPS.'));

  const robotsMeta = ($('meta[name="robots"]').attr('content') || '').toLowerCase();
  out.push(robotsMeta.includes('noindex')
    ? C(M, t, 'noindex', 'Indexability', 'fail', 3, 'Meta robots contains “noindex”. Search engines will not list this page.', 'Remove noindex from the meta robots tag if you want this page to appear in search.')
    : C(M, t, 'noindex', 'Indexability', 'pass', 3, 'Page is indexable.'));

  const canon = $('link[rel="canonical"]').attr('href');
  out.push(canon
    ? C(M, t, 'canon', 'Canonical URL', 'pass', 1, `Canonical: ${canon}`)
    : C(M, t, 'canon', 'Canonical URL', 'warn', 1, 'No canonical tag.', 'Add <link rel="canonical"> pointing to the preferred URL to avoid duplicate-content issues.'));

  out.push($('meta[name="viewport"]').length
    ? C(M, t, 'vp', 'Mobile viewport', 'pass', 2, 'Viewport meta tag present.')
    : C(M, t, 'vp', 'Mobile viewport', 'fail', 2, 'No viewport meta tag.', 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.'));

  const lang = $('html').attr('lang');
  out.push(lang
    ? C(M, t, 'lang', 'Language attribute', 'pass', 1, `lang="${lang}"`)
    : C(M, t, 'lang', 'Language attribute', 'warn', 1, 'No lang attribute on <html>.', 'Add lang="en" (or your language) to the <html> tag.'));

  out.push(robotsOk
    ? C(M, t, 'robots', 'robots.txt', 'pass', 1, 'robots.txt found.')
    : C(M, t, 'robots', 'robots.txt', 'warn', 1, 'No robots.txt found.', 'Create /robots.txt and reference your sitemap in it.'));
  out.push(sitemapOk
    ? C(M, t, 'sitemap', 'XML sitemap', 'pass', 2, 'Sitemap found.')
    : C(M, t, 'sitemap', 'XML sitemap', 'warn', 2, 'No sitemap found at /sitemap.xml or in robots.txt.', 'Publish an XML sitemap and submit it in Google Search Console.'));

  const speed = page.ttfb < 800 ? 'pass' : page.ttfb < 2000 ? 'warn' : 'fail';
  out.push(C(M, t, 'speed', 'Server response time', speed, 2, `${page.ttfb} ms to first byte and redirects.`, speed === 'pass' ? '' : 'Improve hosting, add caching or a CDN and cut redirects to get under 800 ms.'));

  const enc = page.headers.get('content-encoding');
  const kb = Math.round(page.bytes / 1024);
  out.push(!enc && page.bytes > 30000
    ? C(M, t, 'gzip', 'Compression & HTML size', 'warn', 1, `HTML is ${kb} KB and not compressed.`, 'Enable gzip or Brotli compression on your server.')
    : kb > 500
      ? C(M, t, 'gzip', 'Compression & HTML size', 'warn', 1, `HTML is large (${kb} KB).`, 'Trim inline scripts, styles and unneeded markup.')
      : C(M, t, 'gzip', 'Compression & HTML size', 'pass', 1, `HTML is ${kb} KB${enc ? ` (${enc})` : ''}.`));

  const blocking = $('head script[src]:not([async]):not([defer]):not([type="module"])').length;
  out.push(blocking > 3
    ? C(M, t, 'block', 'Render-blocking scripts', 'warn', 1, `${plural(blocking, 'blocking script')} in <head>.`, 'Add defer or async to scripts that are not needed for first paint.')
    : C(M, t, 'block', 'Render-blocking scripts', 'pass', 1, `${plural(blocking, 'blocking script')} in <head>.`));

  const sd = x.jsonld.types;
  out.push(sd.length
    ? C(M, t, 'schema', 'Structured data', 'pass', 2, `Found: ${sd.slice(0, 6).join(', ')}.`)
    : C(M, t, 'schema', 'Structured data', 'warn', 2, 'No JSON-LD structured data.', 'Add schema.org JSON-LD (Organization, Article, Product, FAQPage…) to qualify for rich results.'));

  // Links & media
  const l = 'Links & Media';
  const imgs = $('img');
  const noAlt = imgs.filter((_, e) => $(e).attr('alt') === undefined).length;
  out.push(!imgs.length
    ? C(M, l, 'alt', 'Image alt text', 'pass', 1, 'No images on the page.')
    : noAlt === 0
      ? C(M, l, 'alt', 'Image alt text', 'pass', 2, `All ${plural(imgs.length, 'image')} have alt attributes.`)
      : C(M, l, 'alt', 'Image alt text', noAlt / imgs.length > 0.3 ? 'fail' : 'warn', 2, `${noAlt} of ${imgs.length} images are missing alt text.`, 'Describe every meaningful image in its alt attribute. Use alt="" for purely decorative ones.'));

  const host = new URL(page.finalUrl).hostname;
  let internal = 0, external = 0;
  $('a[href]').each((_, e) => {
    try {
      const u = new URL($(e).attr('href'), page.finalUrl);
      if (!/^https?:$/.test(u.protocol)) return;
      u.hostname === host ? internal++ : external++;
    } catch { /* ignore */ }
  });
  x.linkCounts = { internal, external };
  out.push(internal >= 5
    ? C(M, l, 'int', 'Internal links', 'pass', 1, `${internal} internal links.`)
    : C(M, l, 'int', 'Internal links', 'warn', 1, `Only ${internal} internal links.`, 'Link to related pages on your site with descriptive anchor text.'));

  const generic = $('a').filter((_, e) => /^(click here|read more|here|more|learn more)$/i.test($(e).text().trim())).length;
  out.push(generic > 2
    ? C(M, l, 'anchor', 'Anchor text', 'warn', 1, `${generic} links use generic text like “read more”.`, 'Replace generic anchors with text that describes the destination.')
    : C(M, l, 'anchor', 'Anchor text', 'pass', 1, 'Anchor text looks descriptive.'));

  // Social
  const s = 'Social & Branding';
  const og = ['og:title', 'og:description', 'og:image'].filter((p) => $(`meta[property="${p}"]`).length);
  out.push(og.length === 3
    ? C(M, s, 'og', 'Open Graph tags', 'pass', 1, 'og:title, og:description and og:image present.')
    : C(M, s, 'og', 'Open Graph tags', og.length ? 'warn' : 'fail', 1, `Missing: ${['og:title', 'og:description', 'og:image'].filter((p) => !og.includes(p)).join(', ')}.`, 'Add Open Graph tags so links look good when shared.'));
  out.push($('meta[name="twitter:card"]').length
    ? C(M, s, 'tw', 'Twitter/X card', 'pass', 1, 'twitter:card present.')
    : C(M, s, 'tw', 'Twitter/X card', 'warn', 1, 'No twitter:card meta tag.', 'Add <meta name="twitter:card" content="summary_large_image">.'));
  out.push($('link[rel~="icon"]').length
    ? C(M, s, 'fav', 'Favicon', 'pass', 1, 'Favicon declared.')
    : C(M, s, 'fav', 'Favicon', 'warn', 1, 'No favicon link found.', 'Add a favicon so your brand shows in tabs and search results.'));

  return out;
}

/* ---------- GEO checks ---------- */

function geoChecks(x) {
  const { $, words, page, jsonld, llms, robotsGroups, robotsOk } = x;
  const out = [];
  const M = 'geo';

  // AI Access
  const a = 'AI Access';
  if (!robotsOk) {
    out.push(C(M, a, 'bots', 'AI crawler access', 'pass', 3, 'No robots.txt, so AI crawlers are not restricted.', 'Add a robots.txt that explicitly allows the AI crawlers you want (GPTBot, ClaudeBot, PerplexityBot, OAI-SearchBot).'));
  } else {
    const blocked = AI_BOTS.filter((b) => botBlocked(robotsGroups, b));
    const searchBots = ['OAI-SearchBot', 'PerplexityBot', 'ClaudeBot', 'GPTBot'];
    const searchBlocked = searchBots.filter((b) => blocked.includes(b));
    out.push(blocked.length === 0
      ? C(M, a, 'bots', 'AI crawler access', 'pass', 3, `None of ${AI_BOTS.length} known AI crawlers are blocked.`)
      : searchBlocked.length >= 3
        ? C(M, a, 'bots', 'AI crawler access', 'fail', 3, `Blocked: ${blocked.join(', ')}. AI answer engines cannot read or cite this site.`, 'Remove the Disallow rules for AI search crawlers (OAI-SearchBot, PerplexityBot, ClaudeBot) if you want to be cited in AI answers.')
        : C(M, a, 'bots', 'AI crawler access', 'warn', 3, `Blocked: ${blocked.join(', ')}.`, 'Blocking training-only bots is a valid choice, but make sure search/answer bots (OAI-SearchBot, PerplexityBot) stay allowed.'));
  }

  out.push(llms.ok && !llms.type.includes('html') && llms.body.trim().length > 20
    ? C(M, a, 'llms', 'llms.txt file', 'pass', 1, `/llms.txt found (${llms.body.length} chars).`)
    : C(M, a, 'llms', 'llms.txt file', 'warn', 1, 'No /llms.txt found.', 'Add /llms.txt: a markdown summary of your site and links to key pages. It is an emerging standard that helps LLMs understand your site.'));

  const textLen = words;
  const scripts = $('script').length;
  out.push(textLen >= 200
    ? C(M, a, 'ssr', 'Content in server HTML', 'pass', 3, `${textLen} words readable without running JavaScript.`)
    : C(M, a, 'ssr', 'Content in server HTML', scripts > 5 ? 'fail' : 'warn', 3, `Only ${textLen} words in the raw HTML${scripts > 5 ? ` and ${scripts} scripts` : ''}. Page may rely on client-side rendering.`, 'Most AI crawlers do not run JavaScript. Use server-side rendering or pre-rendering so your content is in the initial HTML.'));

  // Structured Data
  const d = 'Structured Data';
  const valuable = ['Organization', 'WebSite', 'WebPage', 'Article', 'BlogPosting', 'NewsArticle', 'FAQPage', 'HowTo', 'Product', 'LocalBusiness', 'Person', 'BreadcrumbList', 'Review', 'Service', 'SoftwareApplication', 'Course', 'Event', 'VideoObject'];
  const found = jsonld.types.filter((t) => valuable.includes(t));
  out.push(found.length >= 3
    ? C(M, d, 'schema', 'Schema.org markup', 'pass', 3, `Rich markup: ${found.join(', ')}.`)
    : found.length
      ? C(M, d, 'schema', 'Schema.org markup', 'warn', 3, `Only: ${found.join(', ')}.`, 'Layer more schema types (Organization, WebSite, Article/Product, FAQPage, BreadcrumbList). Structured data helps AI systems extract facts reliably.')
      : C(M, d, 'schema', 'Schema.org markup', 'fail', 3, 'No useful JSON-LD schema found.', 'Add JSON-LD describing your organization and the page’s main entity.'));

  const hasOrg = jsonld.types.some((t) => ['Organization', 'LocalBusiness', 'Person', 'Corporation'].includes(t));
  out.push(hasOrg && jsonld.sameAs.length >= 2
    ? C(M, d, 'entity', 'Entity identity (sameAs)', 'pass', 2, `Organization linked to ${plural(jsonld.sameAs.length, 'profile')}.`)
    : C(M, d, 'entity', 'Entity identity (sameAs)', hasOrg ? 'warn' : 'fail', 2, hasOrg ? 'Organization schema has fewer than 2 sameAs links.' : 'No Organization/Person schema.', 'Add Organization schema with sameAs links to your LinkedIn, Wikipedia, Wikidata, X, YouTube etc. This helps AI models recognise you as one entity.'));

  const faqSchema = jsonld.types.includes('FAQPage');
  out.push(faqSchema
    ? C(M, d, 'faqschema', 'FAQ markup', 'pass', 1, 'FAQPage schema present.')
    : C(M, d, 'faqschema', 'FAQ markup', 'warn', 1, 'No FAQPage schema.', 'If the page has Q&A content, mark it up with FAQPage schema.'));

  // Content Structure
  const c = 'Content Structure';
  const qHeads = $('h1,h2,h3,h4').filter((_, e) => {
    const t = $(e).text().trim();
    return /\?$/.test(t) || /^(what|how|why|when|where|who|which|can|does|do|is|are|should|will)\b/i.test(t);
  }).length;
  out.push(qHeads >= 3
    ? C(M, c, 'qa', 'Question-style headings', 'pass', 2, `${plural(qHeads, 'heading')} phrased as questions.`)
    : C(M, c, 'qa', 'Question-style headings', qHeads ? 'warn' : 'fail', 2, `${plural(qHeads, 'question heading')}.`, 'Phrase some headings as the questions people ask (“How does X work?”) and answer directly underneath. This matches how users prompt AI.'));

  const first = $('main p, article p, body p').filter((_, e) => $(e).text().trim().split(/\s+/).length > 8).first().text().trim();
  const fw = first ? first.split(/\s+/).length : 0;
  out.push(fw >= 20 && fw <= 80
    ? C(M, c, 'answer', 'Answer-first intro', 'pass', 1, `Opening paragraph is ${fw} words — concise and quotable.`)
    : C(M, c, 'answer', 'Answer-first intro', 'warn', 1, fw ? `Opening paragraph is ${fw} words.` : 'No clear opening paragraph.', 'Start with a 20–80 word paragraph that answers the main question or summarises the page.'));

  const lists = $('ul,ol').length, tables = $('table').length, dl = $('dl').length;
  const paraLens = $('p').map((_, e) => $(e).text().trim().split(/\s+/).length).get().filter((n) => n > 3);
  const avgPara = paraLens.length ? Math.round(paraLens.reduce((s, n) => s + n, 0) / paraLens.length) : 0;
  const pts = (lists >= 2) + (tables + dl >= 1) + (avgPara > 0 && avgPara <= 80);
  out.push(pts >= 2
    ? C(M, c, 'struct', 'Scannable formatting', 'pass', 2, `${plural(lists, 'list')}, ${plural(tables, 'table')}, average paragraph ${avgPara} words.`)
    : C(M, c, 'struct', 'Scannable formatting', pts === 1 ? 'warn' : 'fail', 2, `${plural(lists, 'list')}, ${plural(tables, 'table')}, average paragraph ${avgPara} words.`, 'Use short paragraphs, bullet lists and comparison tables. AI models lift structured passages more easily than walls of text.'));

  const semantic = ['main', 'article', 'section', 'header', 'nav'].filter((t) => $(t).length);
  out.push(semantic.length >= 3
    ? C(M, c, 'sem', 'Semantic HTML', 'pass', 1, `Uses ${semantic.map((t) => `<${t}>`).join(', ')}.`)
    : C(M, c, 'sem', 'Semantic HTML', 'warn', 1, `Uses ${semantic.length ? semantic.map((t) => `<${t}>`).join(', ') : 'no semantic landmarks'}.`, 'Wrap content in <main>, <article>, <section>, <header> and <nav> so machines can tell content from chrome.'));

  // Trust & Authority
  const t = 'Trust & Authority';
  const authorSignal = $('meta[name="author"], [rel="author"], [itemprop="author"], .author, .byline, [class*="author"]').length > 0 || jsonld.hasAuthor;
  out.push(authorSignal
    ? C(M, t, 'author', 'Author attribution', 'pass', 2, 'Author or byline signal found.')
    : C(M, t, 'author', 'Author attribution', 'warn', 2, 'No author or byline detected.', 'Show who wrote the content, with credentials and a bio link, and mark it up with author schema. AI engines favour attributable expertise.'));

  const hrefs = $('a[href]').map((_, e) => ($(e).attr('href') || '').toLowerCase()).get().join(' ');
  const trust = ['about', 'contact', 'privacy', 'terms'].filter((k) => hrefs.includes(k));
  out.push(trust.length >= 3
    ? C(M, t, 'trust', 'Trust pages', 'pass', 1, `Links to: ${trust.join(', ')}.`)
    : C(M, t, 'trust', 'Trust pages', 'warn', 1, trust.length ? `Only links to: ${trust.join(', ')}.` : 'No links to about, contact, privacy or terms pages.', 'Link clearly to About, Contact, Privacy and Terms pages to establish who is behind the site.'));

  const dates = [...jsonld.dates, ...$('meta[property="article:modified_time"], meta[property="article:published_time"], meta[itemprop="dateModified"]').map((_, e) => $(e).attr('content')).get(), ...$('time[datetime]').map((_, e) => $(e).attr('datetime')).get()]
    .map((v) => new Date(v)).filter((v) => !isNaN(v));
  if (!dates.length) {
    out.push(C(M, t, 'fresh', 'Freshness signals', 'warn', 2, 'No publish or modified date found.', 'Show visible dates and add datePublished / dateModified in schema. AI engines prefer recent, dated content.'));
  } else {
    const days = Math.round((Date.now() - Math.max(...dates)) / 864e5);
    out.push(days <= 365
      ? C(M, t, 'fresh', 'Freshness signals', 'pass', 2, `Most recent date is ${days} days old.`)
      : C(M, t, 'fresh', 'Freshness signals', 'warn', 2, `Most recent date is ${Math.round(days / 365 * 10) / 10} years old.`, 'Review and refresh the content, then update the modified date.'));
  }

  const stats = (x.text.match(/\b\d[\d,.]*\s?(%|percent|million|billion|k\b)/gi) || []).length;
  const ext = x.linkCounts.external;
  out.push(ext >= 2 && stats >= 2
    ? C(M, t, 'cite', 'Data & citations', 'pass', 2, `${plural(stats, 'statistic')} and ${plural(ext, 'outbound link')}.`)
    : C(M, t, 'cite', 'Data & citations', ext || stats ? 'warn' : 'fail', 2, `${plural(stats, 'statistic')} and ${plural(ext, 'outbound link')}.`, 'Back claims with specific numbers and link to authoritative sources. Content with sourced facts is more likely to be cited by AI.'));

  return out;
}

/* ---------- Main ---------- */

async function scan(rawUrl, modes) {
  let input = rawUrl.trim();
  if (!/^https?:\/\//i.test(input)) input = `https://${input}`;
  let u;
  try { u = new URL(input); } catch { throw new Error('That does not look like a valid URL.'); }
  if (!u.hostname.includes('.') && !ALLOW_PRIVATE) throw new Error('That does not look like a valid domain.');

  const page = await safeFetch(u.href);
  if (page.status >= 400) throw new Error(`The site returned HTTP ${page.status}.`);
  if (!(page.headers.get('content-type') || '').includes('html')) throw new Error('That URL did not return an HTML page.');

  const $ = cheerio.load(page.body);
  const origin = new URL(page.finalUrl).origin;
  const [robots, sitemap, llms] = await Promise.all([
    tryFetch(`${origin}/robots.txt`), tryFetch(`${origin}/sitemap.xml`), tryFetch(`${origin}/llms.txt`),
  ]);
  const robotsOk = robots.ok && !robots.type.includes('html');
  const robotsGroups = robotsOk ? parseRobots(robots.body) : [];
  const sitemapOk = (sitemap.ok && /<urlset|<sitemapindex/i.test(sitemap.body)) || (robotsOk && /^sitemap:/im.test(robots.body));

  const $t = cheerio.load(page.body);
  $t('script,style,noscript,svg,template').remove();
  const text = $t('body').text().replace(/\s+/g, ' ').trim();
  const words = text ? text.split(' ').length : 0;

  const x = {
    $, page, text, words, llms, robotsOk, robotsGroups, sitemapOk,
    title: $('title').first().text().trim(),
    metaDesc: ($('meta[name="description"]').attr('content') || '').trim(),
    jsonld: collectJsonLd($),
    linkCounts: { internal: 0, external: 0 },
  };

  // SEO runs first because it computes link counts that GEO reuses.
  const seoList = seoChecks(x);
  const geoList = geoChecks(x);
  const seo = modes.includes('seo') ? section(seoList) : null;
  const geo = modes.includes('geo') ? section(geoList) : null;
  const scores = [seo, geo].filter(Boolean).map((s) => s.score);
  const overall = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);

  const order = { fail: 0, warn: 1 };
  const priorities = [...(seo?.checks || []), ...(geo?.checks || [])]
    .filter((c) => c.status !== 'pass')
    .sort((a, b) => order[a.status] - order[b.status] || b.weight - a.weight)
    .slice(0, 8);

  return {
    url: input, finalUrl: page.finalUrl, host: new URL(page.finalUrl).hostname,
    scannedAt: new Date().toISOString(), modes,
    overall, grade: gradeOf(overall), seo, geo, priorities,
    snapshot: {
      title: x.title, description: x.metaDesc, words,
      loadMs: page.ttfb, sizeKb: Math.round(page.bytes / 1024),
      h1: $('h1').first().text().trim().slice(0, 120), lang: $('html').attr('lang') || '',
      schemaTypes: x.jsonld.types.slice(0, 10),
      internalLinks: x.linkCounts.internal, externalLinks: x.linkCounts.external,
    },
  };
}

module.exports = { scan };

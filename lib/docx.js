const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, HeadingLevel, ShadingType, AlignmentType, BorderStyle,
} = require('docx');

const COLORS = { pass: '12A05C', warn: 'D98A00', fail: 'D9382C' };
const LABEL = { pass: 'Pass', warn: 'Improve', fail: 'Fix' };
const scoreColor = (n) => (n >= 80 ? COLORS.pass : n >= 50 ? COLORS.warn : COLORS.fail);

const border = { style: BorderStyle.SINGLE, size: 4, color: 'D9DCE3' };
const borders = { top: border, bottom: border, left: border, right: border };

const p = (text, opts = {}) => new Paragraph({ spacing: { after: 100 }, ...opts.para, children: [new TextRun({ text: String(text), ...opts })] });

function cell(content, width, { fill, bold, color, align } = {}) {
  const paras = (Array.isArray(content) ? content : [content]).map((t) =>
    new Paragraph({ alignment: align, spacing: { after: 40 }, children: [new TextRun({ text: String(t), size: 18, bold, color })] }));
  return new TableCell({
    width: { size: width, type: WidthType.DXA }, borders,
    margins: { top: 70, bottom: 70, left: 100, right: 100 },
    shading: fill ? { type: ShadingType.CLEAR, fill, color: 'auto' } : undefined,
    children: paras,
  });
}

function checksTable(checks) {
  const W = [1900, 900, 2900, 3300];
  const head = new TableRow({
    tableHeader: true,
    children: ['Check', 'Status', 'Finding', 'How to improve'].map((h, i) => cell(h, W[i], { fill: '1B2433', bold: true, color: 'FFFFFF' })),
  });
  const rows = checks.map((c) => new TableRow({
    cantSplit: true,
    children: [
      cell(c.title, W[0], { bold: true }),
      cell(LABEL[c.status], W[1], { bold: true, color: COLORS[c.status] }),
      cell(c.detail, W[2]),
      cell(c.fix || '—', W[3]),
    ],
  }));
  return new Table({ width: { size: W.reduce((a, b) => a + b), type: WidthType.DXA }, columnWidths: W, rows: [head, ...rows] });
}

async function buildDocx(r) {
  const kids = [];
  const date = new Date(r.scannedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  kids.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: 'SEO & GEO Audit', bold: true })] }));
  kids.push(p(r.finalUrl, { size: 24, color: '3B5BFD' }));
  kids.push(p(`Scanned on ${date}`, { color: '667085', size: 20 }));

  // Score summary
  kids.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Scores')] }));
  const sc = [['Overall', r.overall, r.grade]];
  if (r.seo) sc.push(['SEO', r.seo.score, r.seo.grade]);
  if (r.geo) sc.push(['GEO (AI search)', r.geo.score, r.geo.grade]);
  const SW = Math.floor(9000 / sc.length);
  kids.push(new Table({
    width: { size: SW * sc.length, type: WidthType.DXA }, columnWidths: sc.map(() => SW),
    rows: [new TableRow({
      children: sc.map(([name, score, grade]) => new TableCell({
        width: { size: SW, type: WidthType.DXA }, borders, margins: { top: 140, bottom: 140, left: 100, right: 100 },
        children: [
          new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: String(score), bold: true, size: 64, color: scoreColor(score) })] }),
          new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `${name} · Grade ${grade}`, size: 20, color: '667085' })] }),
        ],
      })),
    })],
  }));

  // Snapshot
  const s = r.snapshot;
  kids.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 300 }, children: [new TextRun('Page snapshot')] }));
  [
    ['Title', s.title || '—'], ['Meta description', s.description || '—'], ['Main heading', s.h1 || '—'],
    ['Words', s.words], ['Response time', `${s.loadMs} ms`], ['HTML size', `${s.sizeKb} KB`],
    ['Links', `${s.internalLinks} internal, ${s.externalLinks} external`], ['Schema types', s.schemaTypes.join(', ') || 'None'],
  ].forEach(([k, v]) => kids.push(new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: `${k}: `, bold: true }), new TextRun(String(v))] })));

  // Priorities
  if (r.priorities.length) {
    kids.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 300 }, children: [new TextRun('Fix these first')] }));
    r.priorities.forEach((c, i) => {
      kids.push(new Paragraph({
        spacing: { before: 100, after: 40 },
        children: [
          new TextRun({ text: `${i + 1}. ${c.title} `, bold: true }),
          new TextRun({ text: `(${c.mode.toUpperCase()} · ${LABEL[c.status]})`, color: COLORS[c.status], size: 18 }),
        ],
      }));
      kids.push(p(c.fix || c.detail, { size: 20 }));
    });
  }

  // Detailed sections
  for (const [key, label] of [['seo', 'SEO findings'], ['geo', 'GEO findings (AI search visibility)']]) {
    const sec = r[key];
    if (!sec) continue;
    kids.push(new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, children: [new TextRun(`${label} — ${sec.score}/100`)] }));
    kids.push(p(`${sec.counts.pass} passed · ${sec.counts.warn} to improve · ${sec.counts.fail} to fix`, { color: '667085' }));
    for (const cat of sec.categories) {
      kids.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 240 }, children: [new TextRun(`${cat.name} — ${cat.score}/100`)] }));
      kids.push(checksTable(sec.checks.filter((c) => c.category === cat.name)));
    }
  }

  kids.push(p('Generated by Beacon. Scores are heuristic guidance based on the page HTML at scan time, not a ranking guarantee.', { color: '98A2B3', size: 16, para: { spacing: { before: 400 } } }));

  const doc = new Document({
    creator: 'Beacon', title: `SEO & GEO Audit – ${r.host}`,
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{ children: kids }],
  });
  return Packer.toBuffer(doc);
}

module.exports = { buildDocx };

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Handlebars from 'handlebars';
import hyphenPkg from 'hyphen/en/index.js';
const { hyphenateSync: hyphenate } = hyphenPkg;
import puppeteer from 'puppeteer';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Args ──
const bookDir = process.argv[2];
if (!bookDir) {
  console.error('Usage: node generate.mjs <book-directory>');
  process.exit(1);
}

const FONTS_DIR = path.join(__dirname, 'fonts');
const bookDirAbs = path.resolve(bookDir);
const bookName = path.basename(bookDirAbs);
const OUTPUT_PDF = path.join(bookDirAbs, `${bookName}.pdf`);

// Page size: autobiographer's "medium" book format
const PAGE_WIDTH = '658px';
const PAGE_HEIGHT = '852px';
const MARGIN = { top: '125px', right: '40px', bottom: '80px', left: '40px' };

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X',
               'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX'];

function hyph(text) {
  return hyphenate(text.split('\n').join('\n<br>\n'), { hyphenChar: '&shy;' });
}

// ── Parse frontmatter + body from a markdown file ──
function parseMd(filepath) {
  const raw = fs.readFileSync(filepath, 'utf8');
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) {
    return { meta: {}, body: raw.trim() };
  }
  const meta = yaml.load(fmMatch[1]) || {};
  const body = fmMatch[2].trim();
  return { meta, body };
}

// ── Convert body text to paragraphs array ──
function toParagraphs(body) {
  if (!body) return [];
  return body.split(/\n\n+/).filter(p => p.trim()).map(p => ({ text: p.trim() }));
}

// ── Read metadata ──
const metaPath = path.join(bookDirAbs, 'metadata.yml');
const bookMeta = yaml.load(fs.readFileSync(metaPath, 'utf8'));
const title = bookMeta.title;
const author = bookMeta.author;

// ── Read all content files in order ──
const mdFiles = fs.readdirSync(bookDirAbs)
  .filter(f => f.endsWith('.md'))
  .sort();

console.log(`Found ${mdFiles.length} content files`);

// ── Build structured book data ──
let bookIntro = null;
let bookOutro = null;
const parts = [];
let currentPart = null;
let memoirCounter = 0;

for (const file of mdFiles) {
  const { meta, body } = parseMd(path.join(bookDirAbs, file));
  const type = meta.type;
  if (!type) continue;

  switch (type) {
    case 'intro':
      bookIntro = {
        title: meta.title || 'Introduction',
        paragraphs: toParagraphs(body).map(p => ({ text: hyph(p.text) })),
      };
      break;

    case 'outro':
      bookOutro = {
        title: meta.title || 'Closing Reflections',
        paragraphs: toParagraphs(body).map(p => ({ text: hyph(p.text) })),
      };
      break;

    case 'part-title':
      currentPart = {
        title: meta.title,
        intro: null,
        chapters: [],
      };
      parts.push(currentPart);
      break;

    case 'editorial':
      if (currentPart) {
        currentPart.intro = {
          paragraphs: toParagraphs(body).map(p => ({ text: hyph(p.text) })),
        };
      }
      break;

    case 'bridge':
      if (currentPart) {
        currentPart.chapters.push({
          type: 'bridge',
          paragraphs: toParagraphs(body).map(p => ({ text: hyph(p.text) })),
        });
      }
      break;

    case 'memoir':
      memoirCounter++;
      if (currentPart) {
        currentPart.chapters.push({
          type: 'memoir',
          title: meta.title,
          romanNumeral: ROMAN[memoirCounter - 1] || String(memoirCounter),
          paragraphs: toParagraphs(body).map(p => ({ text: hyph(p.text) })),
        });
      }
      break;
  }
}

const templateData = {
  bookTitle: title,
  bookAuthor: author,
  bookIntro,
  bookOutro,
  parts,
};

console.log(`Book: "${title}" by ${author}`);
console.log(`Parts: ${parts.length}, Memoirs: ${memoirCounter}`);

// ── Register Handlebars helpers ──
Handlebars.registerHelper('isbridge', function(ch) {
  return ch.type === 'bridge';
});

// ── Copy fonts to a temp dir for file:// access ──
const tmpDir = fs.mkdtempSync('/tmp/biographer-');
const fontFiles = fs.readdirSync(FONTS_DIR).filter(f => f.endsWith('.ttf'));
for (const f of fontFiles) {
  fs.copyFileSync(path.join(FONTS_DIR, f), path.join(tmpDir, f));
}

// Copy templates to tmp dir too (for relative font URLs in CSS)
for (const t of ['template.hbs', 'front-cover.hbs', 'footer.hbs']) {
  fs.copyFileSync(path.join(__dirname, t), path.join(tmpDir, t));
}

// ── Generate HTML ──
console.log('Generating HTML...');

const contentTemplate = Handlebars.compile(
  fs.readFileSync(path.join(tmpDir, 'template.hbs'), 'utf8')
);
const contentHtml = contentTemplate(templateData);

const coverTemplate = Handlebars.compile(
  fs.readFileSync(path.join(tmpDir, 'front-cover.hbs'), 'utf8')
);
const coverHtml = coverTemplate({
  title,
  author,
  date: new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' }).toUpperCase(),
});

const footerHtml = fs.readFileSync(path.join(tmpDir, 'footer.hbs'), 'utf8');

const contentPath = path.join(tmpDir, 'content.html');
const coverPath = path.join(tmpDir, 'cover.html');
fs.writeFileSync(contentPath, contentHtml);
fs.writeFileSync(coverPath, coverHtml);

// ── Render to PDF with Puppeteer ──
console.log('Launching browser...');
const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

async function renderPdf(htmlFilePath, options = {}) {
  const page = await browser.newPage();
  await page.goto(`file://${htmlFilePath}`, { waitUntil: 'networkidle0', timeout: 120000 });
  const buffer = await page.pdf({
    printBackground: true,
    headerTemplate: '<div></div>',
    footerTemplate: options.footerTemplate || '<div></div>',
    displayHeaderFooter: !!options.footerTemplate,
    margin: options.margin || { top: 0, right: 0, bottom: 0, left: 0 },
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
  });
  await page.close();
  return PDFDocument.load(buffer);
}

console.log('Rendering front cover...');
const coverPdf = await renderPdf(coverPath);

console.log('Rendering content...');
const contentPdf = await renderPdf(contentPath, {
  margin: MARGIN,
  footerTemplate: footerHtml,
});

console.log(`Cover: ${coverPdf.getPageCount()} pages, Content: ${contentPdf.getPageCount()} pages`);

// ── Merge with pdf-lib ──
console.log('Merging PDF...');
const mergedPdf = await PDFDocument.create();
mergedPdf.registerFontkit(fontkit);

const cormorantBytes = fs.readFileSync(path.join(FONTS_DIR, 'Cormorant-VariableFont_wght.ttf'));
const cormorantFont = await mergedPdf.embedFont(cormorantBytes);

// Add front cover
const coverPages = await mergedPdf.copyPages(coverPdf, coverPdf.getPageIndices());
for (const p of coverPages) {
  mergedPdf.addPage(p);
}

// Add content pages with background + alternating title/author headers
const contentPageCount = contentPdf.getPageCount();
const coverPageCount = coverPdf.getPageCount();

let i = coverPageCount;
for (; i < contentPageCount; i++) {
  const isLastPage = i === contentPageCount - 1;
  const titleWidth = cormorantFont.widthOfTextAtSize(title, 12);

  const [page1] = await mergedPdf.embedPdf(contentPdf, [i]);
  const addedPage1 = mergedPdf.addPage([page1.width, page1.height]);
  addedPage1.drawRectangle({
    width: page1.width,
    height: page1.height,
    color: isLastPage
      ? rgb(249 / 255, 247 / 255, 244 / 255)
      : rgb(253 / 255, 252 / 255, 250 / 255),
  });
  addedPage1.drawPage(page1);

  if (!isLastPage) {
    addedPage1.drawText(title, {
      size: 12,
      font: cormorantFont,
      color: rgb(0.41, 0.4, 0.38),
      x: page1.width / 2 - titleWidth / 2,
      y: page1.height - 63,
    });
  }

  i += 1;
  if (i < contentPageCount) {
    const isLastPage2 = i === contentPageCount - 1;
    const authorWidth = cormorantFont.widthOfTextAtSize(author, 12);
    const [page2] = await mergedPdf.embedPdf(contentPdf, [i]);
    const addedPage2 = mergedPdf.addPage([page1.width, page1.height]);
    addedPage2.drawRectangle({
      width: page1.width,
      height: page1.height,
      color: isLastPage2
        ? rgb(249 / 255, 247 / 255, 244 / 255)
        : rgb(253 / 255, 252 / 255, 250 / 255),
    });
    addedPage2.drawPage(page2);

    if (!isLastPage2) {
      addedPage2.drawText(author, {
        size: 12,
        font: cormorantFont,
        color: rgb(0.41, 0.4, 0.38),
        x: page1.width / 2 - authorWidth / 2,
        y: page1.height - 63,
      });
    }
  }
}

// ── Save ──
console.log('Saving PDF...');
const pdfBytes = await mergedPdf.save();
fs.writeFileSync(OUTPUT_PDF, pdfBytes);

await browser.close();

// Clean up tmp
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\nDone! PDF saved to: ${OUTPUT_PDF}`);
console.log(`Total pages: ${mergedPdf.getPageCount()}`);

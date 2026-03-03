const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const archiver = require('archiver');
const path = require('path');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/120.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

const IMAGE_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp',
  '.svg', '.bmp', '.tiff', '.tif', '.avif', '.heic',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveUrl(base, relative) {
  if (!relative || relative.startsWith('data:')) return null;
  try {
    return new URL(relative.trim(), base).href;
  } catch {
    return null;
  }
}

function parseSrcset(srcset, baseUrl) {
  const candidates = [];
  for (const part of srcset.split(',')) {
    const tokens = part.trim().split(/\s+/);
    if (!tokens[0]) continue;
    const rawUrl = tokens[0];
    let width = 0;
    if (tokens[1]) {
      if (tokens[1].endsWith('w')) width = parseInt(tokens[1]) || 0;
      else if (tokens[1].endsWith('x')) width = Math.round(parseFloat(tokens[1]) * 1000) || 0;
    }
    const resolved = resolveUrl(baseUrl, rawUrl);
    if (resolved) candidates.push({ width, url: resolved });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.width - a.width);
  return candidates[0].url;
}

function isImageUrl(rawUrl) {
  try {
    const ext = path.extname(new URL(rawUrl).pathname).toLowerCase();
    return IMAGE_EXTS.has(ext);
  } catch {
    return false;
  }
}

function extractImageUrls(html, baseUrl) {
  const $ = cheerio.load(html);
  const urls = new Set();

  // <img> — prefer srcset for highest res
  $('img').each((_, el) => {
    const $el = $(el);
    const srcset =
      $el.attr('srcset') ||
      $el.attr('data-srcset') ||
      $el.attr('data-src-set');
    if (srcset) {
      const best = parseSrcset(srcset, baseUrl);
      if (best) { urls.add(best); return; }
    }
    // Lazy-load attribute fallbacks
    for (const attr of [
      'data-src', 'data-lazy-src', 'data-original',
      'data-lazy', 'data-full-size', 'data-large',
      'data-hi-res', 'src',
    ]) {
      const val = $el.attr(attr);
      if (val) {
        const resolved = resolveUrl(baseUrl, val);
        if (resolved) { urls.add(resolved); break; }
      }
    }
  });

  // <picture> / <source>
  $('source[srcset]').each((_, el) => {
    const best = parseSrcset($(el).attr('srcset'), baseUrl);
    if (best) urls.add(best);
  });

  // <a> tags linking directly to image files
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && isImageUrl(href)) {
      const resolved = resolveUrl(baseUrl, href);
      if (resolved) urls.add(resolved);
    }
  });

  // og:image / twitter:image meta tags
  $('meta').each((_, el) => {
    const prop = $(el).attr('property') || $(el).attr('name') || '';
    if (prop.toLowerCase().includes('image')) {
      const content = $(el).attr('content');
      if (content) {
        const resolved = resolveUrl(baseUrl, content);
        if (resolved) urls.add(resolved);
      }
    }
  });

  return [...urls];
}

function safeFilename(rawUrl, index) {
  let name = '';
  try {
    name = path.basename(new URL(rawUrl).pathname);
  } catch { /* ignore */ }
  // Strip query strings baked into the path
  name = (name || '').split('?')[0];
  // Remove unsafe characters
  name = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  if (!name || name === '_') name = 'image';
  const prefix = String(index + 1).padStart(4, '0');
  return `${prefix}_${name}`.slice(0, 200);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// POST /api/scrape — returns list of image URLs found on the page
app.post('/api/scrape', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try {
    const response = await axios.get(url, {
      headers: HEADERS,
      timeout: 20_000,
      maxRedirects: 5,
    });
    const finalUrl = response.request?.res?.responseUrl || url;
    const images = extractImageUrls(response.data, finalUrl);
    res.json({ images, count: images.length });
  } catch (err) {
    const msg =
      err.response
        ? `HTTP ${err.response.status}: ${err.response.statusText}`
        : err.message;
    res.status(500).json({ error: msg });
  }
});

// POST /api/download — downloads selected images and streams them as a zip
app.post('/api/download', async (req, res) => {
  const { urls } = req.body;
  if (!urls || !urls.length)
    return res.status(400).json({ error: 'No URLs provided' });

  let domain = 'images';
  try { domain = new URL(urls[0]).hostname.replace(/\./g, '_'); } catch { /* ignore */ }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${domain}_images.zip"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.pipe(res);

  const downloadOne = async (rawUrl, index) => {
    try {
      const response = await axios.get(rawUrl, {
        headers: { ...HEADERS, Accept: 'image/*,*/*;q=0.8' },
        responseType: 'stream',
        timeout: 30_000,
      });

      // Determine file extension from Content-Type if path has none
      let ext = path.extname(new URL(rawUrl).pathname).toLowerCase();
      if (!ext || ext.length > 6) {
        const ct = response.headers['content-type'] || '';
        if (ct.includes('jpeg') || ct.includes('jpg')) ext = '.jpg';
        else if (ct.includes('png'))  ext = '.png';
        else if (ct.includes('gif'))  ext = '.gif';
        else if (ct.includes('webp')) ext = '.webp';
        else if (ct.includes('svg'))  ext = '.svg';
        else if (ct.includes('avif')) ext = '.avif';
        else ext = '.jpg';
      }

      const filename = safeFilename(rawUrl, index).replace(/\.\w+$/, '') + ext;
      archive.append(response.data, { name: filename });
    } catch {
      // Skip failed images silently — don't abort the whole zip
    }
  };

  // Download with bounded concurrency
  const CONCURRENCY = 8;
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map((u, j) => downloadOne(u, i + j)));
  }

  await archive.finalize();
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ✅ Image Scraper running at http://localhost:${PORT}\n`);
}).on('error', (err) => {
  console.error(`\n  ❌ Failed to start server: ${err.message}\n`);
  process.exit(1);
});

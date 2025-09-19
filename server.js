const express = require('express');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const MarkdownIt = require('markdown-it');
const markdownItAnchor = require('markdown-it-anchor');
const markdownItToc = require('markdown-it-table-of-contents');
const hljs = require('highlight.js');
const chokidar = require('chokidar');

const app = express();
const PORT = process.env.PORT || 3000;

// Configure markdown parser with plugins
const MERMAID_DEFAULT_SRC = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js';
const MERMAID_LOCAL_STATIC = '/static/vendor/mermaid.min.js';
let mermaidScriptSource = process.env.MERMAID_SRC;
if (!mermaidScriptSource) {
  const localCandidate = path.join(__dirname, 'public', 'vendor', 'mermaid.min.js');
  if (fsSync.existsSync(localCandidate)) {
    mermaidScriptSource = MERMAID_LOCAL_STATIC;
  } else {
    mermaidScriptSource = MERMAID_DEFAULT_SRC;
  }
}

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  highlight: function (str, lang) {
    if (lang && lang.toLowerCase() === 'mermaid') {
      return str;
    }
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(str, { language: lang }).value;
      } catch (__) {}
    }
    return '';
  }
})
.use(markdownItAnchor, {
  permalink: markdownItAnchor.permalink.headerLink()
})
.use(markdownItToc, {
  includeLevel: [1, 2, 3, 4],
  containerHeaderHtml: '<div class="toc-container-header">Table of Contents</div>',
  containerClass: 'table-of-contents'
});

const defaultFence = md.renderer.rules.fence || function(tokens, idx, options, env, self) {
  return self.renderToken(tokens, idx, options);
};

md.renderer.rules.fence = function(tokens, idx, options, env, self) {
  const token = tokens[idx];
  const info = (token.info || '').trim();
  if (info.toLowerCase().startsWith('mermaid')) {
    const content = token.content.trimEnd();
    return `<div class="mermaid">\n${content}\n</div>`;
  }
  return defaultFence(tokens, idx, options, env, self);
};

// Open external links in new tabs safely
const defaultLinkOpen = md.renderer.rules.link_open || function(tokens, idx, options, env, self) {
  return self.renderToken(tokens, idx, options);
};
md.renderer.rules.link_open = function(tokens, idx, options, env, self) {
  // Only update external links
  const hrefIndex = tokens[idx].attrIndex('href');
  if (hrefIndex >= 0) {
    const href = tokens[idx].attrs[hrefIndex][1] || '';
    if (/^https?:\/\//i.test(href)) {
      const targetIndex = tokens[idx].attrIndex('target');
      if (targetIndex < 0) tokens[idx].attrPush(['target', '_blank']);
      else tokens[idx].attrs[targetIndex][1] = '_blank';

      const relIndex = tokens[idx].attrIndex('rel');
      if (relIndex < 0) tokens[idx].attrPush(['rel', 'noopener noreferrer']);
      else tokens[idx].attrs[relIndex][1] = 'noopener noreferrer';
    }
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

// Base directory for markdown files (configurable via MDVIEWER_DIR, fallback to HOME)
const BASE_DIR = process.env.MDVIEWER_DIR || process.env.HOME || '/home';

function isInsideBase(resolvedPath, resolvedBase) {
  if (resolvedPath === resolvedBase) return true;
  const withSep = resolvedBase.endsWith(path.sep) ? resolvedBase : resolvedBase + path.sep;
  return resolvedPath.startsWith(withSep);
}

// Serve static files (CSS, JS, images)
app.use('/static', express.static(path.join(__dirname, 'public')));
// Serve raw files from BASE_DIR for images/assets referenced by Markdown
app.use('/raw', express.static(BASE_DIR));

// In-memory index for fast listings/search
let fileIndex = new Map();

function indexSet(file) {
  fileIndex.set(file.path, file);
}

function indexDelete(relPath) {
  fileIndex.delete(relPath);
}

function listFromIndex() {
  return Array.from(fileIndex.values());
}

async function buildIndex() {
  try {
    const files = await findMarkdownFiles(BASE_DIR);
    const next = new Map();
    for (const f of files) next.set(f.path, f);
    fileIndex = next;
  } catch (e) {
    console.warn('Index build failed:', e.message);
  }
}

function setupWatcher() {
  const watcher = chokidar.watch(BASE_DIR, {
    ignored: (p) => {
      const bn = path.basename(p || '');
      if (bn.startsWith('.')) return true;
      return /(^|\/)node_modules(\/|$)|(^|\/)vendor(\/|$)|(^|\/)build(\/|$)|(^|\/)dist(\/|$)|(^|\/)__pycache__(\/|$)/.test(p);
    },
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });

  watcher.on('add', async (full) => {
    if (!full.toLowerCase().endsWith('.md')) return;
    const rel = path.relative(BASE_DIR, full);
    try {
      const st = await fs.stat(full);
      indexSet({ name: path.basename(full), path: rel, fullPath: full, size: st.size, modified: st.mtime });
    } catch {}
  });
  watcher.on('change', async (full) => {
    if (!full.toLowerCase().endsWith('.md')) return;
    const rel = path.relative(BASE_DIR, full);
    try {
      const st = await fs.stat(full);
      indexSet({ name: path.basename(full), path: rel, fullPath: full, size: st.size, modified: st.mtime });
    } catch {}
  });
  watcher.on('unlink', (full) => {
    if (!full.toLowerCase().endsWith('.md')) return;
    const rel = path.relative(BASE_DIR, full);
    indexDelete(rel);
  });
}

// Function to recursively find all markdown files
async function findMarkdownFiles(dir, relativePath = '') {
  const files = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.join(relativePath, entry.name);

      if (entry.isDirectory()) {
        // Skip common directories that shouldn't contain user markdown files
        if (!entry.name.startsWith('.') &&
            !['node_modules', 'vendor', 'build', 'dist', '__pycache__'].includes(entry.name)) {
          const subFiles = await findMarkdownFiles(fullPath, relPath);
          files.push(...subFiles);
        }
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        const stats = await fs.stat(fullPath);
        files.push({
          name: entry.name,
          path: relPath,
          fullPath: fullPath,
          size: stats.size,
          modified: stats.mtime
        });
      }
    }
  } catch (error) {
    console.warn(`Warning: Could not read directory ${dir}:`, error.message);
  }

  return files;
}

// Function to get directory structure for a given path
async function getDirectoryStructure(dir, relativePath = '') {
  const structure = { dirs: [], files: [] };
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.join(relativePath, entry.name);

      if (entry.isDirectory() && !entry.name.startsWith('.') &&
          !['node_modules', 'vendor', 'build', 'dist', '__pycache__'].includes(entry.name)) {
        const stats = await fs.stat(fullPath);
        structure.dirs.push({
          name: entry.name,
          path: relPath,
          modified: stats.mtime
        });
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        const stats = await fs.stat(fullPath);
        structure.files.push({
          name: entry.name,
          path: relPath,
          size: stats.size,
          modified: stats.mtime
        });
      }
    }
  } catch (error) {
    console.warn(`Warning: Could not read directory ${dir}:`, error.message);
  }

  // Sort directories and files alphabetically
  structure.dirs.sort((a, b) => a.name.localeCompare(b.name));
  structure.files.sort((a, b) => a.name.localeCompare(b.name));

  return structure;
}

// Generate HTML template
function generateHTML(title, content, isDirectory = false, currentPath = '', headExtras = '') {
  const breadcrumbs = currentPath ?
    currentPath.split('/').filter(Boolean).map((part, index, arr) => {
      const pathTo = '/' + arr.slice(0, index + 1).join('/');
      return `<a href="/browse${pathTo}" class="breadcrumb-link">${part}</a>`;
    }).join(' / ') : 'Home';

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} - MD Viewer</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css">
    ${headExtras}
    <style>
        * { box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            background: #fafafa;
        }
        .header {
            background: white;
            padding: 20px;
            margin-bottom: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            border-left: 4px solid #007acc;
        }
        .header h1 {
            margin: 0 0 10px 0;
            color: #007acc;
        }
        .breadcrumbs {
            color: #666;
            font-size: 14px;
        }
        .breadcrumb-link {
            color: #007acc;
            text-decoration: none;
        }
        .breadcrumb-link:hover {
            text-decoration: underline;
        }
        .content {
            background: white;
            padding: 30px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .directory-listing {
            margin: 0;
            padding: 0;
        }
        .directory-item, .file-item {
            display: flex;
            align-items: center;
            padding: 12px;
            border-bottom: 1px solid #eee;
            text-decoration: none;
            color: inherit;
            transition: background-color 0.2s;
        }
        .directory-item:hover, .file-item:hover {
            background-color: #f5f5f5;
        }
        .directory-item::before {
            content: "📁";
            margin-right: 10px;
            font-size: 16px;
        }
        .file-item::before {
            content: "📄";
            margin-right: 10px;
            font-size: 16px;
        }
        .item-info {
            margin-left: auto;
            font-size: 12px;
            color: #666;
        }
        .table-of-contents {
            background: #f8f9fa;
            border: 1px solid #dee2e6;
            border-radius: 6px;
            padding: 20px;
            margin: 20px 0;
        }
        .toc-container-header {
            font-weight: bold;
            font-size: 16px;
            margin-bottom: 10px;
            color: #495057;
        }
        .table-of-contents ul {
            margin: 0;
            padding-left: 20px;
        }
        .table-of-contents li {
            margin: 5px 0;
        }
        .table-of-contents a {
            color: #007acc;
            text-decoration: none;
        }
        .table-of-contents a:hover {
            text-decoration: underline;
        }
        pre {
            background: #f8f9fa;
            border: 1px solid #e9ecef;
            border-radius: 4px;
            padding: 16px;
            overflow-x: auto;
        }
        code {
            background: #f8f9fa;
            padding: 2px 4px;
            border-radius: 3px;
            font-size: 0.9em;
        }
        pre code {
            background: none;
            padding: 0;
        }
        blockquote {
            border-left: 4px solid #007acc;
            margin: 0;
            padding-left: 16px;
            color: #666;
            font-style: italic;
        }
        table {
            border-collapse: collapse;
            width: 100%;
            margin: 16px 0;
        }
        th, td {
            border: 1px solid #ddd;
            padding: 8px 12px;
            text-align: left;
        }
        th {
            background-color: #f8f9fa;
            font-weight: 600;
        }
        .home-link {
            display: inline-block;
            margin-bottom: 20px;
            color: #007acc;
            text-decoration: none;
            font-weight: 500;
        }
        .home-link:hover {
            text-decoration: underline;
        }
        @media (max-width: 768px) {
            body {
                padding: 10px;
            }
            .header, .content {
                padding: 15px;
            }
        }
        /* Dark theme overrides */
        body[data-theme='dark'] { background: #0f1419; color: #d1d5db; }
        body[data-theme='dark'] .header, body[data-theme='dark'] .content { background: #111820; }
        body[data-theme='dark'] a { color: #4ea1ff; }
        .toggle-btn { cursor: pointer; }
    </style>
</head>
<body>
    <script>
      (function(){
        try {
          const saved = localStorage.getItem('theme');
          const preferDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
          const theme = saved || (preferDark ? 'dark' : 'light');
          document.body.setAttribute('data-theme', theme);
        } catch(_){}
      })();
    </script>
    <div class="header" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
        <h1 style="margin-right:8px;">📚 Markdown Viewer</h1>
        <form class="search-form" action="/search" method="get">
          <input type="search" name="q" placeholder="Search files..." value="">
        </form>
        <span style="flex:1 1 auto"></span>
        <button class="toggle-btn" onclick="(function(){var el=document.body;var t=el.getAttribute('data-theme')==='dark'?'light':'dark';el.setAttribute('data-theme',t);try{localStorage.setItem('theme',t);}catch(_){}})()">Toggle Theme</button>
        <div class="breadcrumbs" style="width:100%">
            <a href="/" class="breadcrumb-link">🏠 Home</a>
            ${currentPath ? ' / ' + breadcrumbs : ''}
        </div>
    </div>
    <div class="content">
        ${content}
    </div>
</body>
</html>`;
}

// Route: Home page with all markdown files
app.get('/', async (req, res) => {
  try {
    if (typeof fileIndex === 'undefined' || fileIndex.size === 0) {
      // Build index on first visit
      if (typeof buildIndex === 'function') {
        await buildIndex();
      }
    }
    const files = typeof listFromIndex === 'function' ? listFromIndex() : await findMarkdownFiles(BASE_DIR);
    files.sort((a, b) => b.modified - a.modified); // Sort by modification date, newest first

    let content = '<h2>📋 All Markdown Files</h2>';

    if (files.length === 0) {
      content += '<p>No markdown files found in your home directory.</p>';
    } else {
      content += '<div class="directory-listing">';
      for (const file of files) {
        const fileSize = (file.size / 1024).toFixed(1) + ' KB';
        const modifiedDate = file.modified.toLocaleDateString();
        content += `
          <a href="/file/${encodeURIComponent(file.path)}" class="file-item">
            <span>${file.path}</span>
            <span class="item-info">${fileSize} • ${modifiedDate}</span>
          </a>
        `;
      }
      content += '</div>';
    }

    content += `<br><a href="/browse" class="home-link">🗂️ Browse by Directory</a>`;
    content += ` | <a href="/search" class="home-link">🔎 Search</a>`;

    res.send(generateHTML('All Markdown Files', content));
  } catch (error) {
    console.error('Error listing files:', error);
    res.status(500).send(generateHTML('Error', '<h2>Error loading files</h2><p>' + error.message + '</p>'));
  }
});

// Route: Browse directories
// Support both /browse and /browse/<path>
app.get('/browse', async (req, res) => {
  const requestedPath = '';
  const fullPath = path.join(BASE_DIR, requestedPath);

  try {
    const resolvedPath = path.resolve(fullPath);
    const resolvedBase = path.resolve(BASE_DIR);
    if (!isInsideBase(resolvedPath, resolvedBase)) {
      return res.status(403).send(generateHTML('Access Denied', '<h2>Access Denied</h2><p>Cannot access files outside the home directory.</p>'));
    }

    const stats = await fs.stat(fullPath);
    if (!stats.isDirectory()) {
      return res.redirect(`/file/${encodeURIComponent(requestedPath)}`);
    }

    const structure = await getDirectoryStructure(fullPath, requestedPath);

    let content = `<h2>📁 Directory: /${requestedPath || 'Home'}</h2>`;
    content += '<div class="directory-listing">';

    for (const dir of structure.dirs) {
      const modifiedDate = dir.modified.toLocaleDateString();
      content += `
        <a href="/browse/${encodeURI(dir.path)}" class="directory-item">
          <span>${dir.name}/</span>
          <span class="item-info">${modifiedDate}</span>
        </a>
      `;
    }

    for (const file of structure.files) {
      const fileSize = (file.size / 1024).toFixed(1) + ' KB';
      const modifiedDate = file.modified.toLocaleDateString();
      content += `
        <a href="/file/${encodeURIComponent(file.path)}" class="file-item">
          <span>${file.name}</span>
          <span class="item-info">${fileSize} • ${modifiedDate}</span>
        </a>
      `;
    }

    content += '</div>';

    if (structure.dirs.length === 0 && structure.files.length === 0) {
      content += '<p>This directory is empty or contains no accessible markdown files.</p>';
    }

    res.send(generateHTML(`Directory: ${requestedPath || 'Home'}`, content, true, requestedPath));
  } catch (error) {
    console.error('Error browsing directory:', error);
    res.status(404).send(generateHTML('Directory Not Found', '<h2>Directory Not Found</h2><p>The requested directory could not be found or accessed.</p>'));
  }
});

app.get('/browse/*?', async (req, res) => {
  const requestedPath = req.params[0] || '';
  const fullPath = path.join(BASE_DIR, requestedPath);

  try {
    // Security check: ensure we're not going outside BASE_DIR
    const resolvedPath = path.resolve(fullPath);
    const resolvedBase = path.resolve(BASE_DIR);
    if (!isInsideBase(resolvedPath, resolvedBase)) {
      return res.status(403).send(generateHTML('Access Denied', '<h2>Access Denied</h2><p>Cannot access files outside the home directory.</p>'));
    }

    const stats = await fs.stat(fullPath);
    if (!stats.isDirectory()) {
      return res.redirect(`/file/${encodeURIComponent(requestedPath)}`);
    }

    const structure = await getDirectoryStructure(fullPath, requestedPath);

    let content = `<h2>📁 Directory: /${requestedPath || 'Home'}</h2>`;

    // Add parent directory link if not at root
    if (requestedPath) {
      const parentPath = path.dirname(requestedPath);
      const parentUrl = parentPath === '.' ? '/browse' : `/browse/${encodeURI(parentPath)}`;
      content += `<a href="${parentUrl}" class="directory-item">
        <span>.. (Parent Directory)</span>
        <span class="item-info"></span>
      </a>`;
    }

    content += '<div class="directory-listing">';

    // Add directories
    for (const dir of structure.dirs) {
      const modifiedDate = dir.modified.toLocaleDateString();
      content += `
        <a href="/browse/${encodeURI(dir.path)}" class="directory-item">
          <span>${dir.name}/</span>
          <span class="item-info">${modifiedDate}</span>
        </a>
      `;
    }

    // Add files
    for (const file of structure.files) {
      const fileSize = (file.size / 1024).toFixed(1) + ' KB';
      const modifiedDate = file.modified.toLocaleDateString();
      content += `
        <a href="/file/${encodeURIComponent(file.path)}" class="file-item">
          <span>${file.name}</span>
          <span class="item-info">${fileSize} • ${modifiedDate}</span>
        </a>
      `;
    }

    content += '</div>';

    if (structure.dirs.length === 0 && structure.files.length === 0) {
      content += '<p>This directory is empty or contains no accessible markdown files.</p>';
    }

    res.send(generateHTML(`Directory: ${requestedPath || 'Home'}`, content, true, requestedPath));
  } catch (error) {
    console.error('Error browsing directory:', error);
    res.status(404).send(generateHTML('Directory Not Found', '<h2>Directory Not Found</h2><p>The requested directory could not be found or accessed.</p>'));
  }
});

// Route: Search files (path or content)
app.get('/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const scope = ((req.query.in || 'path') + '').toLowerCase() === 'content' ? 'content' : 'path';
  if (typeof fileIndex === 'undefined' || fileIndex.size === 0) {
    if (typeof buildIndex === 'function') await buildIndex();
  }
  const all = typeof listFromIndex === 'function' ? listFromIndex() : await findMarkdownFiles(BASE_DIR);

  let content = '<h2>🔎 Search</h2>';
  content += `<form class="search-form" action="/search" method="get" style="margin-bottom:16px;display:flex;gap:8px;flex-wrap:wrap">`+
             `<input type="search" name="q" placeholder="e.g. notes, README" value="${q.replace(/"/g, '&quot;')}">`+
             `<label style="font-size:14px"><input type="checkbox" name="in" value="content" ${scope==='content'?'checked':''}> Search content</label>`+
             `</form>`;

  if (!q) {
    content += '<p>Enter a query to search by filename/path or check “Search content”.</p>';
    return res.send(generateHTML('Search', content));
  }

  const needle = q.toLowerCase();
  let results = [];

  if (scope === 'content') {
    for (const f of all) {
      try {
        const txt = await fs.readFile(f.fullPath, 'utf8');
        const low = txt.toLowerCase();
        const idx = low.indexOf(needle);
        if (idx !== -1) {
          const start = Math.max(0, idx - 80);
          const end = Math.min(txt.length, idx + q.length + 80);
          const raw = txt.slice(start, end);
          const esc = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          // Compute relative indices in escaped string by escaping the before part similarly
          const beforeRaw = txt.slice(start, idx);
          const beforeEsc = beforeRaw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const matchEsc = txt.slice(idx, idx + q.length).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const afterEsc = esc.slice(beforeEsc.length + matchEsc.length);
          const snippet = `${start>0?'…':''}${beforeEsc}<mark>${matchEsc}</mark>${afterEsc}${end<txt.length?'…':''}`;
          results.push({ file: f, snippet });
        }
      } catch {}
      if (results.length >= 200) break;
    }
  } else {
    results = all
      .filter(f => f.name.toLowerCase().includes(needle) || f.path.toLowerCase().includes(needle))
      .map(f => ({ file: f }));
  }

  results.sort((a, b) => a.file.path.localeCompare(b.file.path));
  const limited = results.slice(0, 200);

  if (limited.length === 0) {
    content += `<p>No results for <strong>${q}</strong>.</p>`;
  } else {
    content += `<p>Found ${results.length} result(s). Showing ${limited.length}.</p>`;
    content += '<div class="directory-listing">';
    for (const { file: f, snippet } of limited) {
      const fileSize = (f.size / 1024).toFixed(1) + ' KB';
      const modifiedDate = new Date(f.modified).toLocaleDateString();
      content += `
        <a href="/file/${encodeURIComponent(f.path)}" class="file-item">
          <span>${f.path}</span>
          <span class="item-info">${fileSize} • ${modifiedDate}</span>
        </a>
      `;
      if (snippet) {
        content += `<div style="font-size:12px;color:#666;margin:6px 0 12px 26px">${snippet}</div>`;
      }
    }
    content += '</div>';
  }

  res.send(generateHTML('Search', content));
});

// Route: Serve individual markdown files
app.get('/file/*', async (req, res) => {
  const filePath = req.params[0];
  const fullPath = path.join(BASE_DIR, filePath);

  try {
    // Security check: ensure we're not going outside BASE_DIR
    const resolvedPath = path.resolve(fullPath);
    const resolvedBase = path.resolve(BASE_DIR);
    if (!isInsideBase(resolvedPath, resolvedBase)) {
      return res.status(403).send(generateHTML('Access Denied', '<h2>Access Denied</h2><p>Cannot access files outside the home directory.</p>'));
    }

    const content = await fs.readFile(fullPath, 'utf8');
    const html = md.render(content);
    const fileName = path.basename(filePath);
    const dirPath = path.dirname(filePath);

    let pageContent = html;

    // Add navigation links
    const browseLink = dirPath === '.' ? '/browse' : `/browse/${encodeURI(dirPath)}`;
    pageContent = `
      <div style="margin-bottom: 20px;">
        <a href="/" class="home-link">📋 All Files</a> |
        <a href="${browseLink}" class="home-link">📁 Directory</a>
      </div>
    ` + pageContent;

    // Ensure relative links (images, etc.) resolve to the file's directory via /raw
    const baseDirPath = dirPath === '.' ? '' : dirPath.split('/').filter(Boolean).map(encodeURIComponent).join('/') + '/';
    const baseTag = `<base href="/raw/${baseDirPath}">`;
    const headExtras = [baseTag];
    if (html.includes('class="mermaid"')) {
      headExtras.push(
        '<script src="' + mermaidScriptSource + '"></script>',
        "<script>document.addEventListener('DOMContentLoaded',function(){if(window.mermaid){mermaid.initialize({startOnLoad:true});}});</script>"
      );
    }
    res.send(generateHTML(fileName, pageContent, false, filePath, headExtras.join('\n')));
  } catch (error) {
    console.error('Error reading file:', error);
    res.status(404).send(generateHTML('File Not Found', '<h2>File Not Found</h2><p>The requested markdown file could not be found or read.</p>'));
  }
});

// Start helper (exported for tests/CLI)
function start(port = PORT) {
  // Build index in background and start watcher
  if (typeof buildIndex === 'function') {
    buildIndex().catch(() => {});
  }
  if (typeof setupWatcher === 'function') {
    try { setupWatcher(); } catch (_) {}
  }

  const server = app.listen(port, () => {
    console.log(`🚀 Markdown Viewer Server running at http://localhost:${port}`);
    console.log(`📁 Serving markdown files from: ${BASE_DIR}`);
    console.log('📚 Available routes:');
    console.log('  • / - View all markdown files');
    console.log('  • /browse - Browse directories');
    console.log('  • /file/<path> - View specific file');
  });
  return server;
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Server shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 Server shutting down gracefully...');
  process.exit(0);
});

// Start automatically only when run directly
if (require.main === module) {
  start();
}

module.exports = { app, start };
// Health endpoint for quick checks
app.get('/health', (req, res) => {
  const count = (typeof fileIndex !== 'undefined' && fileIndex && typeof fileIndex.size === 'number') ? fileIndex.size : 0;
  res.json({ status: 'ok', baseDir: BASE_DIR, indexed: count });
});

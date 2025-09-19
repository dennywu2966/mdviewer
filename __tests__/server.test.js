const path = require('path');

// Point the app at our fixtures before requiring the server
process.env.MDVIEWER_DIR = path.join(__dirname, 'fixtures');

const request = require('supertest');
const { app } = require('../server');

describe('MD Viewer Server', () => {
  it('GET / should return list page', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('All Markdown Files');
  });

  it('GET /browse should render directory view', async () => {
    const res = await request(app).get('/browse');
    expect(res.status).toBe(200);
    // Root directory label may vary, ensure page heading is present
    expect(res.text).toMatch(/Directory:\s*\//);
  });

  it('GET /browse/docs should list files in docs', async () => {
    const res = await request(app).get('/browse/docs');
    expect(res.status).toBe(200);
    expect(res.text).toContain('README.md');
  });

  it('GET /health should return JSON ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.status).toBe('ok');
  });

  it('GET /file/docs/README.md should render markdown with base tag and external link attrs', async () => {
    const res = await request(app).get('/file/docs/README.md');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<base href="/raw/docs/">');
    // Headings and content from fixture
    expect(res.text).toContain('Fixture Document');
    // External link safety attributes
    expect(res.text).toMatch(/rel="noopener noreferrer"/);
    expect(res.text).toMatch(/target="_blank"/);
    // Mermaid diagram support
    expect(res.text).toContain('<div class="mermaid">');
    expect(res.text).toContain('mermaid.min.js');
    expect(res.text).toContain('mermaid.initialize({startOnLoad:true})');
  });

  it('GET /search should find README.md by filename', async () => {
    const res = await request(app).get('/search?q=README');
    expect(res.status).toBe(200);
    expect(res.text).toContain('docs/README.md');
  });

  it('GET /search in=content should find by content and include snippet', async () => {
    const res = await request(app).get('/search?q=sample%20markdown&in=content');
    expect(res.status).toBe(200);
    expect(res.text).toContain('docs/README.md');
    expect(res.text).toMatch(/<mark>sample markdown<\/mark>/i);
  });
});

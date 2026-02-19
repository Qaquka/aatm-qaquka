const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const HISTORY_PATH = path.join(DATA_DIR, 'history.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 20000);

const DEFAULT_CONFIG = {
  outputDir: '/nas/output',
  browseRoots: ['/nas/media'],
  torrent: {
    pieceSize: 0,
    privateFlag: true,
    announce: '',
    source: 'AATM-NAS'
  },
  qbit: {
    enabled: true,
    url: '',
    username: '',
    password: '',
    insecureTls: false,
    defaultCategory: 'Films',
    defaultTags: ''
  },
  transmission: {
    enabled: false,
    url: 'http://127.0.0.1:9091/transmission/rpc',
    username: '',
    password: ''
  },
  deluge: {
    enabled: false,
    url: 'http://127.0.0.1:8112/json',
    password: 'deluge'
  },
  lacale: {
    enabled: false,
    apiUrl: '',
    token: ''
  },
  categoryMapping: {
    Films: 'Films',
    Series: 'series',
    Ebooks: 'ebooks',
    Jeux: 'jeux'
  }
};

const torrentJobs = new Map();
const sseClients = new Map();
let qbitSession = { cookie: '', expiry: 0 };

function ensureStorage() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
  if (!fs.existsSync(HISTORY_PATH)) fs.writeFileSync(HISTORY_PATH, '[]');
}

function log(level, message, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, message, ...extra }));
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function getConfig() {
  const cfg = readJson(CONFIG_PATH, DEFAULT_CONFIG);
  return {
    ...DEFAULT_CONFIG,
    ...cfg,
    torrent: { ...DEFAULT_CONFIG.torrent, ...(cfg.torrent || {}) },
    qbit: { ...DEFAULT_CONFIG.qbit, ...(cfg.qbit || {}) },
    transmission: { ...DEFAULT_CONFIG.transmission, ...(cfg.transmission || {}) },
    deluge: { ...DEFAULT_CONFIG.deluge, ...(cfg.deluge || {}) },
    lacale: { ...DEFAULT_CONFIG.lacale, ...(cfg.lacale || {}) },
    categoryMapping: { ...DEFAULT_CONFIG.categoryMapping, ...(cfg.categoryMapping || {}) }
  };
}

function sanitizeConfigForResponse(cfg) {
  return {
    ...cfg,
    qbit: { ...cfg.qbit, password: cfg.qbit.password ? '********' : '' },
    transmission: { ...cfg.transmission, password: cfg.transmission.password ? '********' : '' },
    deluge: { ...cfg.deluge, password: cfg.deluge.password ? '********' : '' },
    lacale: { ...cfg.lacale, token: cfg.lacale.token ? '********' : '' }
  };
}

function isPathInside(base, candidate) {
  const rel = path.relative(base, candidate);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function validatePathInRoots(inputPath, roots) {
  const resolved = path.resolve(inputPath);
  for (const root of roots) {
    const absRoot = path.resolve(root);
    if (resolved === absRoot || isPathInside(absRoot, resolved)) return resolved;
  }
  throw new Error('Path is outside allowed browse roots');
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 30 * 1024 * 1024) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function serveStatic(req, res) {
  const rel = req.url === '/' ? '/index.html' : req.url;
  const normalized = path.normalize(rel).replace(/^\.+/, '');
  const target = path.join(PUBLIC_DIR, normalized);
  if (!target.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'Forbidden' });
  fs.readFile(target, (err, content) => {
    if (err) return sendJson(res, 404, { error: 'Not found' });
    const ext = path.extname(target);
    const map = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };
    res.writeHead(200, { 'Content-Type': `${map[ext] || 'application/octet-stream'}; charset=utf-8` });
    res.end(content);
  });
}

function appendHistory(event) {
  const all = readJson(HISTORY_PATH, []);
  all.unshift({ id: crypto.randomUUID(), ts: new Date().toISOString(), ...event });
  saveJson(HISTORY_PATH, all.slice(0, 500));
}

async function timedFetch(url, options = {}, allowInsecure = false) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      dispatcher: allowInsecure && String(url).startsWith('https://') ? new https.Agent({ rejectUnauthorized: false }) : undefined
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function qbitLogin(config, force = false) {
  const now = Date.now();
  if (!force && qbitSession.cookie && now < qbitSession.expiry) return;
  if (!config.qbit.url || !config.qbit.username || !config.qbit.password) throw new Error('qBittorrent configuration missing');

  const form = new URLSearchParams();
  form.set('username', config.qbit.username);
  form.set('password', config.qbit.password);

  const res = await timedFetch(new URL('/api/v2/auth/login', config.qbit.url), { method: 'POST', body: form }, config.qbit.insecureTls);
  const txt = await res.text();
  if (!res.ok || txt.trim() !== 'Ok.') throw new Error(`qBittorrent login failed (${res.status})`);

  const cookie = res.headers.get('set-cookie');
  if (!cookie) throw new Error('qBittorrent cookie missing');
  qbitSession = { cookie: cookie.split(';')[0], expiry: now + 25 * 60 * 1000 };
}

async function qbitRequest(config, endpoint, options = {}) {
  await qbitLogin(config, false);
  const headers = new Headers(options.headers || {});
  headers.set('Cookie', qbitSession.cookie);
  const url = new URL(endpoint, config.qbit.url);

  let res = await timedFetch(url, { ...options, headers }, config.qbit.insecureTls);
  if (res.status === 403) {
    await qbitLogin(config, true);
    headers.set('Cookie', qbitSession.cookie);
    res = await timedFetch(url, { ...options, headers }, config.qbit.insecureTls);
  }
  return res;
}

function classifyMedia(name) {
  const lower = name.toLowerCase();
  if (/(s\d{2}e\d{2}|season|episode)/i.test(lower)) return 'Series';
  if (/\.(epub|pdf|mobi|azw3)$/i.test(lower)) return 'Ebooks';
  if (/\.(iso|exe|pkg|msi)$/i.test(lower)) return 'Jeux';
  return 'Films';
}

function buildOutputPath(config, sourcePath, forcedType) {
  const mediaType = forcedType || classifyMedia(sourcePath);
  const base = path.basename(sourcePath).replace(path.extname(sourcePath), '');
  return path.join(config.outputDir, mediaType === 'Series' ? 'Séries' : mediaType, base);
}

function detectMediainfo() {
  return new Promise((resolve) => {
    const p = spawn('mediainfo', ['--Version']);
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

function runMediainfo(target) {
  return new Promise((resolve, reject) => {
    const proc = spawn('mediainfo', ['--Output=JSON', target]);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr || `mediainfo failed (${code})`));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Invalid mediainfo output')); }
    });
  });
}

function runCommandWithProgress(job, cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    job.process = proc;
    proc.stdout.on('data', (d) => {
      const txt = d.toString();
      job.logs.push(txt.trim());
      const match = txt.match(/(\d{1,3})%/);
      if (match) job.progress = Math.min(100, Number(match[1]));
      pushSse(job.id);
    });
    proc.stderr.on('data', (d) => {
      const txt = d.toString();
      job.logs.push(txt.trim());
      const match = txt.match(/(\d{1,3})%/);
      if (match) job.progress = Math.min(100, Number(match[1]));
      pushSse(job.id);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        job.progress = 100;
        job.status = 'completed';
        pushSse(job.id);
        return resolve();
      }
      reject(new Error(`Command exited with ${code}`));
    });
  });
}

function createNfoText({ sourcePath, mediaInfo, announce, source }) {
  return [
    'AATM NAS Edition NFO',
    `Source file: ${sourcePath}`,
    `Tracker announce: ${announce || 'N/A'}`,
    `Torrent source: ${source || 'N/A'}`,
    `Generated at: ${new Date().toISOString()}`,
    '',
    JSON.stringify(mediaInfo || {}, null, 2)
  ].join('\n');
}

function writeSse(client, data) {
  client.write(`data: ${JSON.stringify(data)}\n\n`);
}

function pushSse(jobId) {
  const clients = sseClients.get(jobId) || [];
  const job = torrentJobs.get(jobId);
  if (!job) return;
  for (const client of clients) writeSse(client, { id: job.id, status: job.status, progress: job.progress, logs: job.logs.slice(-15), error: job.error || null });
}

async function handleBrowse(req, res, cfg) {
  const query = new URL(req.url, `http://127.0.0.1:${PORT}`).searchParams;
  const requested = query.get('path') || cfg.browseRoots[0];
  const target = validatePathInRoots(requested, cfg.browseRoots);
  const entries = fs.readdirSync(target, { withFileTypes: true }).map((d) => ({
    name: d.name,
    type: d.isDirectory() ? 'dir' : 'file',
    path: path.join(target, d.name)
  }));
  sendJson(res, 200, { roots: cfg.browseRoots, current: target, entries });
}

async function handleMediainfo(req, res, cfg) {
  const body = await parseBody(req);
  const valid = validatePathInRoots(body.path, cfg.browseRoots);
  const available = await detectMediainfo();
  if (!available) return sendJson(res, 503, { error: 'mediainfo CLI not installed in container/host' });
  const report = await runMediainfo(valid);
  sendJson(res, 200, { path: valid, report });
}

async function handleMediainfoGet(req, res, cfg) {
  const query = new URL(req.url, `http://127.0.0.1:${PORT}`).searchParams;
  const requestedPath = query.get('path');
  if (!requestedPath) return sendJson(res, 400, { error: 'path query parameter is required' });
  const valid = validatePathInRoots(requestedPath, cfg.browseRoots);
  const available = await detectMediainfo();
  if (!available) return sendJson(res, 503, { error: 'mediainfo CLI not installed in container/host' });
  const report = await runMediainfo(valid);
  sendJson(res, 200, { path: valid, report });
}

async function handleCreateTorrent(req, res, cfg) {
  const body = await parseBody(req);
  const sourcePath = validatePathInRoots(body.path, cfg.browseRoots);
  const type = body.mediaType || classifyMedia(sourcePath);
  const outputDir = buildOutputPath(cfg, sourcePath, type);
  fs.mkdirSync(outputDir, { recursive: true });

  const baseName = path.basename(sourcePath);
  const torrentPath = path.join(outputDir, `${baseName}.torrent`);
  const nfoPath = path.join(outputDir, `${baseName}.nfo`);
  const id = crypto.randomUUID();
  const job = { id, status: 'running', progress: 2, logs: ['Job started'], error: '', sourcePath, outputDir, torrentPath, nfoPath };
  torrentJobs.set(id, job);

  const args = [];
  if (cfg.torrent.privateFlag) args.push('-p');
  if (cfg.torrent.pieceSize && Number(cfg.torrent.pieceSize) > 0) args.push('-l', String(cfg.torrent.pieceSize));
  if (cfg.torrent.announce) args.push('-a', cfg.torrent.announce);
  if (cfg.torrent.source) args.push('-s', cfg.torrent.source);
  args.push('-o', torrentPath, sourcePath);

  (async () => {
    try {
      job.logs.push('Creating torrent with mktorrent...');
      pushSse(id);
      await runCommandWithProgress(job, 'mktorrent', args);
      let mediaInfo = {};
      if (await detectMediainfo()) {
        try { mediaInfo = await runMediainfo(sourcePath); } catch {}
      }
      fs.writeFileSync(nfoPath, createNfoText({ sourcePath, mediaInfo, announce: cfg.torrent.announce, source: cfg.torrent.source }));
      job.logs.push('NFO generated');
      pushSse(id);

      appendHistory({
        sourcePath,
        outputDir,
        torrentPath,
        nfoPath,
        mediaType: type,
        torrentCreated: true,
        nfoCreated: true,
        lacaleUpload: 'pending',
        qbitPush: 'pending'
      });
    } catch (error) {
      job.status = 'failed';
      job.error = error.message;
      job.logs.push(error.message);
      pushSse(id);
      appendHistory({ sourcePath, outputDir, torrentPath, nfoPath, mediaType: type, torrentCreated: false, nfoCreated: false, lacaleUpload: 'ko', qbitPush: 'ko', error: error.message });
    }
  })();

  sendJson(res, 202, { jobId: id, outputDir, torrentPath, nfoPath });
}

async function handleSse(req, res) {
  const jobId = new URL(req.url, `http://127.0.0.1:${PORT}`).searchParams.get('jobId');
  if (!jobId || !torrentJobs.has(jobId)) return sendJson(res, 404, { error: 'Unknown job' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    Connection: 'keep-alive',
    'Cache-Control': 'no-cache'
  });

  const list = sseClients.get(jobId) || [];
  list.push(res);
  sseClients.set(jobId, list);
  pushSse(jobId);
  req.on('close', () => {
    const arr = sseClients.get(jobId) || [];
    sseClients.set(jobId, arr.filter((r) => r !== res));
  });
}

async function handleQbitCategories(res, cfg) {
  const qres = await qbitRequest(cfg, '/api/v2/torrents/categories');
  const txt = await qres.text();
  if (!qres.ok) return sendJson(res, 502, { error: 'qBittorrent categories failed', details: txt });
  sendJson(res, 200, JSON.parse(txt || '{}'));
}

async function handlePushQbit(req, res, cfg) {
  const body = await parseBody(req);
  if (!body.torrentPath || !body.category) return sendJson(res, 400, { error: 'torrentPath and category required' });
  const filePath = path.resolve(body.torrentPath);
  if (!fs.existsSync(filePath) || path.extname(filePath).toLowerCase() !== '.torrent') return sendJson(res, 400, { error: 'Invalid torrentPath' });

  const data = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('torrents', new Blob([data], { type: 'application/x-bittorrent' }), path.basename(filePath));
  form.append('category', body.category);
  form.append('autoTMM', 'true');
  form.append('skip_checking', 'false');
  if (body.tags) form.append('tags', String(body.tags));

  const qres = await qbitRequest(cfg, '/api/v2/torrents/add', { method: 'POST', body: form });
  const txt = await qres.text();
  if (!qres.ok) return sendJson(res, 502, { error: 'qBittorrent add failed', details: txt });

  appendHistory({ sourcePath: body.sourcePath || '', torrentPath: filePath, nfoPath: body.nfoPath || '', mediaType: body.mediaType || '', torrentCreated: true, nfoCreated: true, lacaleUpload: 'pending', qbitPush: 'ok' });
  sendJson(res, 200, { ok: true, message: 'Torrent pushed to qBittorrent seedbox' });
}

async function handleUploadLaCale(req, res, cfg) {
  const body = await parseBody(req);
  if (!cfg.lacale.enabled) return sendJson(res, 400, { error: 'La-Cale disabled in config' });
  if (!cfg.lacale.apiUrl || !cfg.lacale.token) return sendJson(res, 400, { error: 'La-Cale API settings missing' });

  const torrentPath = path.resolve(body.torrentPath || '');
  if (!fs.existsSync(torrentPath)) return sendJson(res, 400, { error: 'torrentPath not found' });

  const form = new FormData();
  form.append('torrent', new Blob([fs.readFileSync(torrentPath)]), path.basename(torrentPath));
  form.append('category', body.category || 'Films');
  form.append('tags', body.tags || '');
  form.append('title', body.title || path.basename(torrentPath, '.torrent'));

  const response = await timedFetch(cfg.lacale.apiUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.lacale.token}` },
    body: form
  });
  const txt = await response.text();
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return sendJson(res, 401, { error: 'La-Cale authentication failed', details: txt.slice(0, 500) });
    }
    if (response.status === 429) {
      return sendJson(res, 429, { error: 'La-Cale rate limit exceeded', details: txt.slice(0, 500) });
    }
    return sendJson(res, 502, { error: 'La-Cale upload failed', details: txt.slice(0, 500) });
  }

  appendHistory({ sourcePath: body.sourcePath || '', torrentPath, nfoPath: body.nfoPath || '', mediaType: body.mediaType || '', torrentCreated: true, nfoCreated: true, lacaleUpload: 'ok', qbitPush: 'pending' });
  sendJson(res, 200, { ok: true, details: txt.slice(0, 500) });
}

async function handleNfoCreate(req, res, cfg) {
  const body = await parseBody(req);
  if (!body.path) return sendJson(res, 400, { error: 'path is required' });
  const sourcePath = validatePathInRoots(body.path, cfg.browseRoots);
  const type = body.mediaType || classifyMedia(sourcePath);
  const outputDir = buildOutputPath(cfg, sourcePath, type);
  fs.mkdirSync(outputDir, { recursive: true });

  let mediaInfo = {};
  if (await detectMediainfo()) {
    try { mediaInfo = await runMediainfo(sourcePath); } catch {}
  }

  const baseName = path.basename(sourcePath);
  const nfoPath = path.join(outputDir, `${baseName}.nfo`);
  fs.writeFileSync(nfoPath, createNfoText({ sourcePath, mediaInfo, announce: cfg.torrent.announce, source: cfg.torrent.source }));

  appendHistory({
    sourcePath,
    outputDir,
    torrentPath: body.torrentPath || '',
    nfoPath,
    mediaType: type,
    torrentCreated: Boolean(body.torrentPath),
    nfoCreated: true,
    lacaleUpload: 'pending',
    qbitPush: 'pending'
  });

  sendJson(res, 200, { ok: true, nfoPath, outputDir });
}

async function handleLaCalePreview(req, res) {
  const body = await parseBody(req);
  const title = body.title || (body.torrentPath ? path.basename(body.torrentPath, path.extname(body.torrentPath)) : '');
  const preview = {
    title,
    category: body.category || 'Films',
    tags: body.tags || ''
  };
  sendJson(res, 200, { ok: true, preview });
}

async function handleTransmission(req, res, cfg) {
  const body = await parseBody(req);
  if (!cfg.transmission.enabled) return sendJson(res, 400, { error: 'Transmission disabled' });
  const torrentData = fs.readFileSync(path.resolve(body.torrentPath)).toString('base64');

  const payload = { method: 'torrent-add', arguments: { metainfo: torrentData } };
  let headers = { 'Content-Type': 'application/json' };
  if (cfg.transmission.username) {
    const auth = Buffer.from(`${cfg.transmission.username}:${cfg.transmission.password}`).toString('base64');
    headers.Authorization = `Basic ${auth}`;
  }
  let response = await timedFetch(cfg.transmission.url, { method: 'POST', headers, body: JSON.stringify(payload) });
  if (response.status === 409) {
    const sessionId = response.headers.get('X-Transmission-Session-Id');
    headers['X-Transmission-Session-Id'] = sessionId;
    response = await timedFetch(cfg.transmission.url, { method: 'POST', headers, body: JSON.stringify(payload) });
  }
  const txt = await response.text();
  if (!response.ok) return sendJson(res, 502, { error: 'Transmission add failed', details: txt.slice(0, 500) });
  sendJson(res, 200, { ok: true, details: txt.slice(0, 500) });
}

async function handleDeluge(req, res, cfg) {
  const body = await parseBody(req);
  if (!cfg.deluge.enabled) return sendJson(res, 400, { error: 'Deluge disabled' });
  const torrentPath = path.resolve(body.torrentPath);
  const data = fs.readFileSync(torrentPath).toString('base64');

  const loginPayload = { method: 'auth.login', params: [cfg.deluge.password], id: 1 };
  const login = await timedFetch(cfg.deluge.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(loginPayload) });
  const cookie = login.headers.get('set-cookie');
  const addPayload = { method: 'core.add_torrent_file', params: [path.basename(torrentPath), data, {}], id: 2 };
  const addRes = await timedFetch(cfg.deluge.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie ? cookie.split(';')[0] : '' },
    body: JSON.stringify(addPayload)
  });
  const txt = await addRes.text();
  if (!addRes.ok) return sendJson(res, 502, { error: 'Deluge add failed', details: txt.slice(0, 500) });
  sendJson(res, 200, { ok: true, details: txt.slice(0, 500) });
}

async function route(req, res) {
  const cfg = getConfig();
  try {
    if (req.method === 'GET' && req.url === '/api/health') return sendJson(res, 200, { ok: true });
    if (req.method === 'GET' && req.url === '/api/config') return sendJson(res, 200, sanitizeConfigForResponse(cfg));
    if (req.method === 'POST' && req.url === '/api/config') {
      const body = await parseBody(req);
      const merged = {
        ...cfg,
        ...body,
        torrent: { ...cfg.torrent, ...(body.torrent || {}) },
        qbit: { ...cfg.qbit, ...(body.qbit || {}) },
        transmission: { ...cfg.transmission, ...(body.transmission || {}) },
        deluge: { ...cfg.deluge, ...(body.deluge || {}) },
        lacale: { ...cfg.lacale, ...(body.lacale || {}) },
        categoryMapping: { ...cfg.categoryMapping, ...(body.categoryMapping || {}) }
      };
      if (!Array.isArray(merged.browseRoots) || merged.browseRoots.length === 0) return sendJson(res, 400, { error: 'browseRoots required' });
      saveJson(CONFIG_PATH, merged);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && req.url.startsWith('/api/browse')) return await handleBrowse(req, res, cfg);
    if (req.method === 'GET' && req.url.startsWith('/api/mediainfo')) return await handleMediainfoGet(req, res, cfg);
    if (req.method === 'POST' && req.url === '/api/mediainfo') return await handleMediainfo(req, res, cfg);
    if (req.method === 'POST' && req.url === '/api/torrent/create') return await handleCreateTorrent(req, res, cfg);
    if (req.method === 'GET' && req.url.startsWith('/api/torrent/progress')) return await handleSse(req, res);
    if (req.method === 'POST' && req.url === '/api/nfo/create') return await handleNfoCreate(req, res, cfg);
    if (req.method === 'POST' && req.url === '/api/lacale/preview') return await handleLaCalePreview(req, res);
    if (req.method === 'GET' && req.url === '/api/qbit/categories') return await handleQbitCategories(res, cfg);
    if (req.method === 'POST' && req.url === '/api/torrent/push') return await handlePushQbit(req, res, cfg);
    if (req.method === 'POST' && req.url === '/api/lacale/upload') return await handleUploadLaCale(req, res, cfg);
    if (req.method === 'POST' && req.url === '/api/transmission/push') return await handleTransmission(req, res, cfg);
    if (req.method === 'POST' && req.url === '/api/deluge/push') return await handleDeluge(req, res, cfg);
    if (req.method === 'GET' && req.url === '/api/history') return sendJson(res, 200, readJson(HISTORY_PATH, []));

    if (req.url.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
    serveStatic(req, res);
  } catch (error) {
    const safeMsg = /password|token/i.test(error.message) ? 'Operation failed' : error.message;
    log('error', 'Request failed', { method: req.method, path: req.url, error: safeMsg });
    sendJson(res, 500, { error: safeMsg });
  }
}

ensureStorage();
http.createServer(route).listen(PORT, () => log('info', 'AATM NAS edition listening', { port: PORT }));

const $ = (id) => document.getElementById(id);
let selectedPath = '';
let latestTorrentPath = '';
let latestNfoPath = '';
let latestLaCalePreview = null;

async function api(url, options = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function setText(id, text) { $(id).textContent = text; }

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderBbcodeToHtml(bbcode) {
  let html = escapeHtml(bbcode || '');
  html = html
    .replace(/\[b\](.*?)\[\/b\]/gis, '<strong>$1</strong>')
    .replace(/\[i\](.*?)\[\/i\]/gis, '<em>$1</em>')
    .replace(/\[u\](.*?)\[\/u\]/gis, '<u>$1</u>')
    .replace(/\[img\](.*?)\[\/img\]/gis, '<img src="$1" alt="img"/>')
    .replace(/\[url=(.*?)\](.*?)\[\/url\]/gis, '<a href="$1" target="_blank" rel="noopener noreferrer">$2</a>')
    .replace(/\[url\](.*?)\[\/url\]/gis, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\n/g, '<br/>');
  return html;
}

async function loadConfig() {
  const cfg = await api('/api/config');
  $('configJson').value = JSON.stringify(cfg, null, 2);
  $('pathInput').value = cfg.browseRoots?.[0] || '/';
}

async function browse(pathValue) {
  const data = await api(`/api/browse?path=${encodeURIComponent(pathValue || $('pathInput').value)}`);
  $('pathInput').value = data.current;
  const rootItems = data.current !== data.roots[0] ? [{ name: '..', type: 'dir', path: data.current.split('/').slice(0, -1).join('/') || '/' }] : [];
  const entries = [...rootItems, ...data.entries];
  $('entries').innerHTML = entries.map((e) => `<li data-path="${e.path}" data-type="${e.type}">${e.type === 'dir' ? '📁' : '📄'} ${e.name}</li>`).join('');
  for (const li of $('entries').querySelectorAll('li')) {
    li.onclick = () => {
      const p = li.dataset.path;
      const t = li.dataset.type;
      if (t === 'dir') browse(p);
      else {
        selectedPath = p;
        setText('selectedPath', p);
      }
    };
  }
}

async function runMediaInfo() {
  if (!selectedPath) return setText('mediainfoOut', 'Sélectionne un fichier vidéo.');
  try {
    const data = await api('/api/mediainfo', { method: 'POST', body: JSON.stringify({ path: selectedPath }) });
    setText('mediainfoOut', JSON.stringify(data.report, null, 2));
  } catch (e) {
    setText('mediainfoOut', e.message);
  }
}

async function createTorrent() {
  if (!selectedPath) return setText('torrentProgress', 'Sélectionne un fichier/dossier.');
  const mediaType = $('mediaType').value;
  const data = await api('/api/torrent/create', { method: 'POST', body: JSON.stringify({ path: selectedPath, mediaType }) });
  latestTorrentPath = data.torrentPath;
  latestNfoPath = data.nfoPath;
  setText('torrentPath', latestTorrentPath);
  setText('nfoPath', latestNfoPath);

  const ev = new EventSource(`/api/torrent/progress?jobId=${encodeURIComponent(data.jobId)}`);
  ev.onmessage = (msg) => {
    const p = JSON.parse(msg.data);
    setText('torrentProgress', `Status: ${p.status}\nProgress: ${p.progress}%\n\n${(p.logs || []).join('\n')}${p.error ? `\nERROR: ${p.error}` : ''}`);
    if (p.status === 'completed' || p.status === 'failed') ev.close();
  };
}

async function loadQbitCategories() {
  const data = await api('/api/qbit/categories');
  const entries = Object.entries(data);
  $('qbitCategory').innerHTML = entries.map(([name, meta]) => `<option value="${name}">${name} (${meta.savePath || 'auto'})</option>`).join('');
}

async function pushQbit() {
  if (!latestTorrentPath) return setText('qbitStatus', 'Aucun torrent généré.');
  try {
    await api('/api/torrent/push', { method: 'POST', body: JSON.stringify({ torrentPath: latestTorrentPath, category: $('qbitCategory').value, tags: $('qbitTags').value, sourcePath: selectedPath, nfoPath: latestNfoPath, mediaType: $('mediaType').value }) });
    setText('qbitStatus', '✅ Push qBittorrent OK');
  } catch (e) {
    setText('qbitStatus', `❌ ${e.message}`);
  }
}

async function previewLaCale() {
  if (!latestTorrentPath) return setText('lacaleStatus', 'Aucun torrent généré.');
  const payload = {
    torrentPath: latestTorrentPath,
    title: $('torrentPath').textContent && $('torrentPath').textContent !== '-' ? $('torrentPath').textContent.split('/').pop().replace(/\.torrent$/i, '') : '',
    categoryName: $('lacaleCategory').value,
    tags: $('lacaleTags').value,
    description: $('lacaleDescription').value
  };

  try {
    const data = await api('/api/lacale/preview', { method: 'POST', body: JSON.stringify(payload) });
    latestLaCalePreview = data.preview;
    setText('lacalePreviewRaw', JSON.stringify(data.preview, null, 2));
    $('lacaleDescription').value = data.preview.description;
    $('lacalePreviewHtml').innerHTML = renderBbcodeToHtml(data.preview.description);
    setText('lacaleStatus', 'Prévisualisation La-Cale prête.');
  } catch (e) {
    setText('lacaleStatus', `❌ ${e.message}`);
  }
}

async function pushLaCale() {
  if (!latestTorrentPath) return setText('lacaleStatus', 'Aucun torrent généré.');
  if (!latestLaCalePreview) {
    await previewLaCale();
    if (!latestLaCalePreview) return;
  }

  const payload = {
    torrentPath: latestTorrentPath,
    nfoPath: latestNfoPath,
    sourcePath: selectedPath,
    mediaType: $('mediaType').value,
    title: latestLaCalePreview.title,
    categoryName: latestLaCalePreview.categoryName,
    categoryId: latestLaCalePreview.categoryId,
    tags: latestLaCalePreview.tags,
    description: $('lacaleDescription').value,
    tmdbId: latestLaCalePreview.tmdbId || '',
    tmdbType: latestLaCalePreview.tmdbType || ''
  };

  try {
    const data = await api('/api/lacale/upload', { method: 'POST', body: JSON.stringify(payload) });
    setText('lacaleStatus', `✅ Upload La-Cale OK\n${data.details || ''}`);
  } catch (e) {
    setText('lacaleStatus', `❌ ${e.message}`);
  }
}

async function saveConfig() {
  try {
    const json = JSON.parse($('configJson').value);
    await api('/api/config', { method: 'POST', body: JSON.stringify(json) });
    setText('configStatus', '✅ Config sauvegardée');
  } catch (e) {
    setText('configStatus', `❌ ${e.message}`);
  }
}

async function loadHistory() {
  const data = await api('/api/history');
  setText('historyOut', JSON.stringify(data.slice(0, 50), null, 2));
}

$('browseBtn').onclick = () => browse();
$('mediainfoBtn').onclick = runMediaInfo;
$('createTorrentBtn').onclick = createTorrent;
$('loadCatsBtn').onclick = loadQbitCategories;
$('pushQbitBtn').onclick = pushQbit;
$('previewLacaleBtn').onclick = previewLaCale;
$('uploadLacaleBtn').onclick = pushLaCale;
$('saveConfigBtn').onclick = saveConfig;
$('refreshHistoryBtn').onclick = loadHistory;
$('lacaleDescription').addEventListener('input', () => {
  $('lacalePreviewHtml').innerHTML = renderBbcodeToHtml($('lacaleDescription').value);
});

(async () => {
  await loadConfig();
  await browse();
  await loadHistory();
})();

importScripts("hls-parse.js", "dash-parse.js", "series.js");

const VIDEO_EXT = /\.(mp4|webm|mkv|mov|m4v|ogv)(\?|#|$)/i;
const HLS_RE = /\.m3u8(\?|#|$)/i;
const DASH_RE = /\.mpd(\?|#|$)/i;
const SEGMENT_RE = /\.(m4s|cmfv|cmfa|cmfm)(\?|#|$)/i; // DASH/CMAF parçaları tek başına oynatılamaz
// Tek başına anlamsız parça istekleri (ör. YouTube videoplayback, ?range=... ile parça parça çekilenler)
const CHUNK_RE = /\/videoplayback(\?|$)|[?&](range|bytestart|byterange)=/i;
const TYPE_EXT = {
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
  "video/x-matroska": "mkv", "video/ogg": "ogv", "video/x-m4v": "m4v"
};
let queue = Promise.resolve();
const enqueue = (fn) => (queue = queue.then(fn).catch(console.error));
const key = (tabId) => `v_${tabId}`;

// OFF işaretliyken araç çubuğu simgesi mavi olur
const ICONS = {
  on: { 16: "icons/icon16.png", 32: "icons/icon32.png" },
  off: { 16: "icons/blue16.png", 32: "icons/blue32.png" }
};
async function applyIcon() {
  const st = await getSettings();
  chrome.action.setIcon({ path: st.off ? ICONS.off : ICONS.on }).catch(() => {});
}
applyIcon(); // servis her uyandığında (simge kalıcı değil)
chrome.runtime.onInstalled.addListener(applyIcon);
chrome.runtime.onStartup.addListener(applyIcon);

chrome.action.setBadgeBackgroundColor({ color: "#111111" });
chrome.action.setBadgeTextColor?.({ color: "#ffffff" });

/* ---------- depolama ---------- */
async function getList(tabId) {
  const r = await chrome.storage.session.get(key(tabId));
  return r[key(tabId)] || [];
}
const belowKey = (tabId) => `bl_${tabId}`;
// "1080 altı" yalnızca ilgili sekme/sayfa için etkindir; varsayılan her zaman 1080 üstü
async function getSettings(tabId) {
  const r = await chrome.storage.local.get({ off: false });
  let below = false;
  if (tabId != null && tabId >= 0) below = !!(await chrome.storage.session.get(belowKey(tabId)))[belowKey(tabId)];
  return { above: !below, below, off: !!r.off };
}
const itemHeights = (v) => (v.heights && v.heights.length ? v.heights : v.height ? [v.height] : null);
// Varsayılan: 1080p ve üstü; "1080 altı" etkinse 1080p ve altı
function passes(v, s) {
  const hs = itemHeights(v); // kalite bilinmiyorsa listede kalır
  if (!hs) return true;
  return hs.some((h) => (s.above ? h >= 1080 : h <= 1080));
}
const pendingDims = new Map();
async function refreshBadge(tabId, list) {
  const st = await getSettings(tabId);
  const n = st.off ? 0 : list.filter((v) => passes(v, st)).length;
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : "" }).catch(() => {});
}
async function setList(tabId, list) {
  await chrome.storage.session.set({ [key(tabId)]: list });
  await refreshBadge(tabId, list);
}
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && ch.off) applyIcon();
  const belowChanged = area === "session" && Object.keys(ch).some((k) => k.startsWith("bl_"));
  if (!belowChanged && !(area === "local" && ch.off)) return;
  enqueue(async () => {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) await refreshBadge(t.id, await getList(t.id));
  });
});

// KAPAT işaretliyken hiçbir şey algılanmaz / eklenmez
const isOff = async () => (await getSettings()).off;

async function addItem(tabId, item) {
  if (await isOff()) return;
  const list = await getList(tabId);
  if (list.some((v) => v.url === item.url)) return;
  if (item.kind === "hls") {
    if (item.variants) {
      for (let i = list.length - 1; i >= 0; i--)
        if (list[i].kind === "hls" && item.variants.includes(list[i].url)) list.splice(i, 1);
    } else if (list.some((v) => v.variants && v.variants.includes(item.url))) return;
  }
  if (item.kind === "dash" && item.members) {
    for (let i = list.length - 1; i >= 0; i--)
      if (list[i].kind === "file" && item.members.includes(list[i].url)) list.splice(i, 1);
  } else if (item.kind === "file" && list.some((v) => v.members && v.members.includes(item.url))) return;
  if (item.kind === "file" && pendingDims.has(item.url)) item.height = pendingDims.get(item.url);
  list.push(item);
  await setList(tabId, list);
}

/* ---------- Referer ayarı (indirme/çekme isteklerinde) ---------- */
async function setReferer(ref) {
  try {
    const origin = new URL(ref).origin;
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [1],
      addRules: [{
        id: 1, priority: 1,
        action: { type: "modifyHeaders", requestHeaders: [
          { header: "referer", operation: "set", value: ref },
          { header: "origin", operation: "set", value: origin }
        ] },
        condition: { tabIds: [-1], resourceTypes: ["xmlhttprequest", "other", "media"] }
      }]
    });
  } catch (e) { console.warn("referer rule", e); }
}

/* ---------- tespit ---------- */
async function handleHls(tabId, url, pre = null) {
  if (await isOff()) return;
  const exists = (await getList(tabId)).some((v) => v.url === url);
  if (exists) return;
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; }
  let parsed = null;
  try {
    if (pre != null) parsed = parsePlaylist(pre, url);
    else {
      await setReferer(tab.url);
      const r = await fetch(url, { credentials: "include" });
      if (r.ok) parsed = parsePlaylist(await r.text(), url);
    }
  } catch {}
  let item = { url, size: 0, ext: "ts", kind: "hls", label: "HLS" };
  if (parsed && parsed.master) {
    if (!parsed.variants.length) return;
    const best = parsed.variants[0];
    item.variants = parsed.variants.map((v) => v.url);
    item.heights = [...new Set(parsed.variants.map((v) => snapHeight(v.resolution)).filter(Boolean))].sort((a, b) => b - a);
    item.label = "HLS" + (item.heights.length ? " · " + item.heights.slice(0, 3).map((h) => h + "p").join(", ") : "");
  } else if (parsed) {
    const s = Math.round(parsed.duration);
    const t = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    if (parsed.segments.length < 3) return; // reklam/önizleme gibi çok kısa listeler
    item.label = "HLS · " + t + (parsed.endlist ? "" : " (canlı)") + " · kalite ?";
    if (!parsed.endlist) item.live = true; // canlı yayınlar otomatik indirilmez
  }
  enqueue(() => addItem(tabId, item));
}

async function handleDash(tabId, url) {
  if (await isOff()) return;
  if ((await getList(tabId)).some((v) => v.url === url)) return;
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; }
  let info = null;
  try {
    await setReferer(tab.url);
    const r = await fetch(url, { credentials: "include" });
    if (r.ok) info = parseMpd(await r.text(), url);
  } catch {}
  if (!info || info.live || !info.video.length) return; // canlı / DRM / okunamayan
  const heights = [...new Set(info.video.map((v) => snapDims(v.width, v.height)).filter(Boolean))].sort((a, b) => b - a);
  let label = "DASH" + (heights.length ? " · " + heights.slice(0, 3).map((h) => h + "p").join(", ") : "");
  if (info.duration) {
    const s = Math.round(info.duration);
    label += ` · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  if (info.audio.length) label += " · ses dahil";
  const members = [...info.video, ...info.audio].filter((r) => r.single).map((r) => r.base);
  enqueue(() => addItem(tabId, { url, size: 0, ext: "mp4", kind: "dash", label, heights, members }));
}

function addFile(tabId, url, size, ext) {
  enqueue(() => addItem(tabId, { url, size, ext, kind: "file" }));
}

async function handleFound(tabId, url) {
  if (await isOff()) return;
  if (HLS_RE.test(url)) return handleHls(tabId, url);
  if (DASH_RE.test(url)) return handleDash(tabId, url);
  if (SEGMENT_RE.test(url) || CHUNK_RE.test(url)) return;
  const em = url.match(VIDEO_EXT);
  if (em) return addFile(tabId, url, 0, em[1].toLowerCase());
  try {
    const r = await fetch(url, { method: "HEAD" });
    const type = (r.headers.get("content-type") || "").split(";")[0].toLowerCase();
    if (type.startsWith("video/")) {
      addFile(tabId, url, parseInt(r.headers.get("content-length") || "0", 10), TYPE_EXT[type] || "mp4");
    }
  } catch {}
}

/* ---------- uzantısız / türü gizlenmiş HLS listelerini içeriğinden tanı ---------- */
// Bazı siteler m3u8'i /w/abc123 gibi adreslerde "application/octet-stream" olarak sunar.
const SNIFF_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream", "text/plain", "application/x-unknown", "application/unknown"]);
const STATIC_EXT = /\.(js|mjs|css|json|jpe?g|png|gif|webp|avif|svg|ico|woff2?|ttf|ts|m4s|mp4|webm|html?|xml|map)(\?|#|$)/i;
const sniffed = new Set();
function maybePlaylist(url, type, h) {
  if (!SNIFF_TYPES.has(type) || STATIC_EXT.test(url)) return false;
  return parseInt(h["content-length"] || "0", 10) <= 2 * 1024 * 1024;
}
async function sniffPlaylist(tabId, url) {
  if (sniffed.has(url) || (await isOff())) return;
  sniffed.add(url);
  if (sniffed.size > 800) sniffed.delete(sniffed.values().next().value);
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; }
  try {
    await setReferer(tab.url);
    const r = await fetch(url, { credentials: "include" });
    if (!r.ok || !r.body) return;
    const reader = r.body.getReader();
    const first = await reader.read();
    const head = new TextDecoder().decode((first.value || new Uint8Array()).subarray(0, 16)).trim();
    if (!head.startsWith("#EXTM3U")) { reader.cancel().catch(() => {}); return; }
    const chunks = [first.value];
    for (;;) { const x = await reader.read(); if (x.done) break; chunks.push(x.value); }
    const text = new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
    await handleHls(tabId, url, text);
  } catch {}
}

chrome.webRequest.onHeadersReceived.addListener((d) => {
  if (d.tabId < 0) return;
  const h = {};
  for (const x of d.responseHeaders || []) h[x.name.toLowerCase()] = x.value || "";
  const type = (h["content-type"] || "").split(";")[0].trim().toLowerCase();

  if (type.includes("mpegurl") || (HLS_RE.test(d.url) && !type.startsWith("text/html"))) {
    handleHls(d.tabId, d.url);
    return;
  }
  if (type.includes("dash+xml") || (DASH_RE.test(d.url) && !type.startsWith("text/html"))) {
    handleDash(d.tabId, d.url);
    return;
  }
  if (maybePlaylist(d.url, type, h)) { sniffPlaylist(d.tabId, d.url); return; }
  if (SEGMENT_RE.test(d.url) || CHUNK_RE.test(d.url)) return;
  const isVideo = type.startsWith("video/") || (VIDEO_EXT.test(d.url) && !type.startsWith("text/"));
  if (!isVideo) return;
  let size = parseInt(h["content-length"] || "0", 10);
  const m = (h["content-range"] || "").match(/\/(\d+)$/);
  if (m) size = parseInt(m[1], 10);
  if (size && size < 100 * 1024) return;
  let ext = TYPE_EXT[type];
  if (!ext) {
    const em = d.url.match(VIDEO_EXT);
    ext = em ? em[1].toLowerCase() : "mp4";
  }
  addFile(d.tabId, d.url, size, ext);
}, { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] }, ["responseHeaders"]);

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading" && info.url) enqueue(async () => {
    // sayfa değişince "1080 altı" sıfırlanır (seri modu bu sekmede çalışıyorsa korunur)
    const s = await getSeries().catch(() => null);
    if (!(s && s.running && s.tabId === tabId)) await chrome.storage.session.remove(belowKey(tabId));
    await setList(tabId, []);
  });
});
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove([key(tabId), belowKey(tabId)]));

/* ---------- indirme işleri (popup'ta ilerleme çubuğu olarak gösterilir) ---------- */
let jobQ = Promise.resolve();
const jobEnq = (fn) => (jobQ = jobQ.then(fn).catch(console.error));
async function getJobs() {
  return (await chrome.storage.session.get("jobs")).jobs || [];
}
const addJob = (job) => jobEnq(async () => {
  const jobs = await getJobs();
  jobs.push(job);
  await chrome.storage.session.set({ jobs });
});
const isEnd = (p) => p.state === "done" || p.state === "error";
// Başarıyla biten işler listeden hemen kalkar (not içerenler ve hatalılar "Temizle"ye kadar kalır)
async function commitJobs(jobs, j) {
  if (j.state === "done" && j.text === "Bitti ✓") {
    jobs = jobs.filter((x) => x !== j);
    if (j.fromSeries) bumpDownloaded();
  }
  await chrome.storage.session.set({ jobs });
}
const patchJob = (id, patch) => jobEnq(async () => {
  const jobs = await getJobs();
  const j = jobs.find((x) => x.id === id);
  if (!j) return;
  Object.assign(j, patch);
  await commitJobs(jobs, j);
  if (isEnd(patch)) pump();
});
const patchByDl = (dlId, patch) => jobEnq(async () => {
  const jobs = await getJobs();
  const j = jobs.find((x) => x.kind === "file" && x.dlId === dlId);
  if (!j) return;
  Object.assign(j, patch);
  await commitJobs(jobs, j);
  if (isEnd(patch)) pump();
});

/* ---------- bekleme listesi: aynı anda tek indirme ---------- */
async function startJob(job) {
  try {
    if (job.kind === "hls" || job.kind === "dash") {
      const st = await getSettings();
      await ensureOffscreen();
      if (!(await getJobs()).some((j) => j.id === job.id)) return; // başlamadan iptal edildi
      await chrome.runtime.sendMessage({
        type: "off-start", st,
        job: { id: job.id, url: job.url, name: job.name, ref: job.ref, kind: job.kind, folder: job.folder || "" }
      });
    } else {
      await setReferer(job.ref);
      const dlId = await chrome.downloads.download({ url: job.url, filename: job.filename, conflictAction: "uniquify" });
      if (!(await getJobs()).some((j) => j.id === job.id)) { chrome.downloads.cancel(dlId).catch(() => {}); return; }
      await patchJob(job.id, { dlId });
      const [it] = await chrome.downloads.search({ id: dlId });
      if (it) syncFileState(dlId, it.state); // çok hızlı bittiyse
    }
  } catch (e) {
    patchJob(job.id, { state: "error", text: "Hata: " + e.message });
  }
}
const pump = () => jobEnq(async () => {
  const jobs = await getJobs();
  const running = jobs.find((j) => j.state === "running");
  if (running) {
    // indirici belge beklenmedik şekilde kapandıysa sırayı tıkamasın
    const stalled = running.kind !== "file" && Date.now() - (running.startedAt || 0) > 15000 &&
      !(await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length;
    if (!stalled) return;
    running.state = "error";
    running.text = "Hata: indirici durdu";
  }
  const next = jobs.find((j) => j.state === "queued");
  if (next) {
    next.state = "running";
    next.startedAt = Date.now();
    next.text = "Hazırlanıyor…";
  }
  await chrome.storage.session.set({ jobs });
  if (next) startJob({ ...next });
});
// Sıradakini siler; inmekte olanı durdurup siler ve sıradakini başlatır
const cancelJob = (id) => jobEnq(async () => {
  const jobs = await getJobs();
  const j = jobs.find((x) => x.id === id);
  if (!j) return;
  await chrome.storage.session.set({ jobs: jobs.filter((x) => x.id !== id) });
  if (j.state !== "running") return;
  if (j.kind === "file") { if (j.dlId != null) chrome.downloads.cancel(j.dlId).catch(() => {}); }
  else chrome.runtime.sendMessage({ type: "off-cancel", id }).catch(() => {});
  pump();
  maybeCloseOffscreen();
});
const removeJobs = (pred) => jobEnq(async () => {
  const jobs = (await getJobs()).filter((j) => !pred(j));
  await chrome.storage.session.set({ jobs });
});

function syncFileState(dlId, state) {
  if (state === "complete") patchByDl(dlId, { state: "done", pct: 100, text: "Bitti ✓" });
  else if (state === "interrupted") patchByDl(dlId, { state: "error", text: "İndirme kesildi" });
}
chrome.downloads.onChanged.addListener((d) => {
  if (d.state) syncFileState(d.id, d.state.current);
});

// HLS/DASH indirmeleri görünmez bir offscreen belgede yürür (pencere açılmaz)
let creatingOff = null;
async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (ctx.length) return;
  if (!creatingOff) {
    creatingOff = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "Video parçalarını indirip tek dosyada birleştirmek için"
    }).finally(() => { creatingOff = null; });
  }
  await creatingOff;
}
const maybeCloseOffscreen = () => jobEnq(async () => {
  const jobs = await getJobs();
  if (jobs.some((j) => j.kind !== "file" && (j.state === "running" || j.state === "queued"))) return;
  chrome.offscreen.closeDocument().catch(() => {});
});

// İndirme isteklerine Referer/Origin ekler (offscreen belge kendi ayarlayamaz)
async function setDlReferer(ref) {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [2],
      addRules: [{
        id: 2, priority: 10,
        action: { type: "modifyHeaders", requestHeaders: [
          { header: "referer", operation: "set", value: ref },
          { header: "origin", operation: "set", value: new URL(ref).origin }
        ] },
        condition: { tabIds: [-1], resourceTypes: ["xmlhttprequest", "other", "media"] }
      }]
    });
  } catch {}
}

/* ---------- indirme ---------- */
// auto=true: aynı adres bu oturumda daha önce otomatik eklendiyse (bitmiş, silinmiş ya da sayfa yenilenmiş olsa da) tekrar eklenmez
const cleanDir = (s) => String(s || "").split(/[\\/]+/)
  .map((p) => p.replace(/[:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, ""))
  .filter((p) => p && p !== "." && p !== "..").join("/");
// Ortak başlık klasörü: "Psyren 1. Bölüm izle | Site" -> "Psyren"; bölüm no yoksa başlığın kendisi klasör olur
function groupFolder(title) {
  let t = String(title || "").split(/\s+[|–—]\s+|\s+-\s+(?=\D*$)/)[0].trim();
  let m = /^(.*?)[\s\-_.:,]*(?:\d+\s*[.\-]?\s*(?:sezon|season)\s*)?\d+\s*[.\-]?\s*(?:bölüm|bolum|episode|ep)(?![\p{L}])/iu.exec(t)
    || /^(.*?)[\s\-_.:,]*(?:bölüm|bolum|episode|ep\.?)\s*\d+/iu.exec(t)
    || /^(.*?\D)[\s\-_.]*\d+\s*$/u.exec(t);
  // bölüm no yoksa (tek film vb.) klasör adı başlığın kendisi olur
  return cleanDir((m ? m[1] : t).replace(/[\\/]+/g, " "));
}
// Seri modunda başlıktan çıkmazsa adres kalıbından klasör adı üretilir
async function seriesFolder(title) {
  const g = groupFolder(title);
  if (g) return g;
  const s = await getSeries();
  let seg = "";
  try {
    const parts = new URL(s.tpl.pre).pathname.split("/").filter(Boolean);
    seg = (parts[parts.length - 1] || "").replace(/[-_ ]+$/, "");
    if (!seg || /^(bolum|episode|ep)$/i.test(seg)) seg = parts[parts.length - 2] || new URL(s.tpl.pre).hostname;
  } catch {}
  seg = decodeURIComponent(seg).replace(/[-_]+/g, " ").trim();
  return cleanDir(seg.replace(/\b\p{L}/gu, (c) => c.toUpperCase())) || "Seri";
}
async function queueDownload(tab, url, kind, ext, auto = false, item = null, fromSeries = false) {
  const name = sanitize(tab.title);
  const isStream = kind === "hls" || kind === "dash";
  const folder = fromSeries ? await seriesFolder(tab.title) : groupFolder(tab.title);
  const shortName = `${name}.${ext}`;
  const filename = folder ? `${folder}/${shortName}` : shortName;
  let added = false;
  await jobEnq(async () => {
    const jobs = await getJobs();
    if (jobs.some((j) => j.url === url && (auto || j.state === "queued" || j.state === "running"))) return;
    if (auto) {
      const seen = (await chrome.storage.session.get("autoSeen")).autoSeen || [];
      const related = [...(item?.variants || []), ...(item?.members || [])];
      if (seen.includes(url) || related.some((u) => seen.includes(u) || jobs.some((j) => j.url === u))) return;
      seen.push(url);
      await chrome.storage.session.set({ autoSeen: seen.slice(-500) });
    }
    jobs.push({
      id: crypto.randomUUID(), url, ref: tab.url, kind, state: "queued", pct: 0, fromSeries,
      name: isStream ? name : shortName, filename, folder, text: "Sırada bekliyor…"
    });
    await chrome.storage.session.set({ jobs });
    added = true;
  });
  if (added) pump();
  return added;
}

function sanitize(title) {
  return (title || "video")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 120) || "video";
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "found") {
    if (sender.tab) handleFound(sender.tab.id, msg.url);
    return;
  }
  if (msg.type === "list") {
    enqueue(async () => {
      const st = await getSettings(msg.tabId);
      const list = await getList(msg.tabId);
      sendResponse(list.filter((v) => passes(v, st)));
    });
    return true;
  }
  if (msg.type === "dims") {
    const tabId = msg.tabId ?? sender.tab?.id;
    if (tabId == null) return;
    const h = snapDims(msg.w, msg.h);
    enqueue(async () => {
      const list = await getList(tabId);
      const it = list.find((v) => v.url === msg.url);
      if (!it) { if (h) pendingDims.set(msg.url, h); return; }
      if (h) it.height = h; else it.probed = true;
      await setList(tabId, list);
    });
    return;
  }
  if (msg.type === "download") {
    chrome.tabs.get(msg.tabId)
      .then((tab) => queueDownload(tab, msg.url, msg.kind, msg.ext))
      .then(() => sendResponse(true))
      .catch(() => sendResponse(false));
    return true;
  }
  if (msg.type === "jobUpdate") {
    patchJob(msg.id, msg.patch).then(() => {
      if (msg.patch.state && msg.patch.state !== "running") maybeCloseOffscreen();
    });
    return;
  }
  if (msg.type === "dl-referer") {
    setDlReferer(msg.ref).then(() => sendResponse(true));
    return true;
  }
  if (msg.type === "save-blob") {
    chrome.downloads.download({ url: msg.url, filename: msg.filename, conflictAction: "uniquify" })
      .then((id) => sendResponse({ id }))
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === "dl-state") {
    chrome.downloads.search({ id: msg.id })
      .then(([it]) => sendResponse({ state: it ? it.state : "complete" }));
    return true;
  }
  if (msg.type === "jobRemove") {
    cancelJob(msg.id);
    return;
  }
  if (msg.type === "dl-cancel") {
    chrome.downloads.cancel(msg.id).catch(() => {});
    return;
  }
  if (msg.type === "jobsClear") {
    removeJobs((j) => j.state === "done" || j.state === "error");
    return;
  }
});

/* ---------- SERİ MODU: bölüm numarasını artırarak sırayla gez + indir ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SERIES_TIMEOUT = 40000; // bir bölümde video beklenecek en uzun süre
const SERIES_SETTLE = 3000;   // video göründükten sonra (ana liste/çözünürlük otursun diye) bekleme
let serQ = Promise.resolve();
const serEnq = (fn) => (serQ = serQ.then(fn).catch(console.error));
const getSeries = async () => (await chrome.storage.session.get("series")).series || null;
const seriesRunning = async () => !!(await getSeries())?.running;
const setSeries = (patch) => serEnq(async () => {
  const s = await getSeries();
  if (!s) return;
  if (!("running" in patch) && !s.running) return; // durdurulduktan sonra durum metnini ezme
  await chrome.storage.session.set({ series: { ...s, ...patch } });
});
function bumpDownloaded() {
  serEnq(async () => {
    const s = await getSeries();
    if (s) await chrome.storage.session.set({ series: { ...s, downloaded: (s.downloaded || 0) + 1 } });
  });
}
const finishSeries = (text) => setSeries({ running: false, status: text });

// Sekmeyi adrese götürür; yükleme bitince (en çok 40 sn) çözülür
function navigate(tabId, url) {
  return new Promise((resolve, reject) => {
    let started = false;
    const done = () => { clearTimeout(t); chrome.tabs.onUpdated.removeListener(l); resolve(); };
    const t = setTimeout(done, 40000);
    const l = (id, info) => {
      if (id !== tabId) return;
      if (info.status === "loading") started = true;
      if (info.status === "complete" && started) done();
    };
    chrome.tabs.onUpdated.addListener(l);
    chrome.tabs.update(tabId, { url }).catch((e) => { clearTimeout(t); chrome.tabs.onUpdated.removeListener(l); reject(e); });
  });
}

function pickItem(list, st) {
  const best = (v) => Math.max(0, ...(itemHeights(v) || []));
  return list.filter((v) => !v.live && passes(v, st))
    .sort((a, b) => best(b) - best(a) || (b.size || 0) - (a.size || 0))[0] || null;
}

let lastScan = "";
async function waitForVideo(tabId, alt = 0) {
  const t0 = Date.now();
  let firstSeen = 0;
  lastScan = "";
  while (Date.now() - t0 < SERIES_TIMEOUT) {
    if (!(await seriesRunning())) return null;
    chrome.tabs.sendMessage(tabId, { type: "tryPlay", alt }).catch(() => {}); // tüm çerçevelerde oynatmayı dene
    const list = await getList(tabId), cfg = await getSettings(tabId);
    const item = pickItem(list, cfg);
    lastScan = `algılanan: ${list.length}, canlı: ${list.filter((v) => v.live).length}, filtreye takılan: ${list.filter((v) => !v.live && !passes(v, cfg)).length}`;
    if (item) { firstSeen ||= Date.now(); if (Date.now() - firstSeen >= SERIES_SETTLE) return item; }
    else firstSeen = 0;
    await sleep(1000);
  }
  return null;
}

let seriesLoop = false;
async function runSeries() {
  if (seriesLoop) return;
  seriesLoop = true;
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000); // servis uyumasın
  try {
    while (true) {
      const s = await getSeries();
      if (!s || !s.running) break;
      if (s.last && s.n > s.last) { await finishSeries(`Bitti ✓ ${s.count || 0} bölüm sıraya eklendi (son: ${s.last})`); break; }
      const url = episodeUrl(s.tpl, s.n);
      await setSeries({ status: `${s.n}. bölüm kontrol ediliyor…` });

      try { // sayfa hiç yoksa bölümler bitmiştir
        const r = await fetch(url, { credentials: "include" });
        if (r.status === 404 || r.status === 410) {
          await finishSeries(`${s.n}. bölüm sayfası yok. Bitti ✓ ${s.count || 0} bölüm sıraya eklendi`);
          break;
        }
      } catch {}

      let item = null;
      for (let attempt = 0; attempt < 3 && !item; attempt++) {
        await setSeries({ status: `${s.n}. bölüm yükleniyor…${attempt ? ` (yedek oynatıcı ${attempt})` : ""}` });
        try { await navigate(s.tabId, url); }
        catch { await finishSeries("Sekme kapatıldı, durdu."); return; }
        if (!(await seriesRunning())) break;
        await setSeries({ status: `${s.n}. bölüm: video aranıyor…` });
        item = await waitForVideo(s.tabId, attempt);
        if (!(await seriesRunning())) break;
      }
      if (!(await seriesRunning())) break;
      if (!item) {
        await finishSeries(`${s.n}. bölümde video bulunamadı (${lastScan}). ${s.count || 0} bölüm sıraya eklendi.`);
        break;
      }
      let tab;
      try { tab = await chrome.tabs.get(s.tabId); } catch { await finishSeries("Sekme kapatıldı, durdu."); return; }
      await queueDownload(tab, item.url, item.kind, item.ext, false, item, true);
      await setSeries({ n: s.n + 1, count: (s.count || 0) + 1, status: `${s.n}. bölüm sıraya eklendi ✓` });
    }
  } finally {
    clearInterval(keepAlive);
    seriesLoop = false;
  }
}
getSeries().then((s) => { if (s?.running) runSeries(); }); // servis yeniden başladıysa kaldığı yerden sürsün

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "seriesStart") {
    (async () => {
      if ((await getSettings()).off) return sendResponse({ error: "Önce OFF düğmesini kapat." });
      const tab = await chrome.tabs.get(msg.tabId);
      const p = parseEpisodeUrl(tab.url);
      if (!p) return sendResponse({ error: "Adreste bölüm numarası bulunamadı." });
      await serEnq(() => chrome.storage.session.set({ series: {
        running: true, tabId: tab.id, tpl: { pre: p.pre, post: p.post, width: p.width },
        n: msg.n || p.n, last: msg.last || 0, count: 0, status: "Başlıyor…"
      } }));
      runSeries();
      sendResponse({ ok: true });
    })().catch((e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === "seriesStop") {
    finishSeries("Durduruldu.");
    return;
  }
});

importScripts("hls-parse.js", "dash-parse.js");

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
async function getSettings() {
  const r = await chrome.storage.local.get({ above: true, below: true, auto: true, off: false });
  return { above: !!r.above, below: !!r.below, auto: !!r.auto, off: !!r.off };
}
const itemHeights = (v) => (v.heights && v.heights.length ? v.heights : v.height ? [v.height] : null);
// 1080p ve üstü / 1080p ve altı kutucukları; ikisi de seçili (ya da ikisi de boş) = filtre yok
function passes(v, s) {
  if (s.above === s.below) return true;
  const hs = itemHeights(v); // kalite bilinmiyorsa listede kalır
  if (!hs) return true;
  return hs.some((h) => (s.above ? h >= 1080 : h <= 1080));
}
const pendingDims = new Map();
async function refreshBadge(tabId, list) {
  const st = await getSettings();
  const n = st.off ? 0 : list.filter((v) => passes(v, st)).length;
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : "" }).catch(() => {});
}
async function setList(tabId, list) {
  await chrome.storage.session.set({ [key(tabId)]: list });
  await refreshBadge(tabId, list);
}
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && ch.off) applyIcon();
  if (area !== "local" || !(ch.above || ch.below || ch.off)) return;
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
  scheduleAuto(tabId, item.url);
}

/* ---------- otomatik sıraya ekleme ---------- */
// Kısa bekleme: ana liste (master) gelirse alt listeler elenir, çözünürlük bilgisi ve sayfa başlığı oturur
function scheduleAuto(tabId, url) {
  setTimeout(() => autoEnqueue(tabId, url).catch(console.error), 2500);
}
async function autoEnqueue(tabId, url) {
  const st = await getSettings();
  if (st.off || !st.auto) return;
  const item = (await getList(tabId)).find((v) => v.url === url);
  if (!item || item.live || !passes(item, st)) return; // elenmiş / canlı / kalite filtresine uymuyor
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; }
  await queueDownload(tab, item.url, item.kind, item.ext, true, item);
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
async function handleHls(tabId, url) {
  if (await isOff()) return;
  const exists = (await getList(tabId)).some((v) => v.url === url);
  if (exists) return;
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; }
  let parsed = null;
  try {
    await setReferer(tab.url);
    const r = await fetch(url, { credentials: "include" });
    if (r.ok) parsed = parsePlaylist(await r.text(), url);
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
  if (info.status === "loading" && info.url) enqueue(() => setList(tabId, []));
});
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(key(tabId)));

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
const patchJob = (id, patch) => jobEnq(async () => {
  const jobs = await getJobs();
  const j = jobs.find((x) => x.id === id);
  if (!j) return;
  Object.assign(j, patch);
  await chrome.storage.session.set({ jobs });
  if (isEnd(patch)) pump();
});
const patchByDl = (dlId, patch) => jobEnq(async () => {
  const jobs = await getJobs();
  const j = jobs.find((x) => x.kind === "file" && x.dlId === dlId);
  if (!j) return;
  Object.assign(j, patch);
  await chrome.storage.session.set({ jobs });
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
        job: { id: job.id, url: job.url, name: job.name, ref: job.ref, kind: job.kind }
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
async function queueDownload(tab, url, kind, ext, auto = false, item = null) {
  const name = sanitize(tab.title);
  const isStream = kind === "hls" || kind === "dash";
  const filename = `${name}.${ext}`;
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
      id: crypto.randomUUID(), url, ref: tab.url, kind, state: "queued", pct: 0,
      name: isStream ? name : filename, filename, text: "Sırada bekliyor…"
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
      const st = await getSettings();
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

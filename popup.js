const fmt = (b) => !b ? "?" : b > 1e9 ? (b/1e9).toFixed(2)+" GB" : (b/1e6).toFixed(1)+" MB";
const el = document.getElementById("list");
const nmInput = document.getElementById("nm");
const belowBtn = document.getElementById("below");
let belowOn = false;
const offBox = document.getElementById("off");
let offOn = false;
let tab;
const probing = new Set();

async function setReferer(ref) {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [3],
      addRules: [{
        id: 3, priority: 10,
        action: { type: "modifyHeaders", requestHeaders: [
          { header: "referer", operation: "set", value: ref },
          { header: "origin", operation: "set", value: new URL(ref).origin }
        ] },
        condition: { tabIds: [-1], resourceTypes: ["media", "xmlhttprequest", "other"] }
      }]
    });
  } catch {}
}

// Kalitesi bilinmeyen dosyaların çözünürlüğünü okur
function probe(url) {
  return new Promise((res) => {
    const v = document.createElement("video");
    v.preload = "metadata"; v.muted = true;
    let done = false;
    const fin = (w, h) => {
      if (done) return; done = true;
      v.removeAttribute("src"); v.load();
      res({ w, h });
    };
    v.onloadedmetadata = () => fin(v.videoWidth, v.videoHeight);
    v.onerror = () => fin(0, 0);
    setTimeout(() => fin(0, 0), 8000);
    v.src = url;
  });
}

async function probePending(list) {
  const todo = list.filter((v) => v.kind === "file" && !v.height && !v.probed && !probing.has(v.url));
  if (!todo.length) return;
  await setReferer(tab.url);
  let changed = false;
  await Promise.all(todo.slice(0, 6).map(async (v) => {
    probing.add(v.url);
    const { w, h } = await probe(v.url);
    await chrome.runtime.sendMessage({ type: "dims", tabId: tab.id, url: v.url, w, h });
    changed = true;
  }));
  if (changed) render(false);
}

function applyOff() {
  offBox.classList.toggle("on", offOn);
  offBox.title = offOn ? "Algılama kapalı — açmak için tıkla" : "Algılamayı kapat";
  belowBtn.disabled = offOn;
  belowBtn.classList.toggle("on", belowOn);
  belowBtn.title = belowOn ? "Bu sayfada 1080 altı aktif — kapatmak için tıkla" : "Bu sayfada 1080 ve altını göster";
}


const hintEl = document.getElementById("hint");
function showHint(t) { hintEl.textContent = t || ""; hintEl.hidden = !t; }

// Sekmedeki tüm çerçevelerdeki <video> öğelerinin durumunu okur (hangisi oynuyor?)
async function playingVideos() {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => [...document.querySelectorAll("video")].map((v) => ({
        playing: !v.paused && !v.ended,
        started: v.currentTime > 0 && !v.ended,
        src: v.currentSrc || v.src || "",
        area: v.clientWidth * v.clientHeight
      }))
    });
    return res.flatMap((r) => (r.result || []).map((x) => ({ ...x, frameId: r.frameId })));
  } catch { return null; }
}

// Oynatılan videoya karşılık gelen kaydı seçer:
// 1) adresi birebir eşleşen  2) aynı çerçeveden gelen en yeni  3) (blob: gibi) eşleşmezse listedeki en yeni
function pickPlaying(list, vids) {
  if (!list.length) return null;
  if (!vids || !vids.length) return list[list.length - 1]; // video öğesi okunamadı: elde en yeni olan
  const groups = [vids.filter((x) => x.playing), vids.filter((x) => !x.playing && x.started)];
  for (const g of groups) {
    g.sort((a, b) => b.area - a.area); // küçük önizlemeler yerine ana oynatıcı
    for (const pv of g) {
      const exact = list.find((it) => it.url === pv.src || (it.members || []).includes(pv.src) || (it.variants || []).includes(pv.src));
      if (exact) return exact;
      const inFrame = list.filter((it) => it.frameId === pv.frameId);
      if (inFrame.length) return inFrame[inFrame.length - 1];
    }
    if (g.length) return list[list.length - 1];
  }
  return null; // videolar var ama hiçbiri oynamıyor
}

async function render(doProbe = true) {
  if (offOn) {
    el.innerHTML = "";
    return;
  }
  const list = await chrome.runtime.sendMessage({ type: "list", tabId: tab.id });
  el.innerHTML = "";
  nmInput.hidden = !(list && list.length);
  if (!list || !list.length) return;
  // Tek düğme: yalnızca o an OYNATILAN video iner
  const d = document.createElement("button");
  d.textContent = "İndir";
  d.title = "Oynatılan videoyu indirir (ad yazılırsa o adla kaydedilir)\n" + list.map((v) => v.url).join("\n");
  d.onclick = async () => {
    const v = pickPlaying(list, await playingVideos());
    if (!v) { showHint("Oynatılan video bulunamadı — önce videoyu oynat."); return; }
    showHint("");
    const name = nmInput.value.trim(); // doluysa dosya bu adla iner
    chrome.runtime.sendMessage({ type: "download", tabId: tab.id, url: v.url, ext: v.ext, kind: v.kind, name });
    nmInput.value = "";
  };
  el.appendChild(d);
  if (doProbe) probePending(list);
}

/* ---------- indirilenler (ilerleme çubukları) ---------- */
const jobsBox = document.getElementById("jobs");
const jobList = document.getElementById("jobList");
const fmtB = (b) => b > 1e9 ? (b / 1e9).toFixed(2) + " GB" : (b / 1e6).toFixed(1) + " MB";
let jobs = [];
const jobEls = new Map();
const fileProg = new Map(); // dlId -> { pct, text, ind } (doğrudan dosyalar için canlı değer)
let pollTimer = null;

const ORDER = { running: 0, queued: 1, done: 2, error: 2 };
function renderJobs() {
  jobsBox.hidden = !jobs.length;
  const ids = new Set(jobs.map((x) => x.id));
  for (const [id, e] of jobEls) if (!ids.has(id)) { e.root.remove(); jobEls.delete(id); }
  // sıra: iniyor → bekleyenler (eklenme sırasıyla) → biten (en yeni üstte)
  const rank = new Map(jobs.map((x, i) => [x.id, i]));
  const sorted = [...jobs].sort((a, b) =>
    ORDER[a.state] - ORDER[b.state] ||
    (ORDER[a.state] === 2 ? rank.get(b.id) - rank.get(a.id) : rank.get(a.id) - rank.get(b.id)));
  let qpos = 0;
  for (const j of sorted) {
    let e = jobEls.get(j.id);
    if (!e) {
      const root = document.createElement("div");
      root.innerHTML = `<div class="row"><span class="nm"></span><button class="rt" title="Tekrar dene"><svg width="11" height="11" viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.6-5.9M20 3v5h-5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg></button><button class="x" title="Kaldır"><svg width="9" height="9" viewBox="0 0 10 10"><path d="M1 1l8 8M9 1L1 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg></button></div><div class="track"><div class="fill"></div></div><div class="st"></div>`;
      e = { root, nm: root.querySelector(".nm"), rt: root.querySelector(".rt"), x: root.querySelector(".x"), fill: root.querySelector(".fill"), st: root.querySelector(".st") };
      e.rt.onclick = () => chrome.runtime.sendMessage({ type: "jobRetry", id: j.id });
      e.x.onclick = () => chrome.runtime.sendMessage({ type: "jobRemove", id: j.id });
      jobEls.set(j.id, e);
    }
    jobList.appendChild(e.root); // mevcut öğeyi doğru yere taşır
    const fp = j.kind === "file" && j.state === "running" ? fileProg.get(j.dlId) : null;
    const ind = !!(fp && fp.ind);
    e.root.className = "job " + j.state + (ind ? " ind" : "");
    e.nm.textContent = j.label || j.name;
    e.nm.title = j.label || j.name;
    e.fill.style.width = ind ? "" : (fp ? fp.pct : j.pct || 0) + "%";
    e.st.textContent = j.state === "queued" ? `Sırada bekliyor · ${++qpos}. sıra` : ((fp ? fp.text : j.text) || "");
    e.rt.hidden = !(j.state === "error" || j.state === "running"); // hatalı ya da takılan indirme için
    e.rt.title = j.state === "running" ? "Takıldıysa durdurup baştan başlat" : "Tekrar dene";
    e.x.title = j.state === "running" ? "İndirmeyi iptal et" : j.state === "queued" ? "Sıradan çıkar" : "Kaldır";
  }
  ensurePoll();
}

async function pollFiles() {
  for (const j of jobs) {
    if (j.kind !== "file" || j.state !== "running" || j.dlId == null) continue;
    const [it] = await chrome.downloads.search({ id: j.dlId });
    if (!it) continue;
    const total = it.totalBytes > 0 ? it.totalBytes : 0;
    fileProg.set(j.dlId, total
      ? { pct: +(it.bytesReceived / total * 100).toFixed(1), text: `${fmtB(it.bytesReceived)} / ${fmtB(total)}`, ind: false }
      : { pct: 0, text: fmtB(it.bytesReceived) + " indirildi", ind: true });
  }
  renderJobs();
}
function ensurePoll() {
  const need = jobs.some((j) => j.kind === "file" && j.state === "running" && j.dlId != null);
  if (need && !pollTimer) { pollTimer = setInterval(pollFiles, 500); pollFiles(); }
  else if (!need && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
document.getElementById("clear").onclick = () => chrome.runtime.sendMessage({ type: "jobsClear" });
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "session" && ch.jobs) { jobs = ch.jobs.newValue || []; renderJobs(); }
});

/* ---------- seri modu ---------- */
const epN = document.getElementById("epN"), epL = document.getElementById("epL");
const serBtn = document.getElementById("serBtn"), serSt = document.getElementById("serSt");
let series = null;
function renderSeries() {
  const run = !!(series && series.running);
  epN.disabled = epL.disabled = run;
  serBtn.textContent = run ? "Durdur" : "Başlat";
  serBtn.className = run ? "stop" : "";
  if (run) { epN.value = series.n; epL.value = series.last || ""; }
  serSt.textContent = series && series.status ? series.status + (series.downloaded ? ` · ${series.downloaded} indirildi` : "") : "";
}
serBtn.onclick = async () => {
  if (series && series.running) { chrome.runtime.sendMessage({ type: "seriesStop" }); return; }
  const r = await chrome.runtime.sendMessage({ type: "seriesStart", tabId: tab.id, n: parseInt(epN.value, 10) || 0, last: parseInt(epL.value, 10) || 0 });
  if (r && r.error) serSt.textContent = r.error;
};
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "session" && ch.series) { series = ch.series.newValue || null; renderSeries(); }
});

(async () => {
  jobs = (await chrome.storage.session.get("jobs")).jobs || [];
  renderJobs();
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const st = await chrome.storage.local.get({ off: false });
  const bk = "bl_" + tab.id;
  belowOn = !!(await chrome.storage.session.get(bk))[bk];
  offOn = st.off;
  applyOff();
  offBox.addEventListener("click", async () => {
    offOn = !offOn;
    await chrome.storage.local.set({ off: offOn });
    applyOff();
    render();
  });
  belowBtn.addEventListener("click", async () => {
    belowOn = !belowOn;
    if (belowOn) await chrome.storage.session.set({ [bk]: true });
    else await chrome.storage.session.remove(bk);
    applyOff();
    render();
  });
  render();
  series = (await chrome.storage.session.get("series")).series || null;
  const p = parseEpisodeUrl(tab.url || "");
  if (p) { if (!epN.value) epN.value = p.n; }
  else serBtn.disabled = true;
  renderSeries();
})();

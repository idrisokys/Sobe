// HLS (.m3u8) ve DASH (.mpd) indirici — arka planda (offscreen) çalışır.
// Ses ayrı akıştaysa indirip tek mp4'e birleştirir. İlerleme "jobUpdate" mesajlarıyla popup'a yansır.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = (msg) => chrome.runtime.sendMessage(msg);

function reporter(id) {
  let last = 0;
  return (patch, force = false) => {
    const now = Date.now();
    if (!force && now - last < 250) return;
    last = now;
    rpc({ type: "jobUpdate", id, patch }).catch(() => {});
  };
}

/* ---------- ağ ---------- */
async function readBody(r, onFrac) {
  const total = +r.headers.get("content-length") || 0;
  if (!onFrac || !total || !r.body) return new Uint8Array(await r.arrayBuffer());
  const reader = r.body.getReader(), chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    onFrac(Math.min(1, got / total));
  }
  const out = new Uint8Array(got);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}
// range: "a-b" | "a-" (isteğe bağlı), onFrac: büyük tek dosyalar için ilerleme
async function getBuf(u, { range, onFrac, tries = 4, signal } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const headers = {};
      let a = 0, b;
      if (range) {
        const [as, bs] = range.split("-");
        a = +as; b = bs === "" || bs == null ? undefined : +bs;
        headers.Range = `bytes=${a}-${b ?? ""}`;
      }
      onFrac?.(0);
      const r = await fetch(u, { credentials: "include", headers, signal });
      if (!r.ok) throw new Error("HTTP " + r.status);
      let buf = await readBody(r, range ? null : onFrac);
      if (range && r.status === 200) buf = buf.subarray(a, b === undefined ? undefined : b + 1); // sunucu Range'i yok saydı
      return buf;
    } catch (e) {
      if (signal?.aborted || i === tries - 1) throw e;
      await sleep(600 * (i + 1));
    }
  }
}
async function getText(u, signal) {
  const r = await fetch(u, { credentials: "include", signal });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.text();
}

function ivBytes(seg) {
  const iv = new Uint8Array(16);
  if (seg.key.iv) {
    const hex = seg.key.iv.replace(/^0x/i, "").padStart(32, "0");
    for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
  } else {
    new DataView(iv.buffer).setUint32(12, seg.seq >>> 0);
  }
  return iv;
}

/* ---------- akış hazırlama ----------
   akış = { items: [{url, range?, key?, seq?}], isMp4, mime, ext, out: [] }  (items[0] init olabilir) */
const audioExt = (url) => (/\.(aac|mp3|ac3|ec3)(\?|#|$)/i.exec(url) || [])[1]?.toLowerCase() || "ts";

async function loadHlsMedia(url, role, signal) {
  const pl = parsePlaylist(await getText(url, signal), url);
  if (!pl || pl.master) throw new Error("Medya listesi okunamadı");
  if (!pl.segments.length) throw new Error("Parça bulunamadı");
  if (pl.segments.some((s) => s.key && s.key.method !== "AES-128"))
    throw new Error("Bu şifreleme (DRM / SAMPLE-AES) desteklenmiyor");
  const isMp4 = !!pl.map || /\.(m4s|mp4|m4v|cmfv|cmfa)(\?|#|$)/i.test(pl.segments[0].url);
  return {
    items: [...(pl.map ? [{ url: pl.map }] : []), ...pl.segments],
    isMp4,
    mime: isMp4 ? "video/mp4" : "video/mp2t",
    ext: isMp4 ? (role === "audio" ? "m4a" : "mp4") : role === "audio" ? audioExt(pl.segments[0].url) : "ts"
  };
}

async function prepHls(srcUrl, st, signal) {
  const pl = parsePlaylist(await getText(srcUrl, signal), srcUrl);
  if (!pl) throw new Error("Geçersiz playlist");
  let videoUrl = srcUrl, audioUrl = null;
  if (pl.master) {
    if (!pl.variants.length) throw new Error("Akış bulunamadı");
    const best = chooseByQuality(pl.variants, (v) => snapHeight(v.resolution), st);
    videoUrl = best.url;
    const group = best.audioGroup && pl.audio[best.audioGroup];
    if (group && group.length) audioUrl = (group.find((x) => x.def) || group.find((x) => x.auto) || group[0]).url;
  }
  const video = await loadHlsMedia(videoUrl, "video", signal);
  const audio = audioUrl ? await loadHlsMedia(audioUrl, "audio", signal) : null;
  return { video, audio };
}

function dashStream(rep) {
  const seg = rep.getSegments();
  if (!seg.list.length) throw new Error("DASH segment listesi boş");
  const isMp4 = rep.container === "mp4";
  return {
    items: [...(seg.init ? [seg.init] : []), ...seg.list],
    isMp4,
    mime: isMp4 ? (rep.type === "audio" ? "audio/mp4" : "video/mp4") : (rep.type === "audio" ? "audio/webm" : "video/webm"),
    ext: isMp4 ? (rep.type === "audio" ? "m4a" : "mp4") : "webm"
  };
}

async function prepDash(srcUrl, st, signal) {
  const info = parseMpd(await getText(srcUrl, signal), srcUrl);
  if (!info) throw new Error("MPD okunamadı");
  if (info.live) throw new Error("Canlı DASH yayını desteklenmiyor");
  if (!info.video.length) throw new Error(info.drm ? "DRM korumalı içerik indirilemez" : "Video akışı bulunamadı");
  const vrep = chooseByQuality(info.video, (r) => snapDims(r.width, r.height), st);
  const arep = pickDashAudio(info, vrep);
  return { video: dashStream(vrep), audio: arep ? dashStream(arep) : null };
}

/* ---------- indirme ---------- */
async function downloadStreams(streams, report, signal) {
  const jobs = [];
  for (const s of streams) { s.out = new Array(s.items.length); s.items.forEach((it, i) => jobs.push({ s, it, i })); }
  const total = jobs.length, unit = jobs.length <= 2 ? "dosya" : "parça";
  const keys = new Map();
  const getKey = (uri) => {
    if (!keys.has(uri))
      keys.set(uri, getBuf(uri, { signal }).then((b) => crypto.subtle.importKey("raw", b, "AES-CBC", false, ["decrypt"])));
    return keys.get(uri);
  };
  let done = 0, next = 0, failed = false;
  const partial = new Map();
  const show = () => {
    let p = done;
    for (const f of partial.values()) p += f;
    report({ pct: +Math.min(100, (p / total) * 100).toFixed(1), text: `${done} / ${total} ${unit} indiriliyor…` });
  };
  const worker = async () => {
    try {
      while (next < jobs.length && !failed && !signal.aborted) {
        const j = jobs[next++];
        const onFrac = total <= 2 ? (f) => { partial.set(j, f); show(); } : null;
        let buf = await getBuf(j.it.url, { range: j.it.range, onFrac, signal });
        if (j.it.key) {
          const k = await getKey(j.it.key.uri);
          buf = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivBytes(j.it) }, k, buf));
        }
        j.s.out[j.i] = buf;
        partial.delete(j);
        done++;
        show();
      }
    } catch (e) { failed = true; throw e; }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  if (signal.aborted) throw new Error("İptal edildi");
}

// Kaydeder ve indirme bitene kadar bekler (blob adresi belge kapanınca geçersiz olur).
// chrome.downloads offscreen belgede yok; kaydı arka plan başlatır.
async function save(parts, type, filename, signal) {
  const url = URL.createObjectURL(new Blob(parts, { type }));
  try {
    const r = await rpc({ type: "save-blob", url, filename });
    if (!r || r.error) throw new Error(r?.error || "Kaydedilemedi");
    for (;;) {
      if (signal.aborted) { rpc({ type: "dl-cancel", id: r.id }).catch(() => {}); throw new Error("İptal edildi"); }
      await sleep(500);
      const s = await rpc({ type: "dl-state", id: r.id });
      if (!s || s.state === "complete") return;
      if (s.state === "interrupted") throw new Error("Kaydetme kesildi");
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

const ctrls = new Map();   // iş id -> AbortController
const precancel = new Set(); // başlamadan iptal edilenler
async function runJob({ id, url, name, ref, kind }, st) {
  const report = reporter(id);
  const ac = new AbortController();
  const signal = ac.signal;
  ctrls.set(id, ac);
  if (precancel.delete(id)) ac.abort();
  const chk = () => { if (signal.aborted) throw new Error("İptal edildi"); };
  try {
    chk();
    await rpc({ type: "dl-referer", ref });
    report({ text: "Akış okunuyor…" }, true);
    const { video, audio } = kind === "dash" ? await prepDash(url, st, signal) : await prepHls(url, st, signal);
    await downloadStreams([video, audio].filter(Boolean), report, signal);
    chk();

    let note = "";
    if (!audio) {
      report({ pct: 100, text: "Dosya kaydediliyor…" }, true);
      await save(video.out, video.mime, `${name}.${video.ext}`, signal);
    } else {
      let merged = null;
      if (video.isMp4 && audio.isMp4) {
        report({ pct: 100, text: "Görüntü ve ses birleştiriliyor…" }, true);
        try { merged = mergeMp4(video.out, audio.out); }
        catch (e) { console.warn("birleştirme", e); note = ` (birleştirilemedi: ${e.message})`; }
      }
      report({ pct: 100, text: "Dosya kaydediliyor…" }, true);
      if (merged) {
        await save(merged.parts, "video/mp4", `${name}.mp4`, signal);
      } else {
        await save(video.out, video.mime, `${name}.${video.ext}`, signal);
        await save(audio.out, audio.mime, `${name} (ses).${audio.ext}`, signal);
        note = note || " (ses ayrı dosya olarak indirildi — bu biçim tek dosyada birleştirilemiyor)";
      }
    }
    report({ state: "done", pct: 100, text: "Bitti ✓" + note }, true);
  } catch (e) {
    if (!signal.aborted) report({ state: "error", text: "Hata: " + e.message }, true);
  } finally {
    ctrls.delete(id);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === "off-start") runJob(msg.job, msg.st);
  if (msg.type === "off-cancel") {
    const ac = ctrls.get(msg.id);
    if (ac) ac.abort(); else precancel.add(msg.id);
  }
});

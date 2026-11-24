// HLS (.m3u8) ve DASH (.mpd) indirici — arka planda (offscreen) çalışır.
// Ses ayrı akıştaysa indirip tek mp4'e birleştirir. İlerleme "jobUpdate" mesajlarıyla popup'a yansır.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = (msg) => chrome.runtime.sendMessage(msg);

function reporter(id, run) {
  let last = 0;
  return (patch, force = false) => {
    const now = Date.now();
    if (!force && now - last < 250) return;
    last = now;
    rpc({ type: "jobUpdate", id, run, patch }).catch(() => {});
  };
}

/* ---------- ağ ---------- */
const IDLE_MS = 30000; // bu kadar süre hiç veri gelmezse istek takılmış sayılır ve yeniden denenir
const RETRY_HTTP = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
class HttpError extends Error {
  constructor(status, retryAfter) { super("HTTP " + status); this.status = status; this.retryAfter = retryAfter; }
}
const isOverload = (e) => e instanceof HttpError && (e.status === 429 || e.status === 503);
const retryable = (e) => !(e instanceof HttpError) || RETRY_HTTP.has(e.status);
// Retry-After: saniye ya da tarih
function retryAfterMs(r) {
  const v = r.headers.get("retry-after");
  if (!v) return 0;
  const n = Number(v);
  if (!isNaN(n)) return Math.max(0, n * 1000);
  const d = Date.parse(v);
  return isNaN(d) ? 0 : Math.max(0, d - Date.now());
}

async function readBody(r, onFrac, kick) {
  const total = +r.headers.get("content-length") || 0;
  if (!r.body) return new Uint8Array(await r.arrayBuffer());
  const reader = r.body.getReader(), chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    kick?.();
    chunks.push(value); got += value.length;
    if (onFrac && total) onFrac(Math.min(1, got / total));
  }
  const out = new Uint8Array(got);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}
// range: "a-b" | "a-" (isteğe bağlı), onFrac: büyük tek dosyalar için ilerleme,
// onOverload: sunucu 429/503 verdiğinde çağrılır (eşzamanlı istek sayısını düşürmek için)
async function getBuf(u, { range, onFrac, tries = 8, signal, onOverload } = {}) {
  for (let i = 0; i < tries; i++) {
    if (signal?.aborted) throw new Error("İptal edildi");
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let timer, timedOut = false;
    const kick = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; ac.abort(); }, IDLE_MS);
    };
    try {
      const headers = {};
      let a = 0, b;
      if (range) {
        const [as, bs] = range.split("-");
        a = +as; b = bs === "" || bs == null ? undefined : +bs;
        headers.Range = `bytes=${a}-${b ?? ""}`;
      }
      onFrac?.(0);
      kick();
      const r = await fetch(u, { credentials: "include", headers, signal: ac.signal });
      if (!r.ok) throw new HttpError(r.status, retryAfterMs(r));
      let buf = await readBody(r, range ? null : onFrac, kick);
      if (range && r.status === 200) buf = buf.subarray(a, b === undefined ? undefined : b + 1); // sunucu Range'i yok saydı
      return buf;
    } catch (e) {
      if (signal?.aborted) throw e;
      const err = timedOut ? new Error("Zaman aşımı (sunucu yanıt vermiyor)") : e;
      if (isOverload(err)) onOverload?.();
      if (i === tries - 1 || !retryable(err)) throw err;
      // 429/503: Retry-After'a uy, yoksa üstel bekleme (1, 2, 4, 8… en çok 30 sn) + rastgele sapma
      const base = isOverload(err) ? Math.min(30000, 1000 * 2 ** i) : 600 * (i + 1);
      const wait = Math.min(60000, Math.max(err.retryAfter || 0, base)) + Math.random() * 500;
      await sleep(wait);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
async function getText(u, signal) {
  return new TextDecoder().decode(await getBuf(u, { signal }));
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

/* ---------- resim kılığındaki parçalar: başındaki sahte başlığı (JPEG/PNG vb.) kırp ----------
   Parça gerçekte MPEG-TS ya da fMP4 ise, ilk gerçek paket/kutu başlangıcına kadar olan baytlar atılır. */
function isTsAt(b, o) {
  for (let k = 0; k < 4; k++) {
    const p = o + 188 * k;
    if (p >= b.length) return k >= 2;
    if (b[p] !== 0x47) return false;
  }
  return true;
}
function findTs(b, lim) {
  for (let o = b.indexOf(0x47); o >= 0 && o < lim; o = b.indexOf(0x47, o + 1)) if (isTsAt(b, o)) return o;
  return -1;
}
function findMp4(b, lim) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let o = 4; o < Math.min(lim, b.length - 8); o++) {
    const c = b[o];
    if (c !== 0x66 && c !== 0x73 && c !== 0x6d) continue; // f, s, m
    const t = String.fromCharCode(c, b[o + 1], b[o + 2], b[o + 3]);
    if (t !== "ftyp" && t !== "styp" && t !== "moof" && t !== "moov") continue;
    const size = dv.getUint32(o - 4);
    if (size >= 8 && o - 4 + size <= b.length) return o - 4; // kutunun başlangıcı
  }
  return -1;
}
function cleanSegment(b) {
  const lim = Math.min(b.length, 1 << 20);
  const ts = findTs(b, lim), mp = findMp4(b, lim);
  if (ts >= 0 && (mp < 0 || ts < mp)) return { buf: ts ? b.subarray(ts) : b, kind: "ts" };
  if (mp >= 0) return { buf: mp ? b.subarray(mp) : b, kind: "mp4" };
  return { buf: b, kind: null };
}
// Parçaların gerçek türüne göre akışın biçimini düzeltir (uzantısı .jpeg olsa bile)
function fixKind(s, role) {
  if (s.kind === "mp4" && !s.isMp4) { s.isMp4 = true; s.mime = role === "audio" ? "audio/mp4" : "video/mp4"; s.ext = role === "audio" ? "m4a" : "mp4"; }
  else if (s.kind === "ts" && s.isMp4) { s.isMp4 = false; s.mime = "video/mp2t"; s.ext = "ts"; }
}

/* ---------- indirme ---------- */
// Yoğun sunucu: başarısız parçalar işi düşürmez, sona bırakılıp soğuma süresiyle yeniden denenir.
// Zaten inen parçalar (s.out) korunur; "tekrar dene" kaldığı yerden devam eder.
async function downloadStreams(streams, report, signal) {
  const jobs = [];
  for (const s of streams) {
    if (!s.out) s.out = new Array(s.items.length);
    s.items.forEach((it, i) => { if (!s.out[i]) jobs.push({ s, it, i }); });
  }
  const total = streams.reduce((n, s) => n + s.items.length, 0), unit = total <= 2 ? "dosya" : "parça";
  let done = total - jobs.length;
  const keys = new Map();
  const getKey = (uri) => {
    if (!keys.has(uri))
      keys.set(uri, getBuf(uri, { signal }).then((b) => crypto.subtle.importKey("raw", b, "AES-CBC", false, ["decrypt"])));
    return keys.get(uri);
  };
  const partial = new Map();
  // Eşzamanlı istek sayısı: 4'ten başlar; sunucu 429/503 verirse yarıya iner, başarılar sürdükçe yavaşça geri çıkar.
  // gap: aşırı yüklenmede her isteğin arasına konan bekleme (ms)
  const MAX_CONC = 4;
  let limit = MAX_CONC, okStreak = 0, lastDrop = 0, gap = 0, note = "";
  const onOverload = () => {
    okStreak = 0;
    if (Date.now() - lastDrop < 3000) return; // aynı anda gelen hatalar tek düşüş sayılır
    lastDrop = Date.now();
    limit = Math.max(1, Math.floor(limit / 2));
    gap = Math.min(3000, gap ? gap * 2 : 400);
  };
  const onOk = () => {
    if (++okStreak < 15) return;
    okStreak = 0;
    if (gap) gap = gap > 400 ? Math.floor(gap / 2) : 0;
    else if (limit < MAX_CONC) limit++;
  };
  const show = (force) => {
    let p = done;
    for (const f of partial.values()) p += f;
    report({ pct: +Math.min(100, (p / total) * 100).toFixed(1), text: `${done} / ${total} ${unit} indiriliyor…${note}` }, force);
  };
  let queue = jobs.slice(), failedJobs = [], fatal = null;
  const worker = async (k) => {
    await sleep(k * 150); // istekleri aynı anda patlatma
    while (!fatal && !signal.aborted) {
      if (k >= limit) { if (!queue.length) return; await sleep(300); continue; } // sunucu zorlanıyorsa fazla işçiler bekler
      const j = queue.shift();
      if (!j) return;
      try {
        if (gap) await sleep(gap + Math.random() * gap * 0.5);
        const onFrac = total <= 2 ? (f) => { partial.set(j, f); show(); } : null;
        let buf = await getBuf(j.it.url, { range: j.it.range, onFrac, signal, onOverload });
        onOk();
        if (j.it.key) {
          const kk = await getKey(j.it.key.uri);
          buf = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivBytes(j.it) }, kk, buf));
        }
        const c = cleanSegment(buf);
        buf = c.buf;
        if (c.kind && !j.s.kind) j.s.kind = c.kind;
        j.s.out[j.i] = buf;
        partial.delete(j);
        done++;
        show();
      } catch (e) {
        partial.delete(j);
        if (signal.aborted) return;
        if (retryable(e)) { j.err = e; failedJobs.push(j); onOverload(); } // sona bırak, işi düşürme
        else { fatal = e; return; }
      }
    }
  };
  const runPool = () => Promise.all(Array.from({ length: MAX_CONC }, (_, k) => worker(k)));
  await runPool();
  // Başarısız parçalar: soğuma süresiyle, tek tek, en çok 4 tur
  for (let round = 1; failedJobs.length && !fatal && !signal.aborted && round <= 4; round++) {
    const wait = 10 + round * 10; // 20, 30, 40, 50 sn
    for (let t = wait; t > 0 && !signal.aborted; t--) {
      note = ` · ${failedJobs.length} parça sunucu yoğunluğu nedeniyle bekliyor (${round}. tur, ${t} sn)`;
      show(true);
      await sleep(1000);
    }
    note = ` · ${round}. tur yeniden deneniyor`;
    queue = failedJobs; failedJobs = [];
    limit = 1; gap = Math.max(gap, 800);
    await runPool();
  }
  if (signal.aborted) throw new Error("İptal edildi");
  if (fatal) throw fatal;
  if (failedJobs.length) {
    const e = failedJobs[0].err;
    throw new Error(`${e.message} — ${failedJobs.length} parça inemedi. ↻ ile kaldığı yerden devam eder`);
  }
}

// Kaydeder ve indirme bitene kadar bekler (blob adresi belge kapanınca geçersiz olur).
// chrome.downloads offscreen belgede yok; kaydı arka plan başlatır.
let curDir = "";
async function save(parts, type, filename, signal) {
  if (curDir) filename = curDir + "/" + filename;
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

const prepared = new Map(); // iş id -> { video, audio } (hata sonrası devam için tutulur)
const ctrls = new Map();   // iş id -> AbortController
const precancel = new Set(); // başlamadan iptal edilenler
async function runJob({ id, url, name, ref, kind, folder, run }, st) {
  curDir = folder || "";
  const report = reporter(id, run);
  const ac = new AbortController();
  const signal = ac.signal;
  ctrls.set(id, ac);
  if (precancel.delete(id)) ac.abort();
  const chk = () => { if (signal.aborted) throw new Error("İptal edildi"); };
  try {
    chk();
    await rpc({ type: "dl-referer", ref });
    report({ text: "Akış okunuyor…" }, true);
    let pre = prepared.get(id); // önceki denemeden kalan akış + inmiş parçalar
    if (!pre) { pre = kind === "dash" ? await prepDash(url, st, signal) : await prepHls(url, st, signal); prepared.set(id, pre); }
    const { video, audio } = pre;
    await downloadStreams([video, audio].filter(Boolean), report, signal);
    chk();
    fixKind(video, "video");
    if (audio) fixKind(audio, "audio");

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
    prepared.delete(id);
  } catch (e) {
    if (!signal.aborted) report({ state: "error", text: "Hata: " + e.message }, true);
  } finally {
    if (ctrls.get(id) === ac) ctrls.delete(id); // tekrar denenen işin yeni denetleyicisini silme
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === "off-start") runJob(msg.job, msg.st);
  if (msg.type === "off-drop") (msg.ids || [msg.id]).forEach((i) => prepared.delete(i));
  if (msg.type === "off-cancel") {
    const ac = ctrls.get(msg.id);
    if (ac) ac.abort(); else precancel.add(msg.id);
  }
});

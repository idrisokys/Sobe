// DASH (.mpd) çözümleyici — hem background hem dl.html kullanır (hls-parse.js'ten sonra yüklenmeli)

/* ---------- küçük XML çözümleyici (service worker'da DOMParser yok) ---------- */
function xmlDecode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    e = e.toLowerCase();
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[e];
  });
}
function parseXml(text) {
  const root = { name: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/)?([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/)?>|([^<]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const top = stack[stack.length - 1];
    if (m[1] != null) top.text += m[1];
    else if (m[6] != null) top.text += xmlDecode(m[6]);
    else if (m[3]) {
      const name = m[3].replace(/^.*:/, "");
      if (m[2]) { if (stack.length > 1) stack.pop(); continue; }
      const attrs = {};
      const ar = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let a;
      while ((a = ar.exec(m[4]))) attrs[a[1].replace(/^.*:/, "")] = xmlDecode(a[2] ?? a[3]);
      const node = { name, attrs, children: [], text: "" };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    }
  }
  return root;
}
const xKids = (n, name) => n.children.filter((c) => c.name === name);
const xKid = (n, name) => n.children.find((c) => c.name === name);

function isoDuration(s) {
  const m = /^P(?:[\d.]+Y)?(?:[\d.]+M)?(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?$/.exec(s || "");
  return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : 0;
}

// $RepresentationID$, $Number%05d$, $Time$, $Bandwidth$, $$
function fillTemplate(t, vars) {
  return t.replace(/\$(RepresentationID|Number|Bandwidth|Time|SubNumber)?(?:%0(\d+)d)?\$/g, (m, k, w) => {
    if (!k) return "$";
    let s = String(vars[k] ?? "");
    if (w) s = s.padStart(+w, "0");
    return s;
  });
}

/* ---------- segment listesi üretimi ---------- */
function dashSegInfo(chain, name) {
  const nodes = chain.map((n) => xKid(n, name)).filter(Boolean);
  if (!nodes.length) return null;
  return { attrs: Object.assign({}, ...nodes.map((n) => n.attrs)), nodes };
}
function dashPick(nodes, child) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const c = xKids(nodes[i], child);
    if (c.length) return c;
  }
  return [];
}

// -> { init: {url, range?}|null, list: [{url, range?}] }
function dashExpand(rep, chain, periodDur) {
  const vars = { RepresentationID: rep.id, Bandwidth: rep.bandwidth };
  const abs = (u) => new URL(u, rep.base).href;

  const tpl = dashSegInfo(chain, "SegmentTemplate");
  if (tpl && tpl.attrs.media) {
    const a = tpl.attrs, ts = +a.timescale || 1, start = a.startNumber != null ? +a.startNumber : 1;
    const init = a.initialization ? { url: abs(fillTemplate(a.initialization, vars)) } : null;
    const timeline = dashPick(tpl.nodes, "SegmentTimeline")[0];
    const list = [];
    if (timeline) {
      let t = 0, n = start;
      for (const s of xKids(timeline, "S")) {
        if (s.attrs.t != null) t = +s.attrs.t;
        const d = +s.attrs.d;
        if (!d) continue;
        let r = +(s.attrs.r || 0);
        if (r < 0) r = periodDur ? Math.max(0, Math.ceil((periodDur * ts - t) / d) - 1) : 0;
        for (let i = 0; i <= r; i++, t += d, n++)
          list.push({ url: abs(fillTemplate(a.media, { ...vars, Number: n, Time: t })) });
      }
    } else {
      const d = +a.duration;
      if (!d || !periodDur) throw new Error("DASH segment süresi belirlenemedi");
      const count = Math.ceil((periodDur * ts) / d);
      for (let i = 0; i < count; i++)
        list.push({ url: abs(fillTemplate(a.media, { ...vars, Number: start + i, Time: i * d })) });
    }
    return { init, list };
  }

  const sl = dashSegInfo(chain, "SegmentList");
  if (sl) {
    const ini = dashPick(sl.nodes, "Initialization")[0];
    const init = ini ? { url: ini.attrs.sourceURL ? abs(ini.attrs.sourceURL) : rep.base, range: ini.attrs.range } : null;
    const list = dashPick(sl.nodes, "SegmentURL").map((s) => ({
      url: s.attrs.media ? abs(s.attrs.media) : rep.base,
      range: s.attrs.mediaRange
    }));
    return { init, list };
  }

  // SegmentBase / yalnızca BaseURL: tek dosya
  if (!rep.hasBase) throw new Error("DASH segment adresi bulunamadı");
  return { init: null, list: [{ url: rep.base }] };
}

/* ---------- MPD ---------- */
// -> { live, duration, drm, video: [rep] (bant genişliğine göre azalan), audio: [rep] (manifest sırası) }
function parseMpd(text, base) {
  const mpd = parseXml(text).children.find((c) => c.name === "MPD");
  if (!mpd) return null;
  const baseOf = (b, node) => {
    const t = (xKid(node, "BaseURL")?.text || "").trim();
    return t ? new URL(t, b).href : b;
  };
  const mpdDur = isoDuration(mpd.attrs.mediaPresentationDuration);
  const mpdBase = baseOf(base, mpd);
  const periodNodes = xKids(mpd, "Period");
  if (!periodNodes.length) return null;
  const periods = periodNodes.map((node) => ({
    node, dur: isoDuration(node.attrs.duration) || (periodNodes.length === 1 ? mpdDur : 0)
  }));
  const P = periods.slice().sort((a, b) => b.dur - a.dur)[0]; // reklam vb. kısa dönemleri atlamak için en uzun dönem
  const pBase = baseOf(mpdBase, P.node);

  const out = { live: mpd.attrs.type === "dynamic", duration: P.dur, drm: false, video: [], audio: [] };
  for (const as of xKids(P.node, "AdaptationSet")) {
    const asBase = baseOf(pBase, as);
    for (const r of xKids(as, "Representation")) {
      const mime = r.attrs.mimeType || as.attrs.mimeType || "";
      const codecs = r.attrs.codecs || as.attrs.codecs || "";
      let type = as.attrs.contentType || mime.split("/")[0];
      if (type !== "video" && type !== "audio") {
        if (/^(avc|hvc|hev|vp0?9|av01|dvh)/i.test(codecs) || r.attrs.width || as.attrs.width) type = "video";
        else if (/^(mp4a|opus|ec-3|ac-3|flac|vorbis)/i.test(codecs)) type = "audio";
      }
      if (type !== "video" && type !== "audio") continue;
      if (xKids(as, "ContentProtection").length || xKids(r, "ContentProtection").length) { out.drm = true; continue; }

      const chain = [P.node, as, r];
      const rep = {
        id: r.attrs.id || "", type, mime, codecs,
        container: /webm/i.test(mime) ? "webm" : "mp4",
        bandwidth: +r.attrs.bandwidth || 0,
        width: +(r.attrs.width || as.attrs.width) || 0,
        height: +(r.attrs.height || as.attrs.height) || 0,
        lang: as.attrs.lang || "",
        base: baseOf(asBase, r)
      };
      rep.hasBase = rep.base !== base;
      const tpl = dashSegInfo(chain, "SegmentTemplate");
      rep.single = !(tpl && tpl.attrs.media) && !dashSegInfo(chain, "SegmentList") && rep.hasBase;
      rep.getSegments = () => dashExpand(rep, chain, P.dur);
      out[type].push(rep);
    }
  }
  out.video.sort((a, b) => b.bandwidth - a.bandwidth);
  return out;
}

// Seçilen görüntüye uygun ses: aynı kapsayıcı > ilk dil > mp4a > en yüksek bant genişliği
function pickDashAudio(info, video) {
  let c = info.audio;
  if (!c.length) return null;
  const same = c.filter((a) => a.container === video.container);
  if (same.length) c = same;
  c = c.filter((a) => a.lang === c[0].lang);
  const aac = c.filter((a) => /^mp4a/i.test(a.codecs));
  if (aac.length) c = aac;
  return c.slice().sort((a, b) => b.bandwidth - a.bandwidth)[0];
}

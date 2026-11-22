// HLS (.m3u8) çözümleyici — background ve dl.html kullanır
function parseAttrs(line) {
  const out = {};
  const s = line.slice(line.indexOf(":") + 1);
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2].replace(/^"|"$/g, "");
  return out;
}

function parsePlaylist(text, base) {
  if (!text || !/^#EXTM3U/.test(text.trim())) return null;
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

  if (lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"))) {
    const variants = [], audio = {};
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith("#EXT-X-MEDIA:")) {
        const a = parseAttrs(l);
        if (a.TYPE === "AUDIO" && a.URI)
          (audio[a["GROUP-ID"]] ||= []).push({
            url: new URL(a.URI, base).href,
            name: a.NAME || "", lang: a.LANGUAGE || "",
            def: a.DEFAULT === "YES", auto: a.AUTOSELECT === "YES"
          });
      } else if (l.startsWith("#EXT-X-STREAM-INF")) {
        const a = parseAttrs(l);
        const u = lines[i + 1];
        if (u && !u.startsWith("#")) {
          variants.push({
            url: new URL(u, base).href,
            bandwidth: parseInt(a.BANDWIDTH, 10) || 0,
            resolution: a.RESOLUTION || "",
            audioGroup: a.AUDIO || null
          });
        }
      }
    }
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    return { master: true, variants, audio };
  }

  let seq = 0, map = null, key = null, pending = 0, duration = 0, endlist = false;
  const segments = [];
  for (const l of lines) {
    if (l.startsWith("#EXT-X-MEDIA-SEQUENCE:")) seq = parseInt(l.split(":")[1], 10) || 0;
    else if (l.startsWith("#EXT-X-MAP:")) map = new URL(parseAttrs(l).URI, base).href;
    else if (l.startsWith("#EXT-X-KEY:")) {
      const a = parseAttrs(l);
      key = a.METHOD === "NONE" ? null
        : { method: a.METHOD, uri: a.URI ? new URL(a.URI, base).href : null, iv: a.IV || null };
    } else if (l.startsWith("#EXTINF:")) {
      pending = 1;
      duration += parseFloat(l.slice(8)) || 0;
    } else if (l.startsWith("#EXT-X-ENDLIST")) endlist = true;
    else if (!l.startsWith("#") && pending) {
      segments.push({ url: new URL(l, base).href, seq: seq + segments.length, key });
      pending = 0;
    }
  }
  return { master: false, segments, map, duration, endlist };
}

// Çözünürlüğü standart kalite sınıfına çevirir (1920x800 → 1080, dikey videolar dahil)
const STD_HEIGHTS = [144, 240, 360, 480, 720, 1080, 1440, 2160, 4320];
function snapDims(w, h) {
  if (!w || !h) return 0;
  if (h > w) [w, h] = [h, w];
  const eff = Math.max(h, Math.round((w * 9) / 16));
  return STD_HEIGHTS.reduce((a, b) => (Math.abs(b - eff) < Math.abs(a - eff) ? b : a));
}
function snapHeight(res) {
  const m = /(\d+)x(\d+)/.exec(res || "");
  return m ? snapDims(+m[1], +m[2]) : 0;
}

// Kutucuklara göre (1080p ve üstü / 1080p ve altı) listeden (bant genişliğine göre azalan) bir öğe seçer
function chooseByQuality(list, heightOf, st) {
  let best = list[0];
  if (st.above === st.below) return best; // ikisi de seçili ya da boş: en iyisi
  const known = list.filter((v) => heightOf(v));
  if (known.length) {
    const m = known.filter((v) => (st.above ? heightOf(v) >= 1080 : heightOf(v) <= 1080));
    if (!m.length) throw new Error(st.above ? "1080p ve üstü kalite bulunamadı" : "1080p ve altı kalite bulunamadı");
    best = m[0];
  }
  return best;
}

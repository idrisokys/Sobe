// Bağımlılıksız MP4 birleştirici: ayrı görüntü + ses akışını tek mp4'e çevirir.
//   mergeMp4(videoParts, audioParts) -> { parts: Uint8Array[] }   (Blob'a verilecek parçalar)
// Desteklenen: (a) parçalı mp4 (init + moof/mdat, DASH / HLS-CMAF), (b) düz mp4 (moov + mdat).
// Desteklenmeyen girdide e.unsupported = true olan bir hata fırlatır.
(function (root) {
  "use strict";

  const dvOf = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
  const cc = (b, p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
  const fail = (m) => Object.assign(new Error(m), { unsupported: true });
  const getU64 = (d, p) => d.getUint32(p) * 4294967296 + d.getUint32(p + 4);
  const setU64 = (d, p, v) => { d.setUint32(p, Math.floor(v / 4294967296)); d.setUint32(p + 4, v >>> 0); };

  /* ---------- kutu okuma / yazma ---------- */
  function readBoxes(buf, s = 0, e = buf.length) {
    const out = [], d = dvOf(buf);
    let p = s;
    while (p + 8 <= e) {
      let size = d.getUint32(p), hdr = 8;
      if (size === 1) { if (p + 16 > e) break; size = getU64(d, p + 8); hdr = 16; }
      else if (size === 0) size = e - p;
      if (size < hdr || p + size > e) break; // eksik / bozuk
      out.push({ type: cc(buf, p + 4), start: p, end: p + size, payload: p + hdr });
      p += size;
    }
    return out;
  }
  const find = (buf, box, type) => readBoxes(buf, box.payload, box.end).find((b) => b.type === type);
  const pathFind = (buf, box, ...types) => {
    let b = box;
    for (const t of types) { if (!b) return undefined; b = find(buf, b, t); }
    return b;
  };
  function mk(type, ...parts) {
    let len = 8;
    for (const p of parts) len += p.length;
    const o = new Uint8Array(len);
    dvOf(o).setUint32(0, len);
    for (let i = 0; i < 4; i++) o[4 + i] = type.charCodeAt(i);
    let q = 8;
    for (const p of parts) { o.set(p, q); q += p.length; }
    return o;
  }
  const be32 = (...n) => {
    const o = new Uint8Array(n.length * 4), d = dvOf(o);
    n.forEach((v, i) => d.setUint32(i * 4, v >>> 0));
    return o;
  };
  const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
  const defaultFtyp = () => mk("ftyp", ascii("isom"), be32(0x200), ascii("isomiso2avc1mp41"));

  /* ---------- moov çözümleme ---------- */
  function readMoov(buf, moov) {
    const d = dvOf(buf);
    const kids = readBoxes(buf, moov.payload, moov.end);
    const mvhd = kids.find((b) => b.type === "mvhd");
    if (!mvhd) throw fail("mvhd yok");
    const v1 = buf[mvhd.payload] === 1;
    const info = {
      buf, moov, mvhd,
      movieTs: d.getUint32(mvhd.payload + (v1 ? 20 : 12)),
      duration: v1 ? getU64(d, mvhd.payload + 24) : d.getUint32(mvhd.payload + 16),
      tracks: [], trex: {}
    };
    for (const k of kids) {
      if (k.type === "trak") {
        const tkhd = find(buf, k, "tkhd"), mdia = find(buf, k, "mdia");
        const hdlr = mdia && find(buf, mdia, "hdlr"), mdhd = mdia && find(buf, mdia, "mdhd");
        if (!tkhd || !hdlr || !mdhd) continue;
        info.tracks.push({
          box: k,
          id: d.getUint32(tkhd.payload + (buf[tkhd.payload] === 1 ? 20 : 12)),
          handler: cc(buf, hdlr.payload + 8),
          ts: d.getUint32(mdhd.payload + (buf[mdhd.payload] === 1 ? 20 : 12))
        });
      } else if (k.type === "mvex") {
        for (const t of readBoxes(buf, k.payload, k.end))
          if (t.type === "trex") info.trex[d.getUint32(t.payload + 4)] = t;
      }
    }
    return info;
  }

  // trak'ı kopyalar; yeni track_ID verir, film zaman ölçeğini hedefe çevirir
  function copyTrak(info, tr, newId, toTs) {
    const copy = info.buf.slice(tr.box.start, tr.box.end);
    const rootBox = readBoxes(copy)[0], d = dvOf(copy);
    const tkhd = find(copy, rootBox, "tkhd"), v1 = copy[tkhd.payload] === 1;
    d.setUint32(tkhd.payload + (v1 ? 20 : 12), newId);
    const from = info.movieTs;
    if (from && toTs && from !== toTs) {
      const k = (x) => Math.round((x * toTs) / from);
      if (v1) setU64(d, tkhd.payload + 28, k(getU64(d, tkhd.payload + 28)));
      else d.setUint32(tkhd.payload + 20, k(d.getUint32(tkhd.payload + 20)));
      const edts = find(copy, rootBox, "edts"), elst = edts && find(copy, edts, "elst");
      if (elst) {
        const ver = copy[elst.payload], n = d.getUint32(elst.payload + 4);
        let p = elst.payload + 8;
        for (let i = 0; i < n; i++, p += ver === 1 ? 20 : 12) {
          if (ver === 1) setU64(d, p, k(getU64(d, p)));
          else d.setUint32(p, k(d.getUint32(p)));
        }
      }
    }
    return { copy, root: rootBox };
  }

  function copyMvhd(info, nextId, duration) {
    const copy = info.buf.slice(info.mvhd.start, info.mvhd.end);
    const b = readBoxes(copy)[0], d = dvOf(copy), v1 = copy[b.payload] === 1;
    d.setUint32(b.payload + (v1 ? 108 : 96), nextId);
    if (duration != null) {
      if (v1) setU64(d, b.payload + 24, duration);
      else d.setUint32(b.payload + 16, duration);
    }
    return copy;
  }

  /* ---------- akışı tara ---------- */
  function scan(parts) {
    const r = { ftyp: null, init: null, frags: [], mdats: [] };
    for (const part of parts) {
      let moof = null;
      for (const b of readBoxes(part)) {
        if (b.type === "ftyp" && !r.ftyp) r.ftyp = part.slice(b.start, b.end);
        else if (b.type === "moov" && !r.init) r.init = readMoov(part, b);
        else if (b.type === "mdat") {
          if (moof && moof.end === b.start) r.frags.push({ buf: part, moof, mdat: b });
          else if (moof) throw fail("moof ile mdat bitişik değil");
          else r.mdats.push({ buf: part, box: b });
          moof = null;
        } else moof = b.type === "moof" ? b : null;
      }
    }
    return r;
  }

  const track = (info, handler, label) => {
    const t = info.tracks.find((x) => x.handler === handler);
    if (!t) throw fail(`${label} izi bulunamadı`);
    return t;
  };

  /* ---------- parçalı mp4 birleştirme ---------- */
  function fragDuration(buf, traf, tfhd, defDur) {
    const d = dvOf(buf), fl = d.getUint32(tfhd.payload) & 0xffffff;
    let p = tfhd.payload + 8;
    if (fl & 1) p += 8;
    if (fl & 2) p += 4;
    if (fl & 8) defDur = d.getUint32(p);
    let total = 0;
    for (const t of readBoxes(buf, traf.payload, traf.end)) {
      if (t.type !== "trun") continue;
      const tf = d.getUint32(t.payload) & 0xffffff, n = d.getUint32(t.payload + 4);
      if (!(tf & 0x100)) { total += n * defDur; continue; }
      let q = t.payload + 8;
      if (tf & 1) q += 4;
      if (tf & 4) q += 4;
      const step = 4 * ((tf & 0x100 ? 1 : 0) + (tf & 0x200 ? 1 : 0) + (tf & 0x400 ? 1 : 0) + (tf & 0x800 ? 1 : 0));
      for (let i = 0; i < n; i++, q += step) total += d.getUint32(q);
    }
    return total;
  }

  // her parçaya saniye cinsinden başlangıç zamanı ekler
  function timeline(S, tr) {
    const trex = S.init.trex[tr.id];
    const defDur = trex ? dvOf(S.init.buf).getUint32(trex.payload + 12) : 0;
    let run = 0;
    for (const f of S.frags) {
      const d = dvOf(f.buf);
      const traf = readBoxes(f.buf, f.moof.payload, f.moof.end).filter((b) => b.type === "traf");
      if (traf.length !== 1) throw fail("moof birden fazla iz içeriyor");
      const kids = readBoxes(f.buf, traf[0].payload, traf[0].end);
      const tfhd = kids.find((b) => b.type === "tfhd"), tfdt = kids.find((b) => b.type === "tfdt");
      if (!tfhd) throw fail("tfhd yok");
      let t = run;
      if (tfdt) t = f.buf[tfdt.payload] === 1 ? getU64(d, tfdt.payload + 4) : d.getUint32(tfdt.payload + 4);
      let dur = 0;
      try { dur = fragDuration(f.buf, traf[0], tfhd, defDur); } catch {}
      run = t + dur;
      f.t = t / (tr.ts || 1);
    }
  }

  function mergeFragmented(V, A) {
    const vt = track(V.init, "vide", "Görüntü"), at = track(A.init, "soun", "Ses");
    const aId = at.id === vt.id ? vt.id + 1 : at.id;
    const movieTs = V.init.movieTs;
    const trexOf = (info, id, newId) => {
      const t = info.trex[id];
      if (!t) return mk("trex", be32(0, newId, 1, 0, 0, 0));
      const c = info.buf.slice(t.start, t.end);
      dvOf(c).setUint32(t.payload - t.start + 4, newId);
      return c;
    };
    const moov = mk("moov",
      copyMvhd(V.init, Math.max(vt.id, aId) + 1),
      copyTrak(V.init, vt, vt.id, movieTs).copy,
      copyTrak(A.init, at, aId, movieTs).copy,
      mk("mvex", trexOf(V.init, vt.id, vt.id), trexOf(A.init, at.id, aId)));
    const ftyp = V.ftyp || defaultFtyp();

    timeline(V, vt); timeline(A, at);
    const all = [
      ...V.frags.map((f) => ({ f, id: vt.id, t: f.t })),
      ...A.frags.map((f) => ({ f, id: aId, t: f.t }))
    ].sort((x, y) => x.t - y.t); // kararlı sıralama: eşitlikte görüntü önce

    const out = [ftyp, moov];
    let pos = ftyp.length + moov.length;
    for (const x of all) {
      const m = x.f.buf.slice(x.f.moof.start, x.f.moof.end);
      const mb = readBoxes(m)[0];
      const tfhd = pathFind(m, mb, "traf", "tfhd"), d = dvOf(m);
      d.setUint32(tfhd.payload + 4, x.id);
      if (d.getUint32(tfhd.payload) & 1) setU64(d, tfhd.payload + 8, pos); // mutlak base_data_offset
      const mdat = x.f.buf.subarray(x.f.mdat.start, x.f.mdat.end);
      out.push(m, mdat);
      pos += m.length + mdat.length;
    }
    return { parts: out };
  }

  /* ---------- düz mp4 birleştirme ---------- */
  function patchChunks(t, shift) {
    const stbl = pathFind(t.copy, t.root, "mdia", "minf", "stbl");
    const co = stbl && (find(t.copy, stbl, "stco") || find(t.copy, stbl, "co64"));
    if (!co) throw fail("chunk offset tablosu yok");
    const d = dvOf(t.copy), n = d.getUint32(co.payload + 4);
    for (let i = 0; i < n; i++) {
      if (co.type === "stco") {
        const p = co.payload + 8 + 4 * i, v = d.getUint32(p) + shift;
        if (v > 0xffffffff || v < 0) throw fail("32 bit offset sınırı aşıldı");
        d.setUint32(p, v);
      } else {
        const p = co.payload + 8 + 8 * i;
        setU64(d, p, getU64(d, p) + shift);
      }
    }
  }

  function mergeProgressive(V, A) {
    const vt = track(V.init, "vide", "Görüntü"), at = track(A.init, "soun", "Ses");
    const region = (S) => {
      if (!S.mdats.length) throw fail("mdat yok");
      const buf = S.mdats[0].buf;
      if (S.mdats.some((m) => m.buf !== buf)) throw fail("mdat parçalı");
      return { buf, s: S.mdats[0].box.payload, e: S.mdats[S.mdats.length - 1].box.end };
    };
    const v = region(V), a = region(A);
    const aId = at.id === vt.id ? vt.id + 1 : at.id;
    const movieTs = V.init.movieTs;
    const dur = Math.max(V.init.duration, A.init.movieTs ? Math.round((A.init.duration * movieTs) / A.init.movieTs) : 0);

    const build = (vShift, aShift) => {
      const vtr = copyTrak(V.init, vt, vt.id, movieTs), atr = copyTrak(A.init, at, aId, movieTs);
      patchChunks(vtr, vShift); patchChunks(atr, aShift);
      return mk("moov", copyMvhd(V.init, Math.max(vt.id, aId) + 1, dur), vtr.copy, atr.copy);
    };
    const ftyp = V.ftyp || defaultFtyp();
    const vLen = v.e - v.s, aLen = a.e - a.s, total = vLen + aLen;
    const big = total + 8 > 0xffffffff;
    let hdr;
    if (big) { hdr = new Uint8Array(16); const d = dvOf(hdr); d.setUint32(0, 1); hdr.set(ascii("mdat"), 4); setU64(d, 8, total + 16); }
    else hdr = mk("mdat", new Uint8Array(0)), dvOf(hdr).setUint32(0, total + 8);
    const start = ftyp.length + build(0, 0).length + hdr.length; // moov boyutu offset'ten bağımsız
    const moov = build(start - v.s, start + vLen - a.s);
    return { parts: [ftyp, moov, hdr, v.buf.subarray(v.s, v.e), a.buf.subarray(a.s, a.e)] };
  }

  /* ---------- giriş noktası ---------- */
  function mergeMp4(videoParts, audioParts) {
    const V = scan(videoParts), A = scan(audioParts);
    if (!V.init || !A.init) throw fail("MP4 başlığı (moov) bulunamadı");
    if (V.frags.length && A.frags.length) return mergeFragmented(V, A);
    if (!V.frags.length && !A.frags.length) {
      if (videoParts.length !== 1 || audioParts.length !== 1) throw fail("düz mp4 tek parça olmalı");
      return mergeProgressive(V, A);
    }
    throw fail("parçalı ve düz mp4 birlikte birleştirilemez");
  }

  root.mergeMp4 = mergeMp4;
  if (typeof module !== "undefined" && module.exports) module.exports = { mergeMp4 };
})(typeof self !== "undefined" ? self : globalThis);

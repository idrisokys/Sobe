// URL'deki bölüm numarasını bulur: .../psyren-1-bolum-izle  ->  pre + N + post
function parseEpisodeUrl(href) {
  let u;
  try { u = new URL(href); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const p = u.pathname;
  let i = -1, s = "";
  let m = /(\d+)(?=-(?:bolum|episode|ep)(?:[-/]|$))/i.exec(p); // psyren-1-bolum-izle
  if (m) { i = m.index; s = m[1]; }
  if (i < 0 && (m = /(?:bolum|episode|ep)-(\d+)/i.exec(p))) { s = m[1]; i = m.index + m[0].length - s.length; } // bolum-1
  if (i < 0) {
    const all = [...p.matchAll(/\d+/g)]; // son çare: yoldaki son sayı
    if (!all.length) return null;
    const l = all[all.length - 1];
    i = l.index; s = l[0];
  }
  return {
    pre: u.origin + p.slice(0, i),
    post: p.slice(i + s.length) + u.search + u.hash,
    width: s.length > 1 && s[0] === "0" ? s.length : 0, // 01, 02 gibi sıfırlı numaralar
    n: parseInt(s, 10)
  };
}
function episodeUrl(tpl, n) {
  const num = tpl.width ? String(n).padStart(tpl.width, "0") : String(n);
  return tpl.pre + num + tpl.post;
}

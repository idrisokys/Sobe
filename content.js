// Sayfadaki (ve iframe'lerdeki) <video> kaynaklarını arka plana bildirir
(() => {
  const seen = new Set();
  const report = (url) => {
    if (!url || !/^https?:/i.test(url) || seen.has(url)) return;
    seen.add(url);
    try { chrome.runtime.sendMessage({ type: "found", url }); } catch {}
  };
  const dimsSent = new Set();
  const dims = (v) => {
    const u = v.currentSrc || v.src;
    if (!u || !v.videoWidth || !/^https?:/i.test(u) || dimsSent.has(u)) return;
    dimsSent.add(u);
    try { chrome.runtime.sendMessage({ type: "dims", url: u, w: v.videoWidth, h: v.videoHeight }); } catch {}
  };
  document.addEventListener("loadedmetadata", (e) => e.target instanceof HTMLVideoElement && dims(e.target), true);
  const scan = () => {
    document.querySelectorAll("video").forEach((v) => {
      report(v.currentSrc || v.src);
      v.querySelectorAll("source").forEach((s) => report(s.src));
      dims(v);
    });
  };
  scan();
  let t;
  new MutationObserver(() => { clearTimeout(t); t = setTimeout(scan, 500); })
    .observe(document.documentElement, { childList: true, subtree: true });
  let n = 0;
  const iv = setInterval(() => { scan(); if (++n > 30) clearInterval(iv); }, 2000);
})();

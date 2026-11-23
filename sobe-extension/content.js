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
  // Seri modu: videoyu başlatmayı dene (oynat düğmesi + gerekirse yedek oynatıcıya geçiş)
  const PLAY_SEL = ["[data-watch-player] button[aria-label=Oynat]", ".jw-icon-display", ".jw-display-icon-container",
    ".vjs-big-play-button", ".plyr__control--overlaid", ".ytp-large-play-button", ".fp-play", ".dplayer-play-icon",
    ".art-state", "[class*=play-btn]", "[class*=play-button]", "[class*=btn-play]", "[class*=big-play]",
    "[aria-label=Play]", "[aria-label=Oynat]", "[title=Play]", "#play"];
  const isTop = window === window.top;
  let clicks = 0, lastClick = 0, switched = false;
  const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 8 && r.height > 8; };
  chrome.runtime.onMessage.addListener((m) => {
    if (!m || m.type !== "tryPlay") return;
    const vids = [...document.querySelectorAll("video")];
    if (vids.some((v) => !v.paused && !v.ended)) return; // zaten oynuyor: dokunma
    vids.forEach((v) => { v.muted = true; v.play().catch(() => {}); });
    // Yedek oynatıcı: 2., 3. denemede sitedeki OYNATICI düğmelerinden sıradakine geç (yalnız ana sayfada)
    if (isTop && m.alt > 0 && !switched) {
      const btns = [...document.querySelectorAll('button[aria-label$="oynatıcısına geç"]')];
      if (btns[m.alt]) { switched = true; lastClick = Date.now(); btns[m.alt].click(); return; }
    }
    // Sayfa tam hazır olmadan yapılan tıklama işe yaramaz: 3 sn arayla tekrar dene
    if (clicks >= 8 || Date.now() - lastClick < 3000) return;
    for (const sel of PLAY_SEL) {
      const b = [...document.querySelectorAll(sel)].find(visible);
      if (b) { clicks++; lastClick = Date.now(); b.click(); return; }
    }
    const v = vids.find(visible);
    if (v) { clicks++; lastClick = Date.now(); v.click(); }
  });
})();

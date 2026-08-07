/* ===========================================================================
   mobile.js - real phone layouts for the tool suite.

   Loaded by cloud-fs.js only on small screens. Uses each tool's own CSS
   variables (--bg, --panel, --line, --ink...) so everything matches the
   tool's theme, light or dark. The tool files themselves stay untouched.

   The two-pane tools become proper master/detail: the library's reading pane
   slides over the list, the manuscript's and family tree's lists become
   drawers, and editors get a thumb-reachable save bar.
   =========================================================================== */
(function () {
  "use strict";
  if (window.innerWidth > 820) return;
  const page = (location.pathname.split("/").pop() || "index.html");

  const addCss = (t) => {
    const s = document.createElement("style");
    s.textContent = t;
    document.head.appendChild(s);
  };
  const SAFE = "env(safe-area-inset-bottom)";

  /* Shared groundwork: wrapping headers, sane media, no iOS zoom-on-focus. */
  addCss(`
header{flex-wrap:wrap !important;row-gap:6px}
#navScrim{left:0 !important;width:100% !important;max-width:100vw !important}
img,svg,canvas,video{max-width:100%}
input,select,textarea{font-size:16px !important}
.m-fab{
  position:fixed;z-index:80;bottom:calc(16px + ${SAFE});
  background:var(--panel,#1d1b26);color:var(--ink,#e9e5f2);
  border:1px solid var(--line,#3a3550);border-radius:99px;
  padding:11px 18px;font:600 14px system-ui,sans-serif;cursor:pointer;
  box-shadow:0 6px 20px rgba(0,0,0,.35);
}
.m-scrim{position:fixed;inset:0;z-index:65;background:rgba(0,0,0,.45);display:none}
body.m-nav .m-scrim{display:block}
`);

  function fab(label, side, onClick) {
    const b = document.createElement("button");
    b.className = "m-fab";
    b.style[side] = "14px";
    b.textContent = label;
    b.addEventListener("click", onClick);
    document.body.appendChild(b);
    return b;
  }
  function scrim(onTap) {
    const d = document.createElement("div");
    d.className = "m-scrim";
    d.addEventListener("click", onTap);
    document.body.appendChild(d);
    return d;
  }

  /* ------------------------------------------------------------- library
     List is the home screen; the reading pane slides over it when an entry
     is picked. A back button slides it away again.                        */
  if (page === "library.html") {
    addCss(`
#view{
  position:fixed;inset:0;z-index:70;background:var(--bg,#14131a);
  overflow-y:auto;-webkit-overflow-scrolling:touch;
  padding:16px 16px calc(90px + ${SAFE});max-width:none;margin:0;
  transform:translateX(103%);transition:transform .22s ease;
}
body.m-read #view{transform:none}
#backFab{display:none}
body.m-read #backFab{display:block}
`);
    const view = document.getElementById("view");
    const side = document.getElementById("side");
    const back = fab("‹ Back to list", "left", () => {
      document.body.classList.remove("m-read");
    });
    back.id = "backFab";
    let fromList = false;
    if (side) side.addEventListener("pointerdown", (e) => {
      // A row tap (button.item), not a section header or the filter box.
      const hit = e.target.closest(".item, li, a");
      fromList = !!hit && !e.target.closest("input");
    }, true);
    // Deep links (#open=...) should land straight on the entry too.
    if (/open=/.test(location.hash)) setTimeout(() => {
      if (view && view.textContent.trim().length > 60) document.body.classList.add("m-read");
    }, 900);
    if (view) new MutationObserver(() => {
      if (fromList) {
        fromList = false;
        document.body.classList.add("m-read");
        view.scrollTop = 0;
      }
    }).observe(view, { childList: true, subtree: true });
  }

  /* ---------------------------------------------------------- manuscript
     Chapter list becomes a left drawer; the editor gets the whole screen
     and a fixed save bar.                                                 */
  if (page === "manuscript.html") {
    addCss(`
#sidebar{
  position:fixed;top:0;bottom:0;left:0;z-index:70;width:min(320px,86vw);
  transform:translateX(-104%);transition:transform .22s ease;
  box-shadow:6px 0 24px rgba(0,0,0,.35);
  padding-bottom:calc(80px + ${SAFE}) !important;
}
body.m-nav #sidebar{transform:none}
`);
    const sb = document.getElementById("sidebar");
    const close = () => document.body.classList.remove("m-nav");
    scrim(close);
    fab("☰ Chapters", "left", () => document.body.classList.toggle("m-nav"));
    // Close the drawer when a pick actually loads into the editor - story
    // rows just expand their chapter list and should keep the drawer open.
    let picked = false;
    if (sb) sb.addEventListener("pointerdown", () => { picked = true; setTimeout(() => picked = false, 800); }, true);
    const ed = document.getElementById("editor");
    if (ed) new MutationObserver(() => { if (picked) { picked = false; close(); } })
      .observe(ed, { childList: true, subtree: true });
    stickySave();
  }

  /* --------------------------------------------------------- family tree
     Grid collapses to just the canvas; the character list becomes a
     drawer. The detail panel was already hidden at this width.            */
  if (page === "family-tree.html") {
    addCss(`
main{grid-template-columns:1fr !important}
#list{
  position:fixed;top:0;bottom:0;left:0;z-index:70;width:min(300px,84vw);
  background:var(--panel,#1d1b26);transform:translateX(-104%);
  transition:transform .22s ease;overflow-y:auto;
  box-shadow:6px 0 24px rgba(0,0,0,.35);padding:14px;
  padding-bottom:calc(80px + ${SAFE});
}
body.m-nav #list{transform:none}
/* The zoom bar lives bottom-left, exactly where the Characters button sits.
   Lift it clear, pad for the home bar, and make the buttons finger-sized. */
.zoombar{bottom:calc(74px + ${SAFE}) !important;left:14px !important}
.zoombar button{min-width:42px;min-height:42px;font-size:19px}
.legend{bottom:calc(14px + ${SAFE}) !important;max-width:46vw}
`);
    scrim(() => document.body.classList.remove("m-nav"));
    fab("☰ Characters", "left", () => document.body.classList.toggle("m-nav"));
    pinchZoom("tree");
  }

  /* ----------------------------------------------------------- world map
     Already single-column here; the legend just fought the zoom control
     for the same corner. Tuck it behind the map's own help instead.       */
  if (page === "world-map.html") {
    addCss(`
#legend{display:none}
body.m-key #legend{display:block;bottom:calc(74px + ${SAFE});right:12px;max-width:74vw}
.zoombar{bottom:calc(14px + ${SAFE}) !important}
.zoombar button{min-width:42px;min-height:42px;font-size:19px}
`);
    const key = fab("Key", "right", () => document.body.classList.toggle("m-key"));
    key.style.bottom = `calc(16px + ${SAFE})`;
    pinchZoom("map");
  }

  /* --------------------------------------------------------------- writer
     The save button lives three wrapped header rows up. Give the thumb a
     fixed bar instead.                                                    */
  if (page === "character-writer.html") {
    stickySave();
  }

  /* Two-finger pinch on the canvas tools. Their zoom lives behind a wheel
     handler, so translate the pinch into the wheel events they understand -
     all of the tool's own zoom maths and limits keep working. */
  function pinchZoom(svgId) {
    const svg = document.getElementById(svgId);
    if (!svg) return;
    let d0 = 0;
    let pinching = false;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const mid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });

    // The tool's own single-finger pan listens on this same svg for
    // pointerdown/pointermove. The moment a second finger lands it fires its
    // own pointerdown too, which resets the pan's anchor to that finger -
    // then every pointermove from either finger yanks the view toward
    // whichever one moved last, which reads as the zoom center "flicking"
    // between fingers. Block touch-driven pointer events from ever reaching
    // that pan handler for the whole two-finger gesture so only our wheel-
    // based zoom (using the true midpoint) drives the view.
    const blockPan = (e) => {
      if (pinching && e.pointerType === "touch") e.stopPropagation();
    };
    document.addEventListener("pointerdown", blockPan, true);
    document.addEventListener("pointermove", blockPan, true);

    svg.addEventListener("touchstart", (e) => {
      if (e.touches.length === 2) { d0 = dist(e.touches); pinching = true; e.preventDefault(); }
    }, { passive: false });
    svg.addEventListener("touchmove", (e) => {
      if (e.touches.length !== 2 || !d0) return;
      e.preventDefault();
      const d1 = dist(e.touches);
      if (Math.abs(d1 - d0) < 8) return;
      const m = mid(e.touches);
      svg.dispatchEvent(new WheelEvent("wheel", {
        deltaY: d1 > d0 ? -1 : 1, clientX: m.x, clientY: m.y,
        bubbles: true, cancelable: true,
      }));
      d0 = d1;
    }, { passive: false });
    // Stay blocked until every finger lifts, not just back down to one -
    // otherwise the remaining finger's pan resumes from a stale anchor and
    // the view jumps once more on the way out of the gesture.
    svg.addEventListener("touchend", (e) => {
      if (e.touches.length === 0) { d0 = 0; pinching = false; }
    });
    svg.addEventListener("touchcancel", () => { d0 = 0; pinching = false; });
  }

  /* A fixed bottom bar whose Save proxies the tool's own #btnSave, so all
     of the tool's logic (dirty checks, toasts) still runs. */
  function stickySave() {
    // The manuscript builds its editor - save button included - only once a
    // chapter is opened, so wait for the button rather than requiring it.
    const real = document.getElementById("btnSave");
    if (!real) {
      const mo = new MutationObserver(() => {
        if (document.getElementById("btnSave")) { mo.disconnect(); stickySave(); }
      });
      mo.observe(document.body, { childList: true, subtree: true });
      return;
    }
    addCss(`
#mSaveBar{
  position:fixed;left:0;right:0;bottom:0;z-index:60;display:flex;gap:10px;
  align-items:center;padding:10px 14px calc(10px + ${SAFE});
  background:var(--panel,#1d1b26);border-top:1px solid var(--line,#3a3550);
}
#mSaveBar button{
  flex:1;padding:12px;border-radius:10px;border:0;cursor:pointer;
  background:var(--accent,#a78bdb);color:#17141f;font:600 15px system-ui;
}
header #btnSave{display:none}
body{padding-bottom:calc(64px + ${SAFE})}
.m-fab{bottom:calc(72px + ${SAFE})}
`);
    const bar = document.createElement("div");
    bar.id = "mSaveBar";
    const b = document.createElement("button");
    const sync = () => { b.textContent = real.disabled ? "Saved" : "Save"; b.disabled = real.disabled; };
    b.addEventListener("click", () => real.click());
    new MutationObserver(sync).observe(real, { attributes: true });
    sync();
    bar.appendChild(b);
    document.body.appendChild(bar);
  }
})();

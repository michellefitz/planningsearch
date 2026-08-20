/**
 * The page a document link lands on while the document is still coming.
 *
 * A council document is fetched from their portal and, for the older scans,
 * decoded and re-assembled before a single byte can be sent — a second or
 * three in which the browser has nothing to paint and shows a blank white tab.
 * The tab icon spins, which nobody watches.
 *
 * So the link lands here first: a page that renders immediately and then
 * navigates itself to the document. The trick is that a browser keeps showing
 * the current page until the *next* one starts painting, so this spinner stays
 * up for exactly as long as the document takes, and the tab ends on the real
 * document URL — natively rendered, savable, printable, with none of the
 * nesting an <iframe> would have brought. `replace` rather than `assign`, so
 * Back returns to the application rather than to this.
 */
export function documentLoadingShell(href) {
  const url = href.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Opening the document…</title><style>
:root{color-scheme:light dark;--ink:#1a1d21;--ink-2:#5b6570;--paper:#fff;--line:#dcdee4;--action:#0b62d6}
@media (prefers-color-scheme:dark){:root{--ink:#e9edf2;--ink-2:#a3adb8;--paper:#14171a;--line:#2b3138;--action:#6ea8ff}}
html,body{height:100%}
body{margin:0;display:grid;place-content:center;justify-items:center;gap:1rem;
background:var(--paper);color:var(--ink);
font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:center;padding:2rem}
.s{width:2rem;height:2rem;border-radius:999px;border:2px solid var(--line);
border-top-color:var(--action);animation:sp .8s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.s{animation:none}}
p{margin:0;color:var(--ink-2)}
a{color:var(--action)}
</style></head><body>
<span class="s" aria-hidden="true"></span>
<p id="m" role="status">Fetching the document from the council…</p>
<noscript><p><a href="${url}">Open the document</a></p></noscript>
<script>
// The same escalation the application uses: a message that has visibly moved
// on is what separates slow from stopped.
var m=document.getElementById("m");
setTimeout(function(){m.textContent="Still fetching \u2014 the council's portal is slow to answer."},6000);
setTimeout(function(){m.textContent="Still going. Older files are scanned images and take a moment."},15000);
location.replace(${JSON.stringify(href)});
</script>
</body></html>`;
}

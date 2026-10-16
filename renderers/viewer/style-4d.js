// renderers/viewer/style-4d.js — the stylesheet of the time bar and the guide,
// which html.mjs appends to the shell styles only when the page carries one
// of them. Not a browser fragment (html.mjs imports it as a module). Every
// colour, size and duration is a --df-* token; the only motion here is a
// transition on opacity and stroke, switched off under prefers-reduced-motion.
// Nothing moves on its own: the playhead tween is written per frame by
// motion-2d.js / timebar.js and always ends.
export const TIME_CSS = `
.df-timebar{display:flex;flex-wrap:wrap;align-items:center;gap:var(--df-space-2);padding:var(--df-space-1) var(--df-space-4);background:var(--df-bg-chrome);border-bottom:1px solid var(--df-line);font-size:var(--df-text-sm)}
.df-timebar[hidden]{display:none}
.df-timebar .df-btn{min-inline-size:var(--df-tap-min)}
.df-tb-track{position:relative;flex:1 1 12rem;min-width:8rem;display:flex;align-items:center;min-height:var(--df-tap-min)}
.df-tb-range{width:100%;margin:0;accent-color:var(--df-active);cursor:pointer;background:transparent}
.df-tb-range:focus-visible{outline:none;box-shadow:var(--df-focus-ring);border-radius:var(--df-radius-sm)}
.df-tb-ticks{position:absolute;left:8px;right:8px;top:50%;height:0;pointer-events:none}
.df-tb-tick{position:absolute;top:6px;width:1px;height:6px;margin-left:-0.5px;background:var(--df-line-strong)}
.df-tb-tick--on{background:var(--df-active)}
.df-tb-label{font-family:var(--df-font-mono);font-size:var(--df-text-xs);color:var(--df-muted);white-space:nowrap}
.df-tb-now{font-family:var(--df-font-mono);font-size:var(--df-text-sm);color:var(--df-ink);min-width:10ch;text-align:right;white-space:nowrap}
.df-btn[data-df="t-play"][aria-pressed="true"],.df-btn[data-df="guide"][aria-pressed="true"]{background:var(--df-accent);color:var(--df-ink-invert);border-color:var(--df-accent)}
.df-steps{position:absolute;left:var(--df-space-4);bottom:var(--df-space-4);width:min(24rem,calc(100vw - 2 * var(--df-space-4)));background:var(--df-panel);border:1px solid var(--df-line-strong);border-radius:var(--df-radius-lg);box-shadow:var(--df-shadow-2);padding:var(--df-space-3) var(--df-space-4);z-index:var(--df-z-raised);font-size:var(--df-text-sm)}
.df-steps[hidden]{display:none}
.df-steps h2{font-family:var(--df-font-display);font-size:var(--df-text-md);margin:var(--df-space-1) 0}
.df-steps p{margin:0 0 var(--df-space-2);color:var(--df-muted)}
.df-steps p:empty{display:none}
.df-steps-nav{display:flex;gap:var(--df-space-2);justify-content:flex-end}
.df-steps-nav .df-btn[disabled]{opacity:0.45;cursor:default}
.df-scene .df-node .df-glyph,.df-scene .df-edge-group{transition:opacity var(--df-dur) var(--df-ease),stroke var(--df-dur) var(--df-ease)}
.df-scene .df-edge-group.df-taken .df-edge{stroke:var(--df-active)}
.df-scene .df-edge-group.df-step .df-edge{stroke:var(--df-accent-2)}
.df-scene .df-trace-head{fill:none;stroke:var(--df-trace);stroke-width:3.5px;stroke-linecap:round;pointer-events:none}
@media (prefers-reduced-motion:reduce){.df-scene .df-node .df-glyph,.df-scene .df-edge-group{transition:none}.df-scene .df-trace-head{display:none}}
@media print{.df-timebar,.df-steps,.df-scene .df-trace-head{display:none}}
@media (max-width:720px){.df-tb-label{display:none}.df-steps{left:var(--df-space-2);right:var(--df-space-2);width:auto;bottom:var(--df-space-2)}}
`;

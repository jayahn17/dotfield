// renderers/viewer/style.js — the shell stylesheet html.mjs inlines after the
// tokens. Not a browser fragment (html.mjs imports it as a module); every
// colour, size and motion value is a --df-* token, so a theme switch on
// <html data-theme> restyles the shell, the SVG and (through the same
// tokens) the 3D materials at once. No hex, no URLs, no fetch, and no CSS
// animation: a flow edge keeps its static dash, and motion belongs to the
// playhead (views.time), which lib/gates/render.mjs DF_RENDER_MOTION_* enforce.
export const SHELL_CSS = `
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:var(--df-bg);color:var(--df-ink);font-family:var(--df-font-text);font-size:var(--df-text-base);line-height:var(--df-leading);display:flex;flex-direction:column;min-height:100vh;overflow:hidden}
.df-header{display:flex;flex-wrap:wrap;gap:var(--df-space-2);align-items:center;padding:var(--df-space-2) var(--df-space-4);background:var(--df-bg-chrome);border-bottom:1px solid var(--df-line);min-height:var(--df-header-h)}
.df-header h1{font-family:var(--df-font-display);font-size:var(--df-text-md);font-weight:600;margin:0 var(--df-space-3) 0 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40vw}
.df-eyebrow{font-size:var(--df-eyebrow-size);letter-spacing:var(--df-eyebrow-tracking);text-transform:uppercase;color:var(--df-faint)}
.df-controls{display:flex;flex-wrap:wrap;gap:var(--df-space-2);align-items:center;margin-left:auto}
.df-btn,.df-select{min-height:var(--df-tap-min);min-inline-size:var(--df-tap-min);padding:0 var(--df-space-3);border:1px solid var(--df-line-strong);border-radius:var(--df-radius-md);background:var(--df-panel);color:var(--df-ink);font:inherit;font-size:var(--df-text-sm);cursor:pointer}
.df-btn[aria-pressed="true"],.df-tab[aria-selected="true"]{background:var(--df-accent);color:var(--df-ink-invert);border-color:var(--df-accent)}
.df-btn:hover{border-color:var(--df-accent)}
.df-tabs{display:inline-flex;border-radius:var(--df-radius-md);overflow:hidden}
.df-tabs .df-tab{border-radius:0}
.df-main{position:relative;flex:1;display:flex;min-height:0}
.df-view{position:absolute;inset:0;overflow:hidden}
.df-view[hidden]{display:none}
.df-stage{transform-origin:0 0;will-change:transform;width:100%;height:100%;display:flex;align-items:center;justify-content:center;touch-action:none;cursor:grab}
.df-stage:active{cursor:grabbing}
.df-stage svg{max-width:100%;max-height:100%;width:auto;height:auto;display:block;user-select:none}
.df-mount{position:absolute;inset:0}
.df-mount canvas{display:block;width:100%;height:100%}
.df-overlay{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);max-width:min(36rem,90vw);padding:var(--df-space-4) var(--df-space-5);background:var(--df-panel);border:1px solid var(--df-line-strong);border-radius:var(--df-radius-lg);box-shadow:var(--df-shadow-2);color:var(--df-ink);text-align:center;z-index:var(--df-z-overlay)}
.df-overlay[hidden]{display:none}
.df-overlay code{font-family:var(--df-font-mono);color:var(--df-muted)}
.df-card{position:absolute;right:var(--df-space-4);top:var(--df-space-4);width:min(22rem,calc(100vw - 2 * var(--df-space-4)));max-height:calc(100% - 2 * var(--df-space-4));overflow:auto;background:var(--df-panel);border:1px solid var(--df-line-strong);border-radius:var(--df-radius-lg);box-shadow:var(--df-shadow-2);padding:var(--df-space-4);z-index:var(--df-z-raised);font-size:var(--df-text-sm)}
.df-card[hidden]{display:none}
.df-card h2{font-family:var(--df-font-display);font-size:var(--df-text-md);margin:0 var(--df-space-6) var(--df-space-1) 0}
.df-card .df-close{position:absolute;right:var(--df-space-2);top:var(--df-space-2)}
.df-card dl{display:grid;grid-template-columns:auto 1fr;gap:var(--df-space-1) var(--df-space-3);margin:var(--df-space-2) 0}
.df-card dt{color:var(--df-faint)}
.df-card dd{margin:0;overflow-wrap:anywhere}
.df-card .df-fence{border-left:3px solid var(--df-foreign);padding-left:var(--df-space-2);color:var(--df-muted)}
.df-card .df-derived{border-left:3px solid var(--df-accent-2);padding-left:var(--df-space-2);color:var(--df-muted)}
.df-card .df-pins li{font-family:var(--df-font-mono);font-size:var(--df-text-xs);color:var(--df-muted)}
.df-card ul{margin:var(--df-space-1) 0;padding-left:var(--df-space-4)}
.df-help{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);background:var(--df-panel);border:1px solid var(--df-line-strong);border-radius:var(--df-radius-lg);box-shadow:var(--df-shadow-3);padding:var(--df-space-5);z-index:var(--df-z-modal);max-width:min(32rem,92vw)}
.df-help[hidden]{display:none}
.df-help table{border-collapse:collapse;font-size:var(--df-text-sm)}
.df-help td{padding:var(--df-space-1) var(--df-space-3)}
.df-help kbd{font-family:var(--df-font-mono);background:var(--df-panel-2);border:1px solid var(--df-line);border-radius:var(--df-radius-sm);padding:0 var(--df-space-1)}
.df-footer{display:flex;flex-wrap:wrap;gap:var(--df-space-3);padding:var(--df-space-2) var(--df-space-4);background:var(--df-bg-chrome);border-top:1px solid var(--df-line);font-size:var(--df-text-xs);color:var(--df-muted)}
.df-footer .df-self{color:var(--df-warn);font-weight:600}
.df-footer code{font-family:var(--df-font-mono)}
.df-legend[hidden]{display:none}
.df-edge-group.df-dim{opacity:0.15}
@media (max-width:720px){.df-header h1{max-width:100%}.df-card{left:var(--df-space-2);right:var(--df-space-2);top:auto;bottom:var(--df-space-2);width:auto;max-height:50%}}
`;

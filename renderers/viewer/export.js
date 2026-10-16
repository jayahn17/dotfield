// renderers/viewer/export.js — browser fragment (see state.js). One
// materialize(svg) helper feeds every export: it clones the live SVG,
// inlines the computed fills, strokes and fonts of every element (so the
// active theme survives outside the page, and an edge's dash window with
// it), drops hidden elements and any in-flight trace head, inlines
// the theme's --df-* tokens as a <style> and serialises with XMLSerializer
// (which writes the SVG namespace itself). out.svg, PNG and the 1200x630
// share card all go through it; nothing is fetched and nothing is stored.
DF.PAINT_PROPS = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linejoin', 'stroke-linecap', 'opacity', 'font-family', 'font-size', 'font-weight', 'paint-order', 'text-anchor'];

DF.tokenValues = function tokenValues() {
  const cs = getComputedStyle(document.documentElement);
  const out = {};
  for (const name of DF.config.token_names || []) {
    const v = cs.getPropertyValue(name).trim();
    if (v) out[name] = v;
  }
  return out;
};

/** Clone the SVG with computed styles inlined; returns the serialised string. */
DF.materialize = function materialize(svgEl, opts) {
  const o = opts || {};
  const source = svgEl || DF.q('svg.df-scene');
  if (!source) return '';
  const clone = source.cloneNode(true);
  const from = source.querySelectorAll('*');
  const to = clone.querySelectorAll('*');
  const drop = [];
  for (let i = 0; i < from.length; i += 1) {
    const cs = getComputedStyle(from[i]);
    // A trace head is a tween artifact, never part of a still (print hides it too).
    if (cs.display === 'none' || from[i].classList.contains('df-trace-head')) { drop.push(to[i]); continue; }
    const style = [];
    for (const prop of DF.PAINT_PROPS) {
      const v = cs.getPropertyValue(prop);
      if (v) style.push(`${prop}:${v}`);
    }
    to[i].setAttribute('style', style.join(';'));
    to[i].removeAttribute('tabindex');
  }
  for (const n of drop) if (n.parentNode) n.parentNode.removeChild(n);
  const tokens = DF.tokenValues();
  const styleEl = clone.querySelector('style[data-df="tokens"]');
  const css = `:root,svg{${Object.entries(tokens).map(([k, v]) => `${k}:${v}`).join(';')}}`;
  if (styleEl) styleEl.textContent = css;
  const bg = source.ownerDocument.createElementNS(source.namespaceURI, 'rect');
  const vb = (source.getAttribute('viewBox') || '0 0 1600 1000').split(/\s+/).map(Number);
  bg.setAttribute('x', vb[0]); bg.setAttribute('y', vb[1]); bg.setAttribute('width', vb[2]); bg.setAttribute('height', vb[3]);
  bg.setAttribute('fill', tokens['--df-bg'] || 'transparent');
  bg.setAttribute('class', 'df-export-bg');
  clone.insertBefore(bg, clone.firstChild.nextSibling);
  clone.setAttribute('width', String(o.width || vb[2]));
  clone.setAttribute('height', String(o.height || vb[3]));
  clone.setAttribute('data-exported-theme', DF.state.theme);
  return new XMLSerializer().serializeToString(clone);
};

DF.download = function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = DF.el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

DF.exportName = function exportName(suffix) {
  return `${DF.config.scene_id || 'scene'}${suffix}`;
};

DF.exportSvg = function exportSvg() {
  const svg = DF.materialize();
  if (svg) DF.download(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), DF.exportName('.svg'));
};

/** Draw the materialized SVG into a canvas and resolve with the canvas. */
DF.rasterize = function rasterize(svg, width, height, draw) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      draw(ctx, img, canvas);
      URL.revokeObjectURL(url);
      resolve(canvas);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('svg could not be rasterized')); };
    img.src = url;
  });
};

DF.exportPng = async function exportPng(scale) {
  const source = DF.q('svg.df-scene');
  if (!source) return;
  const vb = (source.getAttribute('viewBox') || '0 0 1600 1000').split(/\s+/).map(Number);
  const k = scale || 2;
  const svg = DF.materialize(source, { width: vb[2] * k, height: vb[3] * k });
  const canvas = await DF.rasterize(svg, vb[2] * k, vb[3] * k, (ctx, img, c) => ctx.drawImage(img, 0, 0, c.width, c.height));
  canvas.toBlob((blob) => blob && DF.download(blob, DF.exportName('.png')), 'image/png');
};

/** A 1200x630 share card: title, one line of context, the scene fitted beneath. */
DF.exportCard = async function exportCard() {
  const source = DF.q('svg.df-scene');
  if (!source) return;
  const tokens = DF.tokenValues();
  const vb = (source.getAttribute('viewBox') || '0 0 1600 1000').split(/\s+/).map(Number);
  const W = 1200; const H = 630; const top = 150; const pad = 48;
  const fit = Math.min((W - 2 * pad) / vb[2], (H - top - pad) / vb[3]);
  const svg = DF.materialize(source, { width: vb[2] * fit * 2, height: vb[3] * fit * 2 });
  const canvas = await DF.rasterize(svg, W * 2, H * 2, (ctx, img) => {
    ctx.scale(2, 2);
    ctx.fillStyle = tokens['--df-panel'] || tokens['--df-bg'] || 'transparent';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = tokens['--df-faint'] || tokens['--df-ink'];
    ctx.font = `600 11px ${tokens['--df-font-display'] || 'sans-serif'}`;
    ctx.fillText((DF.config.center_name || 'DOTFIELD').toUpperCase(), pad, pad + 10);
    ctx.fillStyle = tokens['--df-ink'];
    ctx.font = `600 34px ${tokens['--df-font-display'] || 'sans-serif'}`;
    ctx.fillText(String(DF.scene.meta && DF.scene.meta.title || DF.config.scene_id), pad, pad + 54);
    ctx.fillStyle = tokens['--df-muted'] || tokens['--df-ink'];
    ctx.font = `15px ${tokens['--df-font-text'] || 'sans-serif'}`;
    ctx.fillText(`${DF.index.nodes.length} nodes · ${DF.index.edges.length} edges · ${DF.scene.kind} · ${DF.config.maturity}`, pad, pad + 84);
    ctx.drawImage(img, (W - vb[2] * fit) / 2, top, vb[2] * fit, vb[3] * fit);
  });
  canvas.toBlob((blob) => blob && DF.download(blob, DF.exportName('-card.png')), 'image/png');
};

// renderers/viewer/keys.js — browser fragment (see state.js). The keyboard:
//   ?  help      R  cycle reach      L  cycle lens     M  toggle map key (legend)
//   F  focus the node under keyboard focus / clear     S  save SVG    T  cycle theme
//   E  toggle evidence card    + - 0  zoom in / out / fit    2 3 V  views
//   . ,  next / previous stop on the time bar    [ ]  start / end of the window
//   P  play / pause (finite)   G  open / close the guide    N B  next / back step
//   Enter / Space on a node focuses it (a native button); Escape clears.
// Keys never fire while typing in a control; the time and guide keys do
// nothing (and do not swallow the key) when the scene has no time bar or steps.
// One key table for the whole viewer: the help dialog lists exactly these rows.
DF.HELP = [
  ['?', 'this help'], ['R', 'cycle reach: none, in, out, both'], ['L', 'cycle lens'], ['M', 'toggle map key'],
  ['F', 'focus the highlighted node, the scene\'s entry node, or clear focus'], ['S', 'save SVG'], ['T', 'cycle theme'], ['E', 'toggle evidence card'],
  ['+ / −', 'zoom in / out'], ['0', 'fit the scene to the view'], ['2 / 3 / V', '2D / 3D / VR view'],
  ['. / ,', 'next / previous stop on the time bar'], ['[ / ]', 'jump to the start / end of the time window'],
  ['P', 'play / pause: one finite pass to the end, never a loop'], ['G', 'open / close the guide (steps)'], ['N / B', 'next / back step of the guide'],
  ['Esc', 'close help, guide and card, clear focus'],
];

DF.isTyping = function isTyping(target) {
  const tag = target && target.tagName ? target.tagName.toLowerCase() : '';
  return tag === 'input' || tag === 'select' || tag === 'textarea' || (target && target.isContentEditable);
};

DF.nodeIdOf = function nodeIdOf(target) {
  const g = target && target.closest ? target.closest('[data-node-id]') : null;
  return g ? g.getAttribute('data-node-id') : null;
};

DF.toggleFocus = function toggleFocus(id) {
  DF.setState({ focus: DF.state.focus === id ? null : id });
};

DF.onKey = function onKey(ev) {
  if (ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.key === 'Escape') {
    const help = DF.q('[data-df="help"]');
    if (help && !help.hidden) { help.hidden = true; return; }
    if (DF.state.step) { DF.goStep(null); return; }
    if (DF.state.focus) DF.setState({ focus: null }); else DF.hideCard();
    return;
  }
  if (DF.isTyping(ev.target)) return;
  const id = DF.nodeIdOf(ev.target);
  if ((ev.key === 'Enter' || ev.key === ' ') && id) { ev.preventDefault(); DF.toggleFocus(id); return; }
  const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
  switch (k) {
    case '?': DF.toggleHelp(); break;
    case 'r': DF.setState({ reach: DF.cycle(DF.REACHES, DF.state.reach) }); break;
    case 'l': DF.cycleLens(); break;
    case 'm': DF.toggleLegend(); break;
    case 'f': if (id) DF.toggleFocus(id); else DF.setState({ focus: DF.state.focus ? null : DF.entryFocus() }); break;
    case 's': DF.exportSvg(); break;
    case 't': DF.setState({ theme: DF.cycle(DF.config.themes, DF.state.theme) }); break;
    case 'e': DF.toggleCard(); break;
    case '+': case '=': DF.zoomBy(1.25); break;
    case '-': case '_': DF.zoomBy(0.8); break;
    case '0': DF.zoomReset(); break;
    case '2': DF.setState({ view: '2d' }); break;
    case '3': DF.setState({ view: '3d' }); break;
    case 'v': DF.setState({ view: 'vr' }); break;
    case '.': if (!DF.stepTime(1)) return; break;
    case ',': if (!DF.stepTime(-1)) return; break;
    case '[': if (!DF.jumpTime('start')) return; break;
    case ']': if (!DF.jumpTime('end')) return; break;
    case 'p': if (!DF.togglePlay()) return; break;
    case 'g': if (!DF.toggleGuide()) return; break;
    case 'n': if (!DF.nextStep(1)) return; break;
    case 'b': if (!DF.nextStep(-1)) return; break;
    default: return;
  }
  ev.preventDefault();
};

DF.mountHelp = function mountHelp() {
  const help = DF.q('[data-df="help"]');
  if (!help) return;
  const rows = DF.HELP.map(([key, what]) => DF.el('tr', {}, [DF.el('td', {}, DF.el('kbd', { text: key })), DF.el('td', { text: what })]));
  help.replaceChildren(
    DF.el('div', { class: 'df-eyebrow', text: 'Keyboard' }),
    DF.el('table', {}, DF.el('tbody', {}, rows)),
    DF.el('p', { text: 'Focus, reach, lenses and steps reuse authored nodes and edges only; the viewer never invents topology. Every frame of the time bar is a still at t.' }),
    DF.el('button', { class: 'df-btn', type: 'button', 'data-df': 'help-close', text: 'Close' }),
  );
  DF.q('[data-df="help-close"]', help).addEventListener('click', () => { help.hidden = true; });
};

DF.toggleHelp = function toggleHelp() {
  const help = DF.q('[data-df="help"]');
  if (help) help.hidden = !help.hidden;
};

DF.toggleLegend = function toggleLegend() {
  const legend = DF.q('.df-legend');
  if (legend) legend.classList.toggle('df-hidden');
};

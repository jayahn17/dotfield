// renderers/viewer/lens.js — browser fragment (see state.js). Lenses are the
// authored views.interactive.lenses[]; a node matches a lens when every
// listed selector admits it, and a selector admits a node that carries at
// least one of its values. Selectors reuse authored ids, tags, kinds, rooms,
// groups, owners and status only.
DF.lenses = function lenses() {
  const it = (DF.scene.views && DF.scene.views.interactive) || {};
  return Array.isArray(it.lenses) ? it.lenses : [];
};

DF.lensById = function lensById(id) {
  return DF.lenses().find((l) => l.id === id) || null;
};

DF.lensMatches = function lensMatches(node, lens) {
  const m = lens && lens.match && typeof lens.match === 'object' ? lens.match : {};
  const has = (list, value) => !Array.isArray(list) || list.length === 0 || list.includes(value);
  if (!has(m.owner, node.provenance && node.provenance.owner_person_id)) return false;
  if (!has(m.rooms, node.room)) return false;
  if (!has(m.kinds, node.kind)) return false;
  if (!has(m.status, node.status)) return false;
  if (Array.isArray(m.groups) && m.groups.length) {
    const g = DF.index.groupOf.get(node.id);
    if (!g || !m.groups.includes(g)) return false;
  }
  if (Array.isArray(m.tags) && m.tags.length) {
    const tags = Array.isArray(node.tags) ? node.tags : [];
    if (!tags.some((t) => m.tags.includes(t))) return false;
  }
  return true;
};

/** The set of visible node ids under a lens id, or null when no lens is active (everything visible). */
DF.lensVisible = function lensVisible(id) {
  const lens = id ? DF.lensById(id) : null;
  if (!lens) return null;
  const set = new Set();
  for (const n of DF.index.nodes) if (DF.lensMatches(n, lens)) set.add(n.id);
  return set;
};

DF.cycleLens = function cycleLens() {
  const ids = [null, ...DF.lenses().map((l) => l.id)];
  DF.setState({ lens: DF.cycle(ids, DF.state.lens) });
};

/** Fill the lens <select> from the authored lenses; the empty option means "all nodes". */
DF.mountLensSelect = function mountLensSelect() {
  const sel = DF.q('[data-df="lens"]');
  if (!sel) return;
  sel.replaceChildren(DF.el('option', { value: '', text: 'All nodes' }));
  for (const l of DF.lenses()) sel.append(DF.el('option', { value: l.id, text: l.label || l.id }));
  sel.addEventListener('change', () => DF.setState({ lens: sel.value || null }));
};

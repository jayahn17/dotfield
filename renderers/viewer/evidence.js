// renderers/viewer/evidence.js — browser fragment (see state.js). The node
// card: label, kind and status, the three dates, the provenance pins
// (SRC n -> evidence ref and digest), the audience, and for a foreign node
// "shared by <person> under <rule_ref> on <date>, receipt <digest>", for a
// derived node "derived from <person> under <rule_ref>". Every value is
// written with textContent: imported projection content is fenced data,
// never markup and never instructions. Refs are shown as text, not links,
// so a shared render makes no request on a click.
DF.shortDigest = function shortDigest(d) {
  const hex = String(d || '').replace(/^[a-z0-9-]+:/, '');
  return hex ? hex.slice(0, 8) : '';
};

DF.cardRows = function cardRows(node) {
  const rows = [];
  const p = node.provenance || {};
  const put = (k, v) => { if (v !== undefined && v !== null && v !== '') rows.push([k, String(v)]); };
  put('kind', node.kind);
  put('status', node.status === 'proposal' ? 'proposal (awaiting owner approval)' : node.status);
  if (node.room) put('room', node.record_id ? `${node.room} / ${node.record_id}` : node.room);
  const g = DF.index.groupOf.get(node.id);
  if (g) { const grp = DF.index.groups.find((x) => x.id === g); put('group', grp ? grp.label : g); }
  put('owner', p.owner_person_id);
  if (p.source) put('source', `${p.source.kind}: ${p.source.ref}`);
  put('captured', p.captured_on);
  put('happened', p.happened_on);
  put('remembered', p.remembered_on);
  put('released', p.released_on);
  if (node.audience) put('privacy', node.audience.privacy_level + (Array.isArray(node.audience.share_rule_ids) && node.audience.share_rule_ids.length ? ` · rules ${node.audience.share_rule_ids.join(', ')}` : ''));
  if (Array.isArray(node.tags) && node.tags.length) put('tags', node.tags.join(', '));
  put('weight', typeof node.weight === 'number' ? node.weight : undefined);
  return rows;
};

DF.cardFences = function cardFences(node) {
  const out = [];
  const b = node.boundary; const p = node.provenance || {};
  if (b && typeof b === 'object') {
    out.push(DF.el('p', { class: 'df-fence' }, `shared by ${b.shared_by} under ${b.rule_ref} on ${b.released_on}, receipt ${DF.shortDigest(b.digest)}${b.expires_on ? `, expires ${b.expires_on}` : ''}`));
  } else if (p.imported_via_rule_ref) {
    out.push(DF.el('p', { class: 'df-fence' }, `shared by ${p.owner_person_id} under ${p.imported_via_rule_ref}${p.released_on ? ` on ${p.released_on}` : ''}`));
  }
  for (const d of Array.isArray(p.derived_from) ? p.derived_from : []) {
    out.push(DF.el('p', { class: 'df-derived' }, `derived from ${d.person_id} under ${d.rule_ref}`));
  }
  return out;
};

DF.cardPins = function cardPins(node) {
  const ids = Array.isArray(node.evidence_ids) ? node.evidence_ids : [];
  if (!ids.length) return null;
  const items = ids.map((id) => {
    const ev = DF.index.evidence.get(id);
    const label = ev ? ev.label : id;
    const detail = ev ? ` — ${ev.kind}: ${ev.ref} (${DF.shortDigest(ev.digest)})` : ' — evidence not in scene';
    return DF.el('li', { 'data-evidence-id': id }, `${label}${detail}`);
  });
  return DF.el('div', {}, [DF.el('div', { class: 'df-eyebrow', text: 'Provenance' }), DF.el('ul', { class: 'df-pins' }, items)]);
};

DF.cardFields = function cardFields(node) {
  const f = node.fields && typeof node.fields === 'object' && !Array.isArray(node.fields) ? node.fields : null;
  if (!f || !Object.keys(f).length) return null;
  const dl = DF.el('dl', {});
  for (const [k, v] of Object.entries(f)) {
    dl.append(DF.el('dt', { text: k }));
    dl.append(DF.el('dd', { text: Array.isArray(v) ? v.join(', ') : (v === null ? '—' : String(v)) }));
  }
  return DF.el('div', {}, [DF.el('div', { class: 'df-eyebrow', text: 'Public fields' }), dl]);
};

DF.showCard = function showCard(id) {
  const card = DF.q('[data-df="card"]');
  const node = DF.index.byId.get(id);
  if (!card || !node) return;
  const dl = DF.el('dl', {});
  for (const [k, v] of DF.cardRows(node)) { dl.append(DF.el('dt', { text: k })); dl.append(DF.el('dd', { text: v })); }
  // replaceChildren() turns a null argument into the text "null", so absent parts are filtered out first.
  card.replaceChildren(...[
    DF.el('button', { class: 'df-btn df-close', type: 'button', 'aria-label': 'Close card', 'data-df': 'card-close', text: '×' }),
    DF.el('div', { class: 'df-eyebrow', text: node.status === 'proposal' ? 'proposal' : (node.kind === 'boundary' ? 'boundary' : 'node') }),
    DF.el('h2', { text: node.label }),
    node.sublabel ? DF.el('p', { text: node.sublabel }) : null,
    ...DF.cardFences(node),
    dl,
    DF.cardPins(node),
    DF.cardFields(node),
  ].filter((part) => part !== null && part !== undefined));
  card.hidden = false;
  DF.q('[data-df="card-close"]', card).addEventListener('click', () => DF.setState({ focus: null }));
};

DF.hideCard = function hideCard() {
  const card = DF.q('[data-df="card"]');
  if (card) { card.hidden = true; card.replaceChildren(); }
};

DF.toggleCard = function toggleCard() {
  const card = DF.q('[data-df="card"]');
  if (!card) return;
  if (!card.hidden) card.hidden = true;
  else if (DF.state.focus) DF.showCard(DF.state.focus);
};

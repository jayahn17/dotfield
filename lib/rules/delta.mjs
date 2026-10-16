// Rule family "delta": dotfield compare (lib/commands/compare.mjs) and the
// pure diff it runs (lib/delta.mjs diffScenes). Gate id: "delta".
// A compare pairs two scenes of one kind by id, so the codes guard exactly
// what makes a before/after picture honest: one kind on both sides, ids that
// survive between versions, two inputs that each pass their own gates, and a
// say-so whenever a pairing or a layout was inferred rather than read.
export const family = 'delta';
export const gate = 'delta';
export const rules = {
  DF_DELTA_KIND_MISMATCH: { gate, blocking: true,
    message: 'The two scenes are of different kinds, so they cannot be compared node for node.',
    repair: 'Compare two scenes of one kind (both workflow, both graph, both sequence ...); to compare across kinds, re-author or re-import one of them as the other kind first.' },
  DF_DELTA_NO_STABLE_IDS: { gate, blocking: true,
    message: 'More than 80% of the nodes of the smaller scene have no node with the same id in the other, so a delta would be noise.',
    repair: 'Keep node ids stable between the two versions (importers slug the source id, sketches use the node name); rename the ids back, or compare two exports of one source.' },
  DF_DELTA_INPUT_BLOCKED: { gate, blocking: true,
    message: 'An input could not be loaded or failed its own gates, so nothing was compared.',
    repair: 'Run dotfield validate on the named input, fix its blocking checks by their repair sentences, and compare again.' },
  DF_DELTA_EDGE_PAIRED_BY_ENDPOINTS: { gate, blocking: false,
    message: 'An edge without an id was paired by (from, to, kind).',
    repair: 'Give the edge one id in both scenes so it pairs by id; parallel id-less edges of one kind pair in scene order, which can swap their labels.' },
  DF_DELTA_LAID_OUT_COLD: { gate, blocking: false,
    message: 'An input carried no committed layout, so compare laid it out cold with one seed before diffing.',
    repair: 'Compare scenes that carry the positions that were drawn (the scene.json dotfield render writes beside out.html); after a cold layout a node can read as moved when only its neighbours changed.' },
};

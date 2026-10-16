// Rule family "privacy": lib/gates/privacy.mjs (HMAC stamp, viewer
// exclusion, foreign bodies, absolute paths, taint). Gate id: "privacy".
// ABSOLUTE_PATH_RE is the one absolute-home-path regex, shared with the
// structure scan; this file is exempt from that scan because it holds it.
export const family = 'privacy';
export const gate = 'privacy';
export const ABSOLUTE_PATH_RE = /^(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\|\\\\)/;
export const rules = {
  DF_PRIVACY_VIEWER_EXCLUDED: { gate, blocking: true,
    message: 'The scene carries a node the viewer has no grant to see.',
    repair: 'Render through lib/project.mjs with --for <viewer>; the projector drops nodes outside the viewer rules.' },
  DF_PRIVACY_FOREIGN_BODY_WITHOUT_RULE: { gate, blocking: true,
    message: 'A foreign-owned node carries fields but no imported_via_rule_ref.',
    repair: 'Import the projection with dotfield import projection so every foreign node records its rule.' },
  DF_PRIVACY_FIELD_NOT_PUBLIC: { gate, blocking: true,
    message: 'node.fields carries a key that is not in the room public_fields.',
    repair: 'Remove the field from the node or add it to record.public_fields in room.json.' },
  DF_PRIVACY_ABSOLUTE_PATH: { gate, blocking: true,
    message: 'A value starts with an absolute home-directory path.',
    repair: 'Replace the path with a repo-relative ref or a digest; paths on the owner disk never leave the machine.' },
  DF_PRIVACY_DERIVED_UNTAINTED: { gate, blocking: true,
    message: 'A node derived from foreign evidence lacks provenance.derived_from.',
    repair: 'Let lib/project.mjs compute the taint; derived_from lists {person_id, rule_ref, key_id} for every origin.' },
  DF_PRIVACY_HANDLE_PRESENT: { gate, blocking: true,
    message: 'A person handle appears in a scene or export.',
    repair: 'Handles are owner-only HMACs and are never projected or exported; remove the value.' },
  DF_PRIVACY_KEY_MATERIAL: { gate, blocking: true,
    message: 'A private key, session key, owner token or salt appears in a document.',
    repair: 'Remove the value and rotate the key; data/keys/ contents never enter scenes, receipts or renders.' },
};

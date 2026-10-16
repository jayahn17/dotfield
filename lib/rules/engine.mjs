// Rule family "engine": dotfield doctor and the manifests. Gate id: "engine".
export const family = 'engine';
export const gate = 'engine';
export const rules = {
  DF_ENGINE_MODIFIED: { gate, blocking: false,
    message: 'A non-center file differs from engine.manifest.json (an unintended local edit, not tamper evidence).',
    repair: 'Revert the file, or if the change is intended upstream, run npm run manifest in the same commit.' },
  DF_ENGINE_MANIFEST_MISSING: { gate, blocking: false,
    message: 'engine.manifest.json is absent, so local edits cannot be detected.',
    repair: 'Run npm run manifest.' },
  DF_ENGINE_RELEASE_MISSING: { gate, blocking: false,
    message: 'skill-release.json is absent, so receipts cannot report match_release.',
    repair: 'Run npm run manifest.' },
  DF_ENGINE_NODE_VERSION: { gate, blocking: true,
    message: 'The running Node is older than min_node (22.13).',
    repair: 'Install Node 22.13 or newer; the sandbox needs node --permission.' },
  DF_ENGINE_VENDOR_MISSING: { gate, blocking: false,
    message: 'vendor/three/ is absent; 3D and VR renders cannot embed three.js.',
    repair: 'Run dotfield doctor --fetch-vendor or node scripts/fetch-vendor.mjs.' },
  DF_ENGINE_VENDOR_HASH_MISMATCH: { gate, blocking: true,
    message: 'A vendored three.js file does not match vendor/manifest.json.',
    repair: 'Delete vendor/three/ and fetch again; never edit vendored files.' },
  DF_ENGINE_KEYS_MISSING: { gate, blocking: false,
    message: 'data/keys/ lacks session.key, owner.token, handle.salt or the self ed25519 key.',
    repair: 'Run dotfield init (keys are created once and never printed).' },
  DF_ENGINE_MIGRATION_PENDING: { gate, blocking: false,
    message: 'A migration under migrations/ has not been applied to center/.',
    repair: 'Run dotfield migrate --dry-run, then dotfield migrate.' },
};

// Rule family "pack": packs/<id>/ and init --pack. Gate id: "pack".
export const family = 'pack';
export const gate = 'pack';
export const rules = {
  DF_PACK_DRAFT: { gate, blocking: true,
    message: 'The pack lives under packs/draft/ and is refused by init.',
    repair: 'Choose starter, robotics-lab or research-lab; a draft pack leaves draft only with the review named in its README.' },
  DF_PACK_NOT_FOUND: { gate, blocking: true,
    message: 'No pack with that id exists under packs/.',
    repair: 'Use one of the shipped pack ids; packs from URLs are refused.' },
  DF_PACK_URL_REFUSED: { gate, blocking: true,
    message: 'A pack was requested from a URL.',
    repair: 'Copy the pack into packs/<id>/ as JSON and validate it; nothing is fetched.' },
  DF_PACK_CODE_IN_PACK: { gate, blocking: true,
    message: 'A pack contains a .mjs or .js file.',
    repair: 'Packs carry no code (JSON, one README per pack and example CSV only); customer code lives in center/rooms/<id>/ and runs in the sandbox.' },
  DF_PACK_ROOM_MISSING: { gate, blocking: true,
    message: 'pack.json rooms[] names a room folder that is not in the pack.',
    repair: 'Add packs/<id>/<room>/ with its four files or remove the entry.' },
  DF_PACK_CONDUCTOR_IN_PACK: { gate, blocking: true,
    message: 'A pack roster declares a conductor.',
    repair: 'Remove it; the conductor is defined once in center.config.json.' },
  DF_PACK_VERSION_DRIFT: { gate, blocking: false,
    message: 'An installed pack version differs from the shipped pack.',
    repair: 'Run dotfield migrate --dry-run to see the patch, then migrate.' },
};

// Rule family "theme": lib/theme.mjs (brand.json -> tokens). Gate id: "theme".
export const family = 'theme';
export const gate = 'theme';
export const rules = {
  DF_THEME_CONTRAST: { gate, blocking: true,
    message: 'A brand colour pair fails the WCAG contrast ledger.',
    repair: 'Use the nearest passing value printed in the message, or change the paired surface/ink colour in center/brand.json.' },
  DF_THEME_HEX_INVALID: { gate, blocking: true,
    message: 'A brand colour is not a 6-digit hex value.',
    repair: 'Write accent, surface and ink as six hex digits in center/brand.json (the one place a hex is allowed).' },
  DF_THEME_FONT_UNKNOWN: { gate, blocking: true,
    message: 'A font stack is not in the enum of local stacks.',
    repair: 'Pick a stack listed in schemas/brand.schema.json; remote fonts are never loaded.' },
  DF_THEME_FONT_FILE_MISSING: { gate, blocking: true,
    message: 'brand.json files[] names a woff2 that is not under center/brand/.',
    repair: 'Copy the file under center/brand/ or remove the entry.' },
  DF_THEME_FONT_FILE_TOO_LARGE: { gate, blocking: true,
    message: 'Inlined brand fonts push the render past its size budget.',
    repair: 'Subset the woff2 or drop a weight; inlined fonts count toward DF_RENDER_SIZE_BUDGET.' },
  DF_THEME_PRESET_UNKNOWN: { gate, blocking: true,
    message: 'room_preset is not paper, studio, field or story.',
    repair: 'Set room_preset to one of the four data-room themes.' },
  DF_THEME_BASE_MISSING: { gate, blocking: true,
    message: 'The base renderers/tokens.css is absent or unreadable, so no brand tokens can be derived.',
    repair: 'Restore renderers/tokens.css from the release (dotfield doctor reports DF_ENGINE_MODIFIED) and rerun dotfield theme.' },
  DF_THEME_TOKEN_UNKNOWN: { gate, blocking: true,
    message: 'brand.json refers to a token that tokens.css does not define.',
    repair: 'Use only --df-* tokens listed in renderers/tokens.css.' },
};

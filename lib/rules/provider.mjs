// Rule family "provider": lib/providers/*.mjs. Gate id: "provider".
// Every blocking failure here exits 5.
export const family = 'provider';
export const gate = 'provider';
export const rules = {
  DF_PROVIDER_UNAVAILABLE: { gate, blocking: true, exit: 5,
    message: 'The configured provider could not be reached or is not installed.',
    repair: 'Run with --provider dry to test the loop, or configure provider.adapter and its credentials in center.config.json.' },
  DF_PROVIDER_NESTED_REFUSED: { gate, blocking: true, exit: 5,
    message: 'The claude-cli provider refuses to start inside a Claude Code session.',
    repair: 'Run from a plain terminal, use --provider dry, or set provider.allow_nested: true knowingly.' },
  DF_PROVIDER_RESPONSE_INVALID: { gate, blocking: true, exit: 5,
    message: 'The provider returned something that is not {text, tokens_used, model}.',
    repair: 'Check the adapter output format; the loop never parses free text as JSON.' },
  DF_PROVIDER_TIMEOUT: { gate, blocking: true, exit: 5,
    message: 'The provider did not answer within the run timeout.',
    repair: 'Retry, raise provider.timeout_ms, or lower the budget.' },
  DF_PROVIDER_UNKNOWN_ADAPTER: { gate, blocking: true, exit: 5,
    message: 'provider.adapter is not dry, claude-cli, anthropic or relay.',
    repair: 'Set provider.adapter to one of the shipped adapters in center.config.json.' },
};

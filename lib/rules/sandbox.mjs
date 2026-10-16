// Rule family "sandbox": lib/sandbox.mjs, the only spawner of customer
// modules. Gate id: "sandbox".
export const family = 'sandbox';
export const gate = 'sandbox';
export const rules = {
  DF_SANDBOX_WRITE_DENIED: { gate, blocking: true,
    message: 'A customer module tried to write outside .dotfield/tmp/.',
    repair: 'Return records over stdout; actions.mjs and importers cannot reach a store.' },
  DF_SANDBOX_READ_DENIED: { gate, blocking: true,
    message: 'A customer module tried to read outside its allowed directories (its own room folder and the engine lib/, schemas/ and renderers/); data/ and data/keys/ are never readable from the sandbox.',
    repair: 'Read only inputs passed over stdin or files in the room folder; a test that needs a record gets it from examples.json, never from the store or the keys.' },
  DF_SANDBOX_TIMEOUT: { gate, blocking: true,
    message: 'The customer module did not finish within the sandbox timeout.',
    repair: 'Make the module return promptly; it receives records over stdin and answers once over stdout.' },
  DF_SANDBOX_EXIT_NONZERO: { gate, blocking: true,
    message: 'The customer module exited with a non-zero code.',
    repair: 'Read its stderr in the receipt and fix the module; a failing test.mjs keeps the room below tested.' },
  DF_SANDBOX_OUTPUT_INVALID: { gate, blocking: true,
    message: 'The customer module wrote something other than one JSON document to stdout.',
    repair: 'Print exactly one JSON value; log to stderr instead.' },
  DF_SANDBOX_EXPORT_MISSING: { gate, blocking: true,
    message: 'The customer module has no export with the requested name.',
    repair: 'Export the action as export const <name> = (records, input) => records[].' },
  DF_SANDBOX_NODE_PERMISSION_UNSUPPORTED: { gate, blocking: true,
    message: 'This Node cannot run with --permission, so customer code cannot be sandboxed.',
    repair: 'Install Node 22.13 or newer.' },
  DF_SANDBOX_SPAWN_FAILED: { gate, blocking: true, exit: 4,
    message: 'The sandbox child process could not be started.',
    repair: 'Check that node is on PATH and .dotfield/tmp/ is writable.' },
};

// Rule family "approve": lib/commands/approve.mjs, the only state-changing
// verb. Gate id: "approve". Every blocking failure here exits 3.
export const family = 'approve';
export const gate = 'approve';
export const rules = {
  DF_APPROVE_NOT_OWNER: { gate, blocking: true, exit: 3,
    message: 'approve was invoked from an agent session or without a TTY and without the owner token file.',
    repair: 'Run dotfield approve from your own terminal or the inbox page; an agent cannot close its own loop.' },
  DF_APPROVE_TOKEN_INVALID: { gate, blocking: true, exit: 3,
    message: 'The --token-file content does not match data/keys/owner.token.',
    repair: 'Pass the token file written by dotfield init or serve; never paste the token on the command line.' },
  DF_APPROVE_TOKEN_FILE_MODE: { gate, blocking: true, exit: 3,
    message: 'The owner token file is readable by others (mode is not 0600).',
    repair: 'Run chmod 600 data/keys/owner.token, or regenerate it with dotfield serve.' },
  DF_APPROVE_TARGET_UNKNOWN: { gate, blocking: true, exit: 3,
    message: 'The id matches no proposal, run or share rule.',
    repair: 'Use an id listed by GET /api/proposals or the inbox page.' },
};

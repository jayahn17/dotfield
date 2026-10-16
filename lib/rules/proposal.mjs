// Rule family "proposal": lib/proposals.mjs (propose, summarize, decide).
// Gate id: "proposal".
export const family = 'proposal';
export const gate = 'proposal';
export const rules = {
  DF_PROPOSAL_ALREADY_DECIDED: { gate, blocking: true, exit: 3,
    message: 'The proposal already carries a different decision; nothing changed.',
    repair: 'Create a new proposal if the content must change; a decision is final and approve is idempotent only for the same decision.' },
  DF_PROPOSAL_NOT_FOUND: { gate, blocking: true,
    message: 'No proposal, run or rule has that id.',
    repair: 'List pending items with dotfield approve --list or GET /api/proposals and use an id from the list.' },
  DF_PROPOSAL_NOT_AWAITING: { gate, blocking: true, exit: 3,
    message: 'The item is not in awaiting_owner, so it cannot be decided.',
    repair: 'Only awaiting_owner items take a decision; a draft must be submitted first.' },
  DF_PROPOSAL_SUMMARY_DIGEST_MISMATCH: { gate, blocking: true, exit: 3,
    message: 'The summary the owner reviewed differs from the proposal summary now.',
    repair: 'Re-open the proposal in the inbox and review the current summary before deciding.' },
  DF_PROPOSAL_INVALID_DECISION: { gate, blocking: true,
    message: 'The decision is not one of approve, edit or reject.',
    repair: 'Pass --decision approve|edit|reject; edit also needs --edit <file>.' },
  DF_PROPOSAL_EDIT_FILE_INVALID: { gate, blocking: true,
    message: 'The --edit file does not hold records that validate for the room.',
    repair: 'Fix the edited records with the DF_RECORD_* findings beside this one.' },
  DF_PROPOSAL_MODE_REFUSED: { gate, blocking: true, exit: 3,
    message: 'The room mode refuses proposals (read_only or blocked).',
    repair: 'Set room.json mode to proposal_only if the room should accept proposals.' },
  DF_PROPOSAL_SPLIT: { gate, blocking: false,
    message: 'The import was split into several proposals above approval.max_records_per_proposal.',
    repair: 'Nothing to change; approve each proposal, or raise approval.max_records_per_proposal in center.config.json.' },
};

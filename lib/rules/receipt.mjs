// Rule family "receipt": emitted by lib/receipt.mjs verifyReceipt() and the
// verify verb. Gate id: "receipt".
export const family = 'receipt';
export const gate = 'receipt';
export const rules = {
  DF_RECEIPT_UNREADABLE: { gate, blocking: true,
    message: 'The receipt file cannot be read or is not JSON.',
    repair: 'Point verify at a receipt.json written by a dotfield command, or re-run the command to write a fresh one.' },
  DF_RECEIPT_INVALID: { gate, blocking: true,
    message: 'The receipt does not validate against schemas/receipt.schema.json.',
    repair: 'Fix the DF_SCHEMA_* findings listed beside this one; receipts are built only by lib/receipt.mjs buildReceipt().' },
  DF_RECEIPT_ID_MISMATCH: { gate, blocking: true,
    message: 'The receipt id does not match the digest of its inputs, command and argv.',
    repair: 'Treat the receipt as edited; re-run the command to obtain a receipt whose id recomputes.' },
  DF_RECEIPT_DIGEST_MISMATCH: { gate, blocking: true,
    message: 'A recorded digest (an input, an output or the receipt body) no longer matches.',
    repair: 'Re-run the command so the receipt describes the files as they are now; do not edit receipts by hand.' },
  DF_RECEIPT_REF_MISSING: { gate, blocking: false,
    message: 'A file the receipt refers to is no longer present, so its digest could not be rechecked.',
    repair: 'Nothing to change if the file was removed on purpose (delete sweep); otherwise restore it and verify again.' },
  DF_RECEIPT_EXIT_CODE_MISMATCH: { gate, blocking: true,
    message: 'The stored exit_code disagrees with the status and checks in the receipt.',
    repair: 'Re-run the command; exit codes come only from lib/exit-codes.mjs fromReceipt().' },
  DF_RECEIPT_STATUS_INCONSISTENT: { gate, blocking: true,
    message: 'The ok flag, status and blocking checks of the receipt contradict each other.',
    repair: 'Re-run the command; a non-zero exit is never reported as ok.' },
  DF_RECEIPT_ENGINE_DRIFT: { gate, blocking: false,
    message: 'lib/ or schemas/ changed since this receipt was written (an unintended local edit, not tamper evidence).',
    repair: 'Run dotfield doctor to see which engine files differ; re-run the command after reverting or accepting the change.' },
};

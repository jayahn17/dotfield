// run.md: the human-readable transcript written next to run.json. It is a
// derived file under .dotfield/ (the delete sweep removes it with the records
// it quotes). Pure string builder; the loop supplies run.json and the texts.
import { fencedSpans } from './fence.mjs';

function section(title, body) {
  return `## ${title}\n\n${body}\n`;
}

function fenceNote(text) {
  const n = fencedSpans(text).length;
  return n ? `\n\n_(${n} foreign span${n === 1 ? '' : 's'} fenced in this step)_` : '';
}

/**
 * renderRunMd(run, transcript) -> markdown. transcript: [{step, desk, prompt, text}]
 * in run order. Prompts are summarised by digest and length; responses are
 * quoted in full so the owner can read what each desk said before deciding.
 */
export function renderRunMd(run, transcript = []) {
  const parts = [];
  parts.push(`# Run ${run.run_id}\n`);
  parts.push(`- task: ${run.task}\n- status: **${run.status}**\n- created: ${run.created_at}\n- provider: ${run.provider.adapter}${run.provider.model ? ` (${run.provider.model})` : ''}\n- budget: ${run.budget.used} / ${run.budget.max_tokens} tokens${run.budget.exceeded ? ' — EXCEEDED' : ''}\n- scope: ${run.between ? `between ${run.between.join(' and ')}` : run.with_person ? `with ${run.with_person}` : `rooms ${run.scope.rooms.join(', ') || '(none)'}`}\n- foreign spans: ${run.foreign_spans_count}${run.foreign_spans_digest ? ` (${run.foreign_spans_digest.slice(0, 19)}…)` : ''}\n`);
  parts.push(section('Routing', `specialists: ${run.routing.specialists.join(', ') || '(none)'}\nchallenger: ${run.routing.challenger || '(none)'}\ntokens: ${run.routing.tokens.join(' ') || '(none)'}`));
  if (run.error) parts.push(section('Error', run.error));
  const steps = transcript.map((t, i) => {
    const s = run.steps[i];
    const meta = s ? `prompt ${s.prompt_digest.slice(0, 19)}… (${t.prompt.length} chars) · response ${s.response_digest.slice(0, 19)}… · ${s.tokens_used} tokens` : `(${t.prompt.length} chars of prompt)`;
    return `### ${i + 1}. ${t.step} — ${t.desk}\n\n${meta}\n\n${t.text || '(no response)'}${fenceNote(t.prompt)}`;
  });
  parts.push(section('Transcript', steps.join('\n\n') || '(no provider call was made)'));
  const claims = run.proposal.claims.map((c, i) => `${i + 1}. (${c.desk}) ${c.text}\n   evidence: ${c.evidence_ids.join(', ') || '(none)'}`).join('\n');
  const writes = run.proposal.proposed_writes.map((w) => `- room ${w.room}: ${JSON.stringify(w.record)}`).join('\n');
  parts.push(section('Proposal', `${run.proposal.proposal_ids.length ? `proposal ids: ${run.proposal.proposal_ids.join(', ')}` : 'no proposal file was written'}\n\nclaims:\n${claims || '(none)'}\n\nproposed writes:\n${writes || '(none)'}\n\nblocked actions: ${run.proposal.blocked_actions.join(', ') || '(none)'}`));
  parts.push(section('Next', run.status === 'awaiting_owner'
    ? `The owner decides: \`dotfield approve ${run.proposal.proposal_ids[0] || '<proposal_id>'} --decision approve|edit|reject\` from a TTY or the inbox page. The agent cannot issue approve.`
    : run.status === 'error' ? 'The run ended without a proposal; read the receipt checks and run again.' : 'No further action is required.'));
  return `${parts.join('\n')}`;
}

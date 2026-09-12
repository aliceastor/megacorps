import assert from 'node:assert/strict';
import test from 'node:test';
import { promptSnapshotForAdapter } from './prompt-logs.ts';
import { buildAgentPrompt } from './adapters/hermes.ts';
import { wrapA2aPrompt } from './a2a-final-output.ts';
import { formatAgentPositionPrompt } from './agent-position-prompt.ts';
test('A2A snapshot is exactly the final adapter invocation prompt', () => {
 const agent = {adapterType:'a2a',hermesProfile:'worker',currentSessionId:null};
 const task = {id:'preview',title:'Hello',body:'Explain the project',kind:'chat' as const};
 assert.equal(promptSnapshotForAdapter(agent,task),wrapA2aPrompt(buildAgentPrompt(agent,task),'chat'));
});
test('company leadership position does not claim an unassigned department', () => {
 assert.equal(formatAgentPositionPrompt({positionName:'Advisor',companyName:'Acme',isCompanyLeadership:true}), 'You are Advisor in company leadership of firm Acme.');
 assert.match(formatAgentPositionPrompt({positionName:'Worker',companyName:'Acme'}), /unassigned department/);
});

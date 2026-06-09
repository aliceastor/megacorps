import assert from 'node:assert/strict';
import test from 'node:test';
import { formatAgentPositionPrompt } from './agent-position-prompt.ts';

test('formats assigned position prompt with company and department', () => {
  assert.equal(
    formatAgentPositionPrompt({
      positionName: 'CTO',
      departmentName: 'Engineering',
      companyName: 'MegaCorps',
      customPrompt: 'Own architecture direction.',
    }),
    'You are CTO in Engineering department of firm MegaCorps.\nOwn architecture direction.',
  );
});

test('omits position prompt when an agent has no position', () => {
  assert.equal(formatAgentPositionPrompt({ positionName: '', departmentName: 'Engineering', companyName: 'MegaCorps', customPrompt: 'Ignored.' }), '');
});

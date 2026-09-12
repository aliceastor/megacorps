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

test('observed legacy merge-after-PASS instruction is projected to review-only authority', () => {
  const prompt = formatAgentPositionPrompt({ positionName: 'CTO', customPrompt: '- 測試全綠 + diff 合理 → **PASS**，並用 gitea API merge 該 PR，verdict 附 merge commit SHA\n- 沒驗證過不給 PASS' });
  assert.doesNotMatch(prompt, /並用 gitea API merge 該 PR/);
  assert.match(prompt, /MegaCorps/);
  assert.match(prompt, /沒驗證過不給 PASS/);
});

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
      agent: { id: 'cto', companyId: 'mega', positionId: 'cto-position', departmentId: 'engineering', isActive: true, deletedAt: null },
      position: { id: 'cto-position', companyId: 'mega', rank: 1, isCompanyBoss: false, isDepartmentHead: true, isActive: true, defaultDepartmentId: 'engineering' },
    }),
    'You are CTO in Engineering department of firm MegaCorps.\nOwn architecture direction.\nAuthority: rank 1; boss=no; department_head=yes; staff=yes; active=yes.',
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

test('authoritative injected identity replaces contradictory saved Authority lines', () => {
  const prompt = formatAgentPositionPrompt({
    positionName: 'CEO', companyName: 'MegaCorps', customPrompt: 'Authority: rank 9; boss=no; department_head=no; staff=no; active=no.\nSet direction.',
    agent: { id: 'boss', companyId: 'mega', positionId: 'boss-position', departmentId: null, isActive: true, deletedAt: null },
    position: { id: 'boss-position', companyId: 'mega', rank: 0, isCompanyBoss: true, isDepartmentHead: false, isActive: true, defaultDepartmentId: null },
  });
  assert.doesNotMatch(prompt, /rank 9/);
  assert.match(prompt, /Set direction\.\nAuthority: rank 0; boss=yes; department_head=yes; staff=yes; active=yes\.$/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { messages } from './i18n.ts';

test('form disclosures and routing guidance are present in every supported locale', () => {
  for (const locale of ['en', 'zh-TW', 'ja'] as const) for (const key of ['advanced', 'automatic', 'request', 'deliverableUrl', 'clientApproval', 'projectIntro', 'projectAdvancedHelp', 'saveProjectFirst', 'goalLength', 'mergeRequired', 'mergeAutomatic', 'mergeManual', 'protectionReady', 'protectionRequired', 'routingHelp', 'dependencyHelp', 'productHelp']) {
    assert.ok(messages[locale][`forms.${key}`]?.trim(), `${locale}: forms.${key}`);
  }
});

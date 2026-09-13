import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentOperationHelp, EndpointCard } from './help-page.tsx';

test('Help endpoint cards render human role, Agent-role applicability, and credential transport separately', () => {
  const html = renderToStaticMarkup(createElement(EndpointCard, { endpoint: {
    method: 'GET', path: '/api/help', group: 'System', auth: 'none', requiredRole: 'none', summary: 'Catalog.',
    agentApplicability: { boss: 'available', departmentHead: 'available', staff: 'available' },
    credentialTransport: 'Public; no credential.',
  } }));
  assert.match(html, /Human role/);
  assert.match(html, /Agent roles/);
  assert.match(html, /BOSS.*available/s);
  assert.match(html, /DEPARTMENT HEAD.*available/s);
  assert.match(html, /STAFF.*available/s);
  assert.match(html, /Credential transport.*Public/s);
});

test('Help renders the injected role-labelled Agent operation guides', () => {
  const html = renderToStaticMarkup(createElement(AgentOperationHelp, { guides: {
    chat: 'BOSS: chat', execution: 'STAFF: execute', management: 'DEPARTMENT HEAD: manage', review: 'BOSS: review',
  } }));
  assert.match(html, /Agent operations/);
  assert.match(html, /Direct Chat.*BOSS: chat/s);
  assert.match(html, /Management.*DEPARTMENT HEAD: manage/s);
});

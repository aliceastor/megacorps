import assert from 'node:assert/strict';
import test from 'node:test';
import { isolatedPostgres } from './test-support/postgres-db.ts';

test('company resource context separates directory from delegation and includes per-person stored score evidence', { skip: !process.env.TEST_DATABASE_URL && !process.env.CI ? 'Dedicated PostgreSQL test URL absent' : false, timeout: 60000 }, async t => {
  const { sql, db } = await isolatedPostgres(t);
  const { teamResourceView, activeDirectReportsForAgent } = await import('./dispatch.ts');
  const { buildDirectChatGoalContext } = await import('./chat.ts');
  const { agents } = await import('./db/schema.ts');
  const { eq } = await import('drizzle-orm');
  const [company] = await sql`INSERT INTO companies(name,slug) VALUES('Directory Corp','directory') RETURNING id`;
  const [foreign] = await sql`INSERT INTO companies(name,slug) VALUES('Foreign','foreign-directory') RETURNING id`;
  const companyId = company!.id;
  const [department] = await sql`INSERT INTO departments(company_id,name,slug) VALUES(${companyId},'Engineering','engineering') RETURNING id`;
  const [bossPosition] = await sql`INSERT INTO positions(company_id,name,slug,is_company_boss) VALUES(${companyId},'Boss','boss',true) RETURNING id`;
  const [headPosition] = await sql`INSERT INTO positions(company_id,name,slug,is_department_head,default_department_id) VALUES(${companyId},'CTO','cto',true,${department!.id}) RETURNING id`;
  const [staffPosition] = await sql`INSERT INTO positions(company_id,name,slug,rank,default_department_id,manager_position_id) VALUES(${companyId},'Engineer','engineer',3,${department!.id},${headPosition!.id}) RETURNING id`;
  const [boss] = await sql`INSERT INTO agents(company_id,name,slug,role,position_id,adapter_type) VALUES(${companyId},'Alice','alice','Boss',${bossPosition!.id},'webhook') RETURNING id`;
  const [head] = await sql`INSERT INTO agents(company_id,name,slug,role,position_id,adapter_type) VALUES(${companyId},'CTO','cto','Head',${headPosition!.id},'webhook') RETURNING id`;
  const people: Record<string, string> = {};
  for (const name of ['Ribel', 'Digby', 'David']) {
    const [person] = await sql`INSERT INTO agents(company_id,name,slug,role,position_id,boss_id,adapter_type,is_active) VALUES(${companyId},${name},${name.toLowerCase()},'worker',${staffPosition!.id},${head!.id},'webhook',${name !== 'David'}) RETURNING id`;
    people[name] = person!.id;
  }
  await sql`INSERT INTO agents(company_id,name,slug,role,adapter_type) VALUES(${foreign!.id},'Foreign Sentinel','foreign-sentinel','worker','webhook')`;
  await sql`INSERT INTO agents(company_id,name,slug,role,adapter_type,deleted_at) VALUES(${companyId},'Deleted Sentinel','deleted-sentinel','worker','webhook',now())`;
  const [card] = await sql`INSERT INTO kanban_cards(company_id,title,body,assignee_id,column_status,review_feedback) VALUES(${companyId},'Scored implementation','Synthetic work',${people.Ribel!},'todo','GOAL ASSESSMENT arbitrary feedback must not be used') RETURNING id`;
  const [otherCard] = await sql`INSERT INTO kanban_cards(company_id,title,body) VALUES(${foreign!.id},'Foreign card','Synthetic work') RETURNING id`;
  const scoreIds: string[] = [];
  // A prolific member cannot starve another member's older history or domains.
  for (const [name, count, offset, domain] of [['Ribel', 250, 0, 'code'], ['Digby', 5, 1000, 'code'], ['Ribel', 25, 2000, 'content']] as const) {
    for (let i = 0; i < count; i++) {
      const [score] = await sql`INSERT INTO agent_review_scores(company_id,card_id,agent_id,reviewer_id,domain,score,verdict,created_at) VALUES(${companyId},${card!.id},${people[name]!},${head!.id},${domain},8,'approved',${new Date(Date.UTC(2026, 8, 13) - (offset + i) * 60000).toISOString()}) RETURNING id`;
      if (i < 3 && domain === 'code') scoreIds.push(score!.id);
    }
  }
  await sql`INSERT INTO agent_review_scores(company_id,card_id,agent_id,reviewer_id,domain,score,verdict) VALUES(${foreign!.id},${otherCard!.id},${people.Digby!},${head!.id},'foreign-domain',1,'rejected')`;
  await sql`INSERT INTO agent_review_scores(company_id,card_id,agent_id,reviewer_id,domain,score,verdict,created_at) VALUES(${companyId},${card!.id},${people.Ribel!},${head!.id},'content',0,'rejected',null)`;
  const before = JSON.stringify(await sql`SELECT id,is_busy,current_session_id FROM agents ORDER BY id`);
  const originalUnsafe = sql.unsafe;
  let scoreReads = 0;
  const scoreQueryProbe = t.mock.method(sql, 'unsafe', ((query: string, ...args: unknown[]) => {
    if (/select/i.test(query) && /agent_review_scores/.test(query)) scoreReads++;
    return (originalUnsafe as any)(query, ...args);
  }) as typeof sql.unsafe);
  const view = await teamResourceView(companyId, boss!.id);
  scoreQueryProbe.mock.restore();
  assert.equal(scoreReads, 1, 'one score read covers every displayed member and domain');
  for (const name of ['Alice', 'CTO', 'Ribel', 'Digby', 'David']) assert.ok(view.includes(name), `company directory includes ${name}`);
  assert.match(view, /David[^\n]*inactive/);
  assert.match(view, /reports to: CTO/);
  assert.match(view, /Company directory.*informational/);
  assert.match(view, /Eligible delegation recipients.*cto/);
  assert.match(view, /code 8\/10 over 20/);
  assert.match(view, /code 8\/10 over 5/);
  assert.match(view, /content 8\/10 over 20/);
  assert.match(view, /273 older score records omitted/);
  assert.match(view, /2 older score records omitted/);
  assert.match(view, /open assigned cards: 1/);
  assert.match(view, /No stored score records/);
  assert.ok(!view.includes('GOAL ASSESSMENT'));
  for (const value of ['Foreign Sentinel', 'Deleted Sentinel', 'foreign-domain']) assert.ok(!view.includes(value));
  for (const id of scoreIds) assert.ok(view.includes(id), `score record ${id}`);
  assert.ok(view.includes(`/api/cards/${card!.id}/review-scores`));
  assert.ok(view.includes(head!.id));
  assert.deepEqual((await activeDirectReportsForAgent(companyId, boss!.id)).map(a => a.slug), ['cto']);
  assert.deepEqual((await activeDirectReportsForAgent(companyId, head!.id)).map(a => a.slug).sort(), ['digby', 'ribel']);
  const [bossAgent] = await db.select().from(agents).where(eq(agents.id, boss!.id));
  const chat = await buildDirectChatGoalContext(companyId, bossAgent!, null);
  assert.ok(chat.includes(view), 'Chat uses the same resource projection as Task');
  const { buildPromptPreview } = await import('./prompt-preview.ts');
  const executionCounts = () => sql`SELECT (SELECT count(*) FROM task_runs) AS task_runs, (SELECT count(*) FROM chat_sessions) AS chats, (SELECT count(*) FROM heartbeat_runs) AS heartbeats, (SELECT count(*) FROM prompt_logs) AS prompts`;
  const countsBefore = JSON.stringify(await executionCounts());
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error('Read-only resource preview must not use network'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const agentId of [boss!.id, head!.id]) {
    const [subject] = await db.select().from(agents).where(eq(agents.id, agentId));
    for (const kind of ['task', 'chat'] as const) {
      const preview = await buildPromptPreview(subject!, { kind, body: 'Review real company resources' });
      for (const name of ['Ribel', 'Digby', 'David']) assert.ok(preview.prompt.includes(name), `${kind} preview includes ${name}`);
      for (const id of scoreIds) assert.ok(preview.prompt.includes(id), `${kind} preview includes score ${id}`);
      assert.ok(!preview.prompt.includes('Foreign Sentinel'));
    }
  }
  assert.equal(JSON.stringify(await executionCounts()), countsBefore);
  assert.equal(networkCalls, 0);
  assert.equal(await teamResourceView(companyId, '00000000-0000-4000-8000-000000000001'), '');
  assert.equal(JSON.stringify(await sql`SELECT id,is_busy,current_session_id FROM agents ORDER BY id`), before);
});

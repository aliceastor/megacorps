import assert from 'node:assert/strict';
import test from 'node:test';
import { isolatedPostgres } from './test-support/postgres-db.ts';

test(
  'collaboration children preserve original ownership, review routing and atomic idempotence',
  {
    skip: !process.env.TEST_DATABASE_URL && !process.env.CI ? 'Dedicated PostgreSQL test URL absent' : false,
    timeout: 60000,
  },
  async (t) => {
    const { sql, db } = await isolatedPostgres(t);
    const { processCollaborationRequest } = await import('./collaboration-requests.ts');
    const { agents, kanbanCards } = await import('./db/schema.ts');
    const { eq } = await import('drizzle-orm');
    const [company] = await sql`INSERT INTO companies(name,slug) VALUES('Cooperation','cooperation') RETURNING id`;
    const [other] = await sql`INSERT INTO companies(name,slug) VALUES('Other','other') RETURNING id`;
    const [source] =
      await sql`INSERT INTO departments(company_id,name,slug) VALUES(${company!.id},'Engineering','engineering') RETURNING id`;
    const [target] =
      await sql`INSERT INTO departments(company_id,name,slug) VALUES(${company!.id},'Product','product') RETURNING id`;
    await sql`INSERT INTO departments(company_id,name,slug) VALUES(${company!.id},'Vacant','vacant'),(${other!.id},'Foreign','foreign')`;
    const [bossPosition] =
      await sql`INSERT INTO positions(company_id,name,slug,is_company_boss) VALUES(${company!.id},'Boss','boss',true) RETURNING id`;
    const [boss] =
      await sql`INSERT INTO agents(company_id,name,slug,role,position_id,adapter_type) VALUES(${company!.id},'Boss','boss','Boss',${bossPosition!.id},'webhook') RETURNING id`;
    const heads: Record<string, string> = {};
    for (const [name, department] of [
      ['Engineering', source],
      ['Product', target],
    ] as const) {
      const [position] =
        await sql`INSERT INTO positions(company_id,name,slug,is_department_head,default_department_id) VALUES(${company!.id},${name + ' Head'},${name.toLowerCase() + '-head'},true,${department!.id}) RETURNING id`;
      const [head] =
        await sql`INSERT INTO agents(company_id,name,slug,role,position_id,adapter_type) VALUES(${company!.id},${name + ' Head'},${name.toLowerCase() + '-head'},'Head',${position!.id},'webhook') RETURNING id`;
      heads[name] = head!.id;
    }
    const [staffPosition] =
      await sql`INSERT INTO positions(company_id,name,slug,rank,default_department_id) VALUES(${company!.id},'Staff','staff',9,${source!.id}) RETURNING id`;
    const [staff] =
      await sql`INSERT INTO agents(company_id,name,slug,role,position_id,adapter_type) VALUES(${company!.id},'Staff','staff','worker',${staffPosition!.id},'webhook') RETURNING id`;
    const actor = async (id: string) => (await db.select().from(agents).where(eq(agents.id, id)))[0]!;
    const card = async (owner = staff!.id, department = source!.id) => {
      const [created] =
        await sql`INSERT INTO kanban_cards(company_id,department_id,title,body,assignee_id,column_status) VALUES(${company!.id},${department},'Original work','Implement the original scope; Acceptance: works correctly.',${owner},'in_progress') RETURNING id`;
      return (await db.select().from(kanbanCards).where(eq(kanbanCards.id, created!.id)))[0]!;
    };
    const request = {
      kind: 'collaboration' as const,
      departmentSlug: 'product',
      question: 'Review the acceptance wording for the required error states.',
      acceptance: ['All error states have an approved Traditional Chinese label.', 'The source of the approved wording is identified.'],
    };
    await t.test(
      'native dispatch consumes collaboration and releases the original run while waiting for its child',
      async (t) => {
        const { getAdapter } = await import('./adapters/registry.ts');
        const { dispatchCard } = await import('./dispatch.ts');
        const original = await card();
        const [run] =
          await sql`INSERT INTO task_runs(company_id,card_id,agent_id,kind,status) VALUES(${company!.id},${original.id},${staff!.id},'dispatch','running') RETURNING id`;
        t.mock.method(getAdapter('webhook'), 'dispatch', async () => ({
          success: true,
          output: JSON.stringify({
            kind: 'megacorps-report',
            status: 'input_required',
            summary: 'Need Product wording before finishing implementation.',
            request,
          }),
          sessionId: 'synthetic-collaboration',
          costUsd: 0,
          tokensUsed: 0,
          durationSeconds: 1,
        }));
        await dispatchCard(original.id, 'manual', { taskRunId: run!.id });
        const children = await sql`SELECT * FROM kanban_cards WHERE parent_card_id=${original.id}`;
        assert.equal(children.length, 1);
        const [fresh] = await sql`SELECT * FROM kanban_cards WHERE id=${original.id}`;
        assert.equal(fresh!.column_status, 'in_progress');
        assert.equal(fresh!.rollup_status, 'waiting_on_children');
        assert.equal(fresh!.assignee_id, staff!.id);
        assert.equal(fresh!.execution_lock_id, null);
        assert.equal((await sql`SELECT status FROM task_runs WHERE id=${run!.id}`)[0]!.status, 'success');
        assert.equal((await sql`SELECT is_busy FROM agents WHERE id=${staff!.id}`)[0]!.is_busy, false);
        assert.equal((await sql`SELECT id FROM task_runs WHERE card_id=${original.id} AND kind='review'`).length, 0);
      },
    );
    await t.test(
      'Staff request attaches to Staff original card with Head+Staff review even when target is busy',
      async () => {
        await sql`UPDATE agents SET is_busy=true WHERE id=${heads.Product!}`;
        const original = await card();
        const requester = await actor(staff!.id);
        const results = await Promise.all([
          processCollaborationRequest(original, requester, request),
          processCollaborationRequest(original, requester, request),
        ]);
        assert.deepEqual(results[0]!.errors, []);
        assert.deepEqual(results[1]!.errors, []);
        assert.deepEqual(results[0]!.created, results[1]!.created);
        const [child] = await sql`SELECT * FROM kanban_cards WHERE parent_card_id=${original.id}`;
        assert.equal(child!.assignee_id, heads.Product);
        assert.equal(child!.department_id, target!.id);
        assert.equal(child!.reviewer_id, heads.Engineering);
        assert.deepEqual(child!.reviewer_ids, [heads.Engineering, staff!.id]);
        assert.equal(child!.review_mode, 'panel');
        const { acceptanceOf } = await import('./card-brief.ts');
        assert.equal(acceptanceOf(child!.body), '- All error states have an approved Traditional Chinese label.\n- The source of the approved wording is identified.');
        assert.match(child!.body, /Traditional Chinese/);
        const [fresh] = await sql`SELECT * FROM kanban_cards WHERE id=${original.id}`;
        assert.equal(fresh!.assignee_id, staff!.id);
        assert.equal(fresh!.rollup_status, 'waiting_on_children');
        assert.equal(fresh!.split_round, 1);
        const comments =
          await sql`SELECT * FROM card_comments WHERE card_id=${child!.id} AND action='collaboration_requested'`;
        assert.equal(comments.length, 1);
        assert.equal(comments[0]!.metadata.sourceCardId, original.id);
        assert.equal(comments[0]!.metadata.requesterAgentId, staff!.id);
      },
    );
    await t.test('Head requests use the requesting Head as reviewer', async () => {
      const original = await card(heads.Engineering);
      const result = await processCollaborationRequest(original, await actor(heads.Engineering!), request);
      assert.deepEqual(result.errors, []);
      const [child] = await sql`SELECT * FROM kanban_cards WHERE id=${result.created[0]!}`;
      assert.equal(child!.parent_card_id, original.id);
      assert.equal(child!.reviewer_id, heads.Engineering);
      assert.deepEqual(child!.reviewer_ids, [heads.Engineering]);
      assert.equal(child!.review_mode, 'single');
    });
    for (const [label, slug] of [
      ['same department', 'engineering'],
      ['foreign department', 'foreign'],
      ['missing Head', 'vacant'],
    ] as const)
      await t.test(label + ' does not create a child', async () => {
        const original = await card();
        const result = await processCollaborationRequest(original, await actor(staff!.id), {
          ...request,
          departmentSlug: slug,
        });
        assert.equal(result.created.length, 0);
        assert.ok(result.errors.length);
        assert.equal((await sql`SELECT id FROM kanban_cards WHERE parent_card_id=${original.id}`).length, 0);
      });
    await t.test('stale owner and non-dispatch run cannot mutate the source card', async () => {
      const original = await card();
      const requester = await actor(staff!.id);
      await sql`UPDATE kanban_cards SET assignee_id=${heads.Engineering!} WHERE id=${original.id}`;
      assert.match((await processCollaborationRequest(original, requester, request)).errors.join(' '), /authority/);
      const fresh = await card();
      const [run] =
        await sql`INSERT INTO task_runs(company_id,card_id,agent_id,kind,status) VALUES(${company!.id},${fresh.id},${staff!.id},'review','running') RETURNING id`;
      assert.match(
        (await processCollaborationRequest(fresh, requester, request, run!.id)).errors.join(' '),
        /dispatch/,
      );
    });
    await t.test('Boss uses normal department assignment instead of cooperation requests', async () => {
      const original = await card(boss!.id, null);
      assert.ok((await processCollaborationRequest(original, await actor(boss!.id), request)).errors.length);
    });
    await t.test('a reverse departmental request cannot form a cycle', async () => {
      const original = await card();
      const created = await processCollaborationRequest(original, await actor(staff!.id), request);
      const child = (await db.select().from(kanbanCards).where(eq(kanbanCards.id, created.created[0]!)))[0]!;
      assert.match(
        (
          await processCollaborationRequest(child, await actor(heads.Product!), {
            ...request,
            departmentSlug: 'engineering',
          })
        ).errors.join(' '),
        /cycle/,
      );
    });
    await t.test('existing live children and solo mode retain their ordinary gates', async () => {
      const original = await card();
      await processCollaborationRequest(original, await actor(staff!.id), request);
      assert.match(
        (
          await processCollaborationRequest(original, await actor(staff!.id), {
            ...request,
            question: 'A different request for other wording.',
          })
        ).errors.join(' '),
        /round_in_progress/,
      );
      const solo = await card();
      await sql`UPDATE kanban_cards SET decision_mode='solo' WHERE id=${solo.id}`;
      const current = (await db.select().from(kanbanCards).where(eq(kanbanCards.id, solo.id)))[0]!;
      assert.match(
        (await processCollaborationRequest(current, await actor(staff!.id), request)).errors.join(' '),
        /solo/,
      );
    });
  },
);

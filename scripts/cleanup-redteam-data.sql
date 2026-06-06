BEGIN;

CREATE TEMP TABLE redteam_users AS
SELECT id FROM users
WHERE email LIKE 'redteam-%@example.test'
   OR email LIKE 'blocked-%@example.test';

CREATE TEMP TABLE redteam_companies AS
SELECT id FROM companies
WHERE slug LIKE 'victim-%'
   OR slug LIKE 'attacker-%'
   OR slug LIKE 'fixed-victim-%'
   OR slug LIKE 'fixed-attacker-%';

CREATE TEMP TABLE redteam_agents AS
SELECT id FROM agents
WHERE company_id IN (SELECT id FROM redteam_companies);

CREATE TEMP TABLE redteam_runtimes AS
SELECT id FROM agent_runtimes
WHERE company_id IN (SELECT id FROM redteam_companies)
   OR name LIKE 'Victim Runtime %'
   OR name LIKE 'Fixed Runtime %'
   OR name LIKE 'Runtime Taken %';

CREATE TEMP TABLE redteam_cards AS
SELECT id FROM kanban_cards
WHERE company_id IN (SELECT id FROM redteam_companies)
   OR created_by IN (SELECT id FROM redteam_users)
   OR tags && ARRAY['redteam', 'redteam-fixed']::text[];

CREATE TEMP TABLE redteam_projects AS
SELECT id FROM projects WHERE company_id IN (SELECT id FROM redteam_companies);

CREATE TEMP TABLE redteam_goals AS
SELECT id FROM goals WHERE company_id IN (SELECT id FROM redteam_companies);

UPDATE kanban_cards SET parent_card_id = NULL WHERE parent_card_id IN (SELECT id FROM redteam_cards);
UPDATE kanban_cards SET active_heartbeat_run_id = NULL WHERE id IN (SELECT id FROM redteam_cards);
UPDATE kanban_cards SET assignee_id = NULL WHERE assignee_id IN (SELECT id FROM redteam_agents);
UPDATE kanban_cards SET reviewer_id = NULL WHERE reviewer_id IN (SELECT id FROM redteam_agents);
UPDATE kanban_cards SET execution_locked_by_agent_id = NULL WHERE execution_locked_by_agent_id IN (SELECT id FROM redteam_agents);
UPDATE agents SET boss_id = NULL WHERE boss_id IN (SELECT id FROM redteam_agents);

UPDATE task_runs SET heartbeat_run_id = NULL
WHERE card_id IN (SELECT id FROM redteam_cards)
   OR agent_id IN (SELECT id FROM redteam_agents)
   OR company_id IN (SELECT id FROM redteam_companies);

DELETE FROM task_logs
WHERE card_id IN (SELECT id FROM redteam_cards)
   OR agent_id IN (SELECT id FROM redteam_agents);

DELETE FROM card_comments
WHERE card_id IN (SELECT id FROM redteam_cards)
   OR author_id IN (SELECT id FROM redteam_users)
   OR agent_id IN (SELECT id FROM redteam_agents);

DELETE FROM task_runs
WHERE card_id IN (SELECT id FROM redteam_cards)
   OR agent_id IN (SELECT id FROM redteam_agents)
   OR company_id IN (SELECT id FROM redteam_companies)
   OR requested_by_user_id IN (SELECT id FROM redteam_users);

DELETE FROM heartbeat_runs
WHERE card_id IN (SELECT id FROM redteam_cards)
   OR agent_id IN (SELECT id FROM redteam_agents)
   OR company_id IN (SELECT id FROM redteam_companies);

DELETE FROM approvals
WHERE card_id IN (SELECT id FROM redteam_cards)
   OR company_id IN (SELECT id FROM redteam_companies)
   OR requested_by_user_id IN (SELECT id FROM redteam_users)
   OR decided_by_user_id IN (SELECT id FROM redteam_users);

DELETE FROM cost_events
WHERE card_id IN (SELECT id FROM redteam_cards)
   OR agent_id IN (SELECT id FROM redteam_agents)
   OR company_id IN (SELECT id FROM redteam_companies)
   OR project_id IN (SELECT id FROM redteam_projects)
   OR goal_id IN (SELECT id FROM redteam_goals);

DELETE FROM chat_messages
WHERE session_id IN (
  SELECT id FROM chat_sessions
  WHERE company_id IN (SELECT id FROM redteam_companies)
     OR agent_id IN (SELECT id FROM redteam_agents)
     OR user_id IN (SELECT id FROM redteam_users)
)
   OR company_id IN (SELECT id FROM redteam_companies)
   OR agent_id IN (SELECT id FROM redteam_agents)
   OR user_id IN (SELECT id FROM redteam_users);

DELETE FROM chat_sessions
WHERE company_id IN (SELECT id FROM redteam_companies)
   OR agent_id IN (SELECT id FROM redteam_agents)
   OR user_id IN (SELECT id FROM redteam_users);

DELETE FROM activity_log
WHERE company_id IN (SELECT id FROM redteam_companies)
   OR agent_id IN (SELECT id FROM redteam_agents)
   OR user_id IN (SELECT id FROM redteam_users)
   OR details::text LIKE '%redteam-%@example.test%';

DELETE FROM api_events
WHERE user_id IN (SELECT id FROM redteam_users)
   OR request_body::text LIKE '%redteam-%@example.test%'
   OR response_body::text LIKE '%redteam-%@example.test%';

DELETE FROM budget_policies
WHERE company_id IN (SELECT id FROM redteam_companies)
   OR agent_id IN (SELECT id FROM redteam_agents)
   OR name LIKE 'Victim Budget %'
   OR name LIKE 'Fixed Policy %'
   OR name LIKE 'Budget Taken %';

DELETE FROM knowledge_docs
WHERE company_id IN (SELECT id FROM redteam_companies)
   OR created_by IN (SELECT id FROM redteam_users)
   OR tags && ARRAY['redteam', 'redteam-fixed', 'takeover']::text[];

DO $$
BEGIN
  IF to_regclass('public.user_invites') IS NOT NULL THEN
    DELETE FROM user_invites
    WHERE company_id IN (SELECT id FROM redteam_companies)
       OR invited_by_user_id IN (SELECT id FROM redteam_users)
       OR accepted_by_user_id IN (SELECT id FROM redteam_users)
       OR email LIKE 'redteam-%@example.test'
       OR email LIKE 'blocked-%@example.test';
  END IF;
END $$;

DELETE FROM company_memberships
WHERE company_id IN (SELECT id FROM redteam_companies)
   OR user_id IN (SELECT id FROM redteam_users);

DELETE FROM kanban_cards WHERE id IN (SELECT id FROM redteam_cards);
DELETE FROM agents WHERE id IN (SELECT id FROM redteam_agents);
DELETE FROM agent_runtimes WHERE id IN (SELECT id FROM redteam_runtimes);
DELETE FROM projects WHERE id IN (SELECT id FROM redteam_projects);
DELETE FROM goals WHERE id IN (SELECT id FROM redteam_goals);
DELETE FROM departments WHERE company_id IN (SELECT id FROM redteam_companies);
DELETE FROM companies WHERE id IN (SELECT id FROM redteam_companies);
DELETE FROM users WHERE id IN (SELECT id FROM redteam_users);

COMMIT;

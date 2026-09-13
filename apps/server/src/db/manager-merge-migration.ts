export const managerMergeMigration = `
ALTER TABLE merge_intents ADD COLUMN IF NOT EXISTS decision_required BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE merge_intents ADD COLUMN IF NOT EXISTS candidate_department_id UUID;
ALTER TABLE merge_intents ADD COLUMN IF NOT EXISTS authorized_by_agent_id UUID;
ALTER TABLE merge_intents ADD COLUMN IF NOT EXISTS authorized_by_user_id UUID;
ALTER TABLE merge_intents ADD COLUMN IF NOT EXISTS authorized_at TIMESTAMPTZ;
ALTER TABLE merge_intents ADD COLUMN IF NOT EXISTS authorization_reason TEXT;
ALTER TABLE merge_intents ADD COLUMN IF NOT EXISTS decision_question_id UUID;
UPDATE merge_intents m SET candidate_department_id = c.department_id FROM kanban_cards c WHERE m.card_id = c.id AND m.candidate_department_id IS NULL;
-- A request already sent cannot be undone. Reconcile only; never fabricate a
-- manager decision or replay a legacy uncertain request without a fresh one.
UPDATE merge_intents SET last_result = 'Manager authorization is now required before another provider merge request.' WHERE state IN ('prepared','retryable','uncertain','in_flight');
-- Previously exhausted polling must be able to discover the new manager step.
-- These three diagnostic fields are excluded from the existing merge fence.
UPDATE external_waits w SET poll_count = 0, last_polled_at = NULL, poll_interval_seconds = 30
FROM merge_intents m WHERE m.wait_id = w.id AND w.status = 'waiting'
AND m.state IN ('prepared','retryable','uncertain','in_flight');
`;

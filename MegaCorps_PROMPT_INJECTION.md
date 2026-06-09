# MegaCorps Prompt Injection Format

Last updated: 2026-06-09

This document describes the prompt content MegaCorps injects for Direct Chat and Kanban task runs.

## Shared Context Blocks

MegaCorps uses bounded context budgets, so long fields are clipped rather than omitted silently. The common blocks are:

- Company name, mission, dispatch settings
- Company goals, department goals, project goals
- Project repo binding and Git completion policy, when a project has a repository
- Agent identity, title, soul/work style, reporting manager, direct reports
- Agent position prompt when `agent.positionId` is set
- Same-company Kanban snapshot with compact card lines
- Focus card dependency state and recent card action/log history
- Focus-agent assigned work and review queue
- Recent activity and heartbeat runs
- Relevant knowledge docs

## Goal Context

Goals are scoped in three layers:

- Company goal: applies to all company work.
- Department goal: applies when the task or agent is in that department.
- Project goal: applies when the task or chat session belongs to that project.

For Kanban task dispatch, MegaCorps injects the company, matching department, matching project, selected card goal, and a final applicable-goals list for quick reading:

```text
Goal context:
Company goals:
- Company goal: <title>
  <body>
Department: <department name | none>
Department goals:
- Department goal: <title>
  <body>
Project: <project name | none>
Project goals:
- Project goal: <title>
  <body>
Selected card goal:
- <scope> goal: <title>
  <body>
Applicable goals:
- <all company + matching department/project + selected goals>
```

For Direct Chat, the session `projectId` controls the project goal layer. A null `projectId` is treated as no-project/general chat.

## Agent Soul And Codex App-Server Wrapper

`soul` is MegaCorps' platform-owned identity/personality/work-style prompt for an agent. Hermes agents can still use a native `hermesProfile`, but adapters without native profiles, especially `codex-app`, should use `soul` as the primary identity definition.

When `adapterType=codex-app`, MegaCorps wraps the normal Direct Chat or Kanban prompt with:

```text
You are running through Codex app-server as a MegaCorps agent. MegaCorps is the source of truth for your identity, task scope, goals, and completion protocol.

=== Agent Soul ===
<agent.soul, or fallback name/role/title>

=== Adapter Session ===
Codex thread: <existing thread id | new>
Session policy: Direct Chat uses one thread per chat session. Kanban uses one thread per card, agent, and dispatch/review kind. Every retry or continuation is a new turn in that thread.

<normal MegaCorps Direct Chat or Kanban task prompt>
```

This deliberately uses task-scoped sessions rather than project-scoped sessions. Project context comes from `projectId`, repo policy, goals, and work products; the Codex conversation thread is scoped to the actual chat or card work item so unrelated project tasks do not contaminate each other.

## Agent Position Prompt

Positions are company-scoped reusable role prompts. Operators create them from `Positions`, then assign one to an agent from the Agent create/edit flow.

When an agent has a position, MegaCorps injects:

```text
You are <position name> in <department name | unassigned> department of firm <company name>.
<custom position prompt>
```

The position prompt is injected for both Direct Chat and Kanban task dispatch. It is separate from `agent.soul`: `position` defines the reusable office/role contract, while `soul` defines that specific agent's personality, habits, and work style.

## Project Repository And Work Path Protocol

Projects carry the shared repo/workspace policy. This is designed for multi-system agents: every agent runtime owns its own local folder or clone cache, while MegaCorps injects the shared Git repository, project-level work path, and required operating protocol.

`repoUrl` and `workPath` are project-level settings:

- `repoUrl`: the shared Git remote for coding/text-controlled work.
- `workPath`: the repo/workspace-relative area the agent should edit, for example `apps/server`, `reports/final`, or `docs/contracts`. Null means project root.
- `workspacePathHint`: optional runtime-local hint only. It is never the shared source of truth.

Operators maintain these project authority fields from the Projects page. Prompt injection receives the stored repo/work-path policy from the project record rather than any runtime-local folder hint.

Runtime presets add machine-local roots:

- `localWorkspaceRoot`: persistent clone/cache root on that specific runtime machine/container.
- `localScratchRoot`: temporary task scratch root on that specific runtime machine/container.
- These paths are injected for the selected agent runtime. They are not project state and may differ for every agent/runtime.

Injected fields:

```text
Project repository provider: <github | gitlab | gitea | generic>
Project repository URL: <repo url | not configured>
Project work path: <relative path | project root>
Runtime-local workspace root: <local path | not configured>
Runtime-local scratch root: <local path | not configured>
Default branch: <branch>
Protected branches: <branch list>
Task branch pattern: megacorps/card-{cardId}-{agentSlug}
Pull before run: yes | no
Push after run: yes | no
Completion policy: push_or_pr | pull_request | push_branch | manual
Setup command: <optional>
Test command: <optional>
Runtime-local workspace hint: <optional local hint only>
Runtime services: <json metadata>
```

When a repo is configured, the prompt instructs the agent to clone/cache under `localWorkspaceRoot` when configured, stay inside the project work path unless the task explicitly requires broader edits, fetch/pull or rebase before editing, work on the task branch, avoid direct pushes to protected branches, run relevant setup/tests, then push a branch or create a PR according to the project policy. `localScratchRoot` is for temporary work only; final outputs should be submitted as work products, URLs, commits, PRs, or artifacts.

## Kanban Dispatch Prompt

Kanban dispatch calls the adapter with a task body shaped like:

```text
Company: <company name>
Mission: <company mission>

Project: <project name>
<project description>
<project repo binding and Git protocol>

Goal: <selected goal title>
<selected goal body>

Assigned member: <agent name>
Identity label: <agent role>
Position: <position name | none>
Position prompt:
You are <position name> in <department name | unassigned> department of firm <company name>.
<custom position prompt>
Soul:
<agent.soul, if configured>
Reports to: <manager name | top-level>
Direct reports: <report list | none>

Goal context:
<company / department / project / selected / applicable goals>

Card: <title>
Status: <columnStatus>
Priority: <number>

Previous review feedback:
<feedback, if any>

Kanban context snapshot:
<bounded company board, focus card, dependencies, messages, action timeline, logs, activity, runs>

Company knowledge:
<matching knowledge docs>

Repository protocol:
<pull / branch / setup / test / push / PR / workProducts instructions>

Task body:
<card body>

Completion protocol:
If you can complete the task, post the final answer back through the MegaCorps webhook with status="done".
When the task produces repo changes or reviewable artifacts, include workProducts in the webhook. Use PR URL, commit SHA, branch, preview URL, report URL, screenshot URL, or artifact URL instead of local-only file paths.
If you need ordinary QA on completed work, use status="in_review" and include the completed output.
If you cannot solve it, do not mark it complete. Use status="needs_review" and include: attempted methods, blocker/root cause, exact reviewer questions, partial output, and logs.
If no reviewer/manager exists, the server will move top-level escalations to blocked for human intervention.
```

External runner note:

- Machine runner dispatch claims move the card to `in_progress` and take an execution lock before the runner receives the task payload.
- Machine runner review claims only run after the card is already in `in_review` or `needs_review`.
- A runner dispatch `success` moves to `in_review` when the card has a reviewer, otherwise `done`.
- A runner review `success` approves the card to `done`.
- Agent-session claim, review, and release endpoints use the same lifecycle guard as human/API updates. If the runner created the session with a `cardId`, that signed session can only operate on that card.

## Review Prompt

There are two review modes.

Quality review (`in_review`):

```text
Quality-review the completed work for card <id>: <title>.
Return PASS/APPROVED if it is acceptable, or REJECT/REVISION_REQUESTED with feedback if it needs more work.
Use ESCALATE only if your manager must decide.
```

Help/escalation review (`needs_review`):

```text
Help-review an escalated card <id>: <title>.
The assignee says they cannot complete the task.
Decide one of:
- APPROVE/DONE if you can finish it directly.
- REVISION_REQUESTED with concrete guidance if the assignee should retry.
- ESCALATE if your manager must decide.
```

If the reviewer has no manager and cannot resolve the task, MegaCorps moves the card to `blocked`.

## Direct Chat Prompt

Direct Chat uses the same agent identity and Kanban snapshot, but without the webhook completion protocol:

```text
Company: <company name>
Mission: <company mission>

Goal context:
Project: <project name | No project / general chat>
Project description: <description, if any>
Project repository provider: <provider>
Project repository URL: <repo URL | not configured>
Project work path: <relative path | project root>
Repository rule: use runtime-local clone, stay inside the project work path unless explicitly required, pull before repo work, push/PR finished changes, and report URLs rather than local-only paths.
Department: <agent department | none>
Position prompt:
You are <position name> in <department name | unassigned> department of firm <company name>.
<custom position prompt>
Company goals:
<company goals>
Department goals:
<agent department goals>
Project goals:
<session project goals>

Agent name: <agent name>
Identity label: <agent role>
Title: <agent title | none>
Adapter: <adapter type>
Soul:
<agent.soul, if configured>

Kanban context snapshot:
<bounded same-company board and focus-agent work context>

Conversation history:
[user] <message>
[agent] <reply>
```

## Webhook Escalation Payload

When an assignee cannot solve a task, the preferred callback is:

```json
{
  "cardId": "<card uuid>",
  "taskRunId": "<task run uuid>",
  "status": "needs_review",
  "summary": "needs reviewer guidance: <short blocker>",
  "output": "Attempted methods:\n- ...\n\nBlocker/root cause:\n...\n\nReviewer questions:\n- ...\n\nPartial output/logs:\n...",
  "costUsd": 0.001
}
```

`status=blocked` with explicit needs-guidance/escalation wording is also promoted to `needs_review` when an independent reviewer or manager exists. If none exists, the card becomes `blocked`.

## Work Product Payload

When a task produces a reviewable deliverable, the webhook can attach work products:

```json
{
  "cardId": "<card uuid>",
  "taskRunId": "<task run uuid>",
  "status": "done",
  "summary": "Implemented and pushed the project workspace model.",
  "output": "What changed, validation performed, and any residual risk.",
  "workProducts": [
    {
      "type": "pull_request",
      "title": "Project workspace model PR",
      "summary": "Adds repo binding, pull-before-run prompt protocol, and work product tracking.",
      "repoProvider": "github",
      "repoUrl": "https://github.com/org/repo",
      "branch": "megacorps/card-4c28bf9f-alice",
      "commitSha": "abc123...",
      "pullRequestUrl": "https://github.com/org/repo/pull/42"
    },
    {
      "type": "preview_url",
      "title": "Preview deployment",
      "url": "https://preview.example.com"
    }
  ],
  "costUsd": 0.001
}
```

For multi-system agents, local file paths are only useful as private runtime notes. Reviewer-facing artifacts should be URLs, commit SHAs, branches, PRs, screenshots, reports, or other externally reachable references.

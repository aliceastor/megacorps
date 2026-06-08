# MegaCorps Prompt Injection Format

Last updated: 2026-06-08

This document describes the prompt content MegaCorps injects for Direct Chat and Kanban task runs.

## Shared Context Blocks

MegaCorps uses bounded context budgets, so long fields are clipped rather than omitted silently. The common blocks are:

- Company name, mission, dispatch settings
- Company goals, department goals, project goals
- Project repo binding and Git completion policy, when a project has a repository
- Agent identity, title, reporting manager, direct reports
- Same-company Kanban snapshot with compact card lines
- Focus-agent assigned work and review queue
- Recent activity and heartbeat runs
- Relevant knowledge docs

## Goal Stack

Goals are scoped in three layers:

- Company goal: applies to all company work.
- Department goal: applies when the task or agent is in that department.
- Project goal: applies when the task or chat session belongs to that project.

For Kanban task dispatch, MegaCorps injects:

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
Effective goal stack:
- <all company + matching department/project + selected goals>
```

For Direct Chat, the session `projectId` controls the project goal layer. A null `projectId` is treated as no-project/general chat.

## Project Repository And Work Path Protocol

Projects carry the shared repo/workspace policy. This is designed for multi-system agents: every agent runtime owns its own local folder or clone cache, while MegaCorps injects the shared Git repository, project-level work path, and required operating protocol.

`repoUrl` and `workPath` are project-level settings:

- `repoUrl`: the shared Git remote for coding/text-controlled work.
- `workPath`: the repo/workspace-relative area the agent should edit, for example `apps/server`, `reports/final`, or `docs/contracts`. Null means project root.
- `workspacePathHint`: optional runtime-local hint only. It is never the shared source of truth.

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
Reports to: <manager name | top-level>
Direct reports: <report list | none>

Goal context:
<company / department / project / selected / effective goals>

Card: <title>
Status: <columnStatus>
Priority: <number>

Previous review feedback:
<feedback, if any>

Kanban context snapshot:
<bounded company board, focus card, messages, logs, activity, runs>

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

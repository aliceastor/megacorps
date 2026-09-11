# Durable A2A polling

Approved in conversation: submit once, discover the accepted Hermes task, poll it, retain correlation across failures/restarts, and return Direct Chat acceptance immediately. Work in Z; do not modify Hermes or its safety settings.

The deployed Hermes implementation registers a task before its synchronous profile invocation. It implements ListTasks filtered by contextId and GetTask, but does not immediately acknowledge SendMessage. MegaCorps must therefore run submission concurrently with discovery, without depending on a long HTTP response or push callbacks. A baseline of task IDs in the same context and serialized outstanding submissions prevents selecting an earlier task as the new response. Multiple new matches or disappearance after acceptance are ambiguous, not permission to resubmit.

Persist each logical invocation and its submission phase before sending. Save context, route identity, baseline IDs, remote task ID, original deadline and terminal outcome. Re-entering an invocation or recovering an unfinished scope resumes reads only. A database uniqueness constraint and atomic creation grant submission ownership once. A crash between recording intent and sending is intentionally treated as uncertain rather than risking duplicate execution. Results are acknowledged only after the existing card/chat result path handles them. Terminal outcomes are replayable for the same invocation without another SendMessage.

Poll lightweight status using historyLength=0 and bounded request timeouts; fetch the full final task when terminal/interrupted. Retry reads with capped delay within the original overall deadline. Persist sanitized transport cause/code. Do not trust latest task, treat submitted/working as completed, synthesize usage, or bypass review/merge. Unknown acceptance, route change, lost remote state and total deadline exhaustion enter recovery with preserved evidence.

Direct Chat stores a pending job and returns HTTP 202 with the saved user message and job identity. A leased worker performs the existing authorized chat flow, publishes existing events and stores the eventual response once. Browser polling supplements events and restores processing state after refresh. Restarted workers resume the same execution key. Normal non-A2A behavior remains compatible.

Verification: deterministic delayed gateway tests, persistence and concurrent ownership tests on PostgreSQL, chat 202/reload/restart/idempotent response tests, existing adapter/report/permission/review regressions, full server/web/shared tests and builds, CI Docker jobs, and a bounded deployed A2A check. Existing independent report-extraction defects are tracked separately; polling completion is not a claim of full natural lifecycle acceptance.

## Local cancellation and remote capacity

Local cancellation stops card orchestration; it does not establish that the remote model process stopped. The observed Hermes CancelTask implementation changes the task state while its forwarded subprocess can remain alive. MegaCorps therefore keeps outstanding remote work separate from the local card status and does not issue CancelTask as a substitute for termination evidence.

The existing worker loop performs bounded, leased, read-only reconciliation against the saved route identity, context, baseline and task ID. It never resubmits a message, redirects an old task to a changed endpoint, resets the original deadline, or applies a late cancelled result to cards, reviews or merges. Natural terminal evidence permits accounting against the original attempt and releasing capacity no longer owned by other work. An uncertain acceptance, identity mismatch or merely cancelled remote task remains explicitly unresolved. A journal proven never submitted can be fenced and released without pretending a remote task completed.

`GET /api/agents` exposes `remoteWork: null | {status, count, reason}`, with status `waiting_for_remote` or `unresolved`; unresolved remote work keeps `isBusy` true. Direct Chat returns `409 a2a_remote_work_pending` when that capacity remains occupied. Pausing or clearing a session does not bypass the same admission guard. Recovery of the original invocation retains its identity and existing accounting instead of reserving another attempt.

## Final answer projection

Recognizable Hermes CLI transcripts are reduced to one terminal report or explicitly framed chat answer before normal report validation. A current structured report takes precedence over textual history. Ambiguous output fails rather than exposing the transcript or selecting an older successful report. A2A Direct Chat requests a transport-only JSON envelope whose decoded body preserves the existing chat-actions protocol. Stored output carries a projection version so old journals can be upgraded on read without decoding new display content twice. Report schema, professional review and merge gates remain unchanged.

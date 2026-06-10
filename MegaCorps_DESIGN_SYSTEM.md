# MegaCorps Design System

MegaCorps should feel like a calm operating system for delegating work to agents: restrained, clean, inspectable, and slightly editorial. It should not feel like an AI template site, a marketing dashboard, or a collection of oversized rounded cards.

## Design Position

MegaCorps is an operational product. The interface must help users understand work state, agent behavior, context usage, cost, logs, and recovery paths.

The desired tone is:

- Restrained rather than flashy.
- Clean rather than decorative.
- Dense but readable.
- Editorial in typography and spacing.
- Technical, but not cold.
- Trustworthy, inspectable, and easy to debug.

Every visual decision should support one of these goals:

- Make state clear.
- Make actions predictable.
- Make agent work auditable.
- Reduce accidental destructive actions.
- Keep long-running work understandable.
- Help users recover when automation fails.

## Page Patterns

### Dashboard

Use a command-center layout with compact metrics, recent activity, and operational shortcuts.

Do:

- Show system health, active work, costs, blocked tasks, and recent agent activity.
- Use compact statistic rows or tiles with restrained borders.
- Keep API/help links accessible but visually secondary.

Avoid:

- Hero sections.
- Marketing copy.
- Oversized metric cards with decorative gradients.

### Kanban

Kanban is the main work surface. It should behave like a professional operations board, not a playful card wall.

Desktop pattern:

- Horizontal stage columns.
- Compact task cards.
- Stage counts in column headers.
- Inline filters above the board.
- Task detail opens as a centered modal or inspector panel.

Narrow viewport pattern:

- Do not force a desktop Kanban layout.
- Use stage tabs, segmented controls, or a stacked list grouped by stage.
- Task detail should become a full-screen sheet.

Task cards should show:

- Title.
- Short description preview.
- Stage / priority / assignee.
- Short ID only.
- Cost only when relevant.
- Parent / child indicator when relevant.

Task cards should not show:

- Full UUID.
- Full task body.
- Too many badges.
- Raw technical metadata unless requested.

### Task Detail

Task detail is an inspection and control surface. It should have strong hierarchy.

Recommended structure:

1. Header: title, stage, assignee, primary status.
2. Primary actions: save, run, review.
3. Main content: details, message board, ticket thread, logs, work products, subtasks.
4. Metadata: UUID, session, retries, cost, locks, prompt context mode.
5. Dangerous actions: cancel, delete, separated at the bottom.

Use tabs for major surfaces:

- Details
- Message Board
- Ticket Thread
- Logs
- Work Products
- Subtasks

Message Board and Ticket Thread must remain separate:

- Message Board is human/agent conversation around the task.
- Ticket Thread is the operational event history, actions, logs, and work products.

### Direct Chat

Direct Chat should feel like a working conversation with an agent, not a long page of unbounded text.

Do:

- Use a fixed-height scrollable message region.
- Keep the composer pinned.
- Show agent identity, runtime, session state, and context mode.
- Distinguish user, agent, and system messages clearly.

Avoid:

- Letting the conversation stretch the whole page infinitely.
- Mixing chat content with logs unless explicitly expanded.
- Hiding session or context-resume state.

### O-Chart

The O-Chart should read like an organizational map with live operational state.

Node content order:

```text
{status light} Alice Astor
               CEO
               hermes-ssh | Idle
```

Do:

- Align role and adapter text with the agent name, not with the status light.
- Include text status after adapter.
- Use status color plus status text.
- Keep nodes compact.

Avoid:

- Large decorative org cards.
- Status indicated by color only.
- Overly rounded people cards.

### Logs And Prompt Logs

Logs are debugging surfaces. They need filtering and legibility more than decoration.

Do:

- Use a timeline or table-like layout.
- Use monospaced text for IDs, timestamps, model names, token counts, and costs.
- Provide filters for severity, actor, card, context mode, and time.
- Highlight new events subtly.

Avoid:

- Dumping long raw text without hierarchy.
- Color-only severity.
- Full-width paragraphs for dense technical logs.

### Help And API Help

Help should behave like searchable documentation.

Do:

- Use a searchable route catalog.
- Group by feature area.
- Include concise examples.
- Make CLI/API distinctions obvious.

Avoid:

- Long unstructured markdown walls inside the app.
- Marketing-style documentation cards.

## Visual Style

The preferred style is **Calm Technical Editorial**.

This means:

- Flat surfaces.
- Thin borders.
- Small radius.
- Strong typography hierarchy.
- Editorial spacing.
- Sparse, meaningful color.
- Minimal shadows.
- No decorative gradients.
- No glassmorphism.
- No AI-purple template aesthetic.

Use cards only where they represent real repeated objects or contained tools:

- Task cards.
- Agent nodes.
- Modal panels.
- Repeated records.

Do not use cards for every page section. Page sections should usually be unframed layouts or full-width bands with constrained inner content.

## Layout System

Use an 8px spacing foundation with 4px increments for fine control.

Recommended scale:

```text
2px  - hairline offsets only
4px  - tight internal gaps
8px  - default small gap
12px - compact form gap
16px - default component padding
24px - section gap
32px - major region gap
48px - page-level separation
```

Radius:

```text
4px  - inputs, badges, small controls
6px  - compact buttons, table rows
8px  - cards, modals, panels
12px - rare large sheets only
```

Avoid radii above 12px unless there is a specific reason.

Borders:

- Prefer `1px` borders over heavy shadows.
- Use subtle border contrast.
- Use stronger borders for focus, selected state, and destructive confirmation.

Elevation:

- Base surfaces should be flat.
- Modals may use one consistent shadow token.
- Dragged cards may temporarily elevate.
- Do not use random shadow values.

## Color Direction

Use a neutral-first palette with semantic accents.

Light mode:

```text
Background: #f7f8fa
Surface:    #ffffff
Surface 2:  #f1f3f5
Border:     #dfe3e8
Text:       #151922
Muted:      #68707d
```

Dark mode:

```text
Background: #0f1115
Surface:    #171a21
Surface 2:  #20242d
Border:     #2c313a
Text:       #eef1f5
Muted:      #9aa3af
```

Semantic accents:

```text
Primary:    #2563eb
AI/Agent:   #7c3aed
Review:     #9333ea
External:   #0891b2
Success:    #16a34a
Warning:    #d97706
Danger:     #dc2626
Blocked:    #b91c1c
Cancelled:  #6b7280
```

Rules:

- Do not let one hue dominate the whole app.
- Avoid large purple/blue gradients.
- Avoid beige, espresso, or warm brown dashboard themes.
- Use color for state and emphasis, not decoration.
- Pair every functional color with text or an icon.

Kanban stages:

- Todo: neutral.
- In Progress: blue.
- Review / Needs Review / Waiting External: violet or cyan.
- Done: green.
- Blocked: red.
- Cancelled: gray.

Stage columns should not be fully color-filled. Prefer a small dot, label, thin top border, or subtle badge.

## Typography

Recommended default stack:

```css
font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
```

Recommended monospace stack:

```css
font-family: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
```

Alternative editorial stack:

```text
Headings: IBM Plex Sans
Body:     Inter
Mono:     IBM Plex Mono or JetBrains Mono
```

Type scale:

```text
Page title:     24-28px / 600
Section title:  16-18px / 600
Card title:     14-16px / 600
Body:           14-15px / 400
Label:          12-13px / 500
Meta:           12px / mono
Button:         13-14px / 500
```

Rules:

- Body text should generally not be below 13px.
- Use tabular numbers for costs, timestamps, counters, and token counts.
- Avoid negative letter spacing.
- Long titles should wrap or clamp deliberately.
- Full text should be available in detail views or tooltips.

## Components

### Buttons

Button hierarchy:

- Primary: one per meaningful action group.
- Secondary: normal operational actions.
- Ghost: low-emphasis navigation and utility.
- Danger: destructive actions, separated spatially.

Rules:

- Avoid gradient buttons.
- Avoid pill-shaped buttons unless part of a segmented control.
- Icon-only buttons must have accessible labels and tooltips.
- Destructive buttons need confirmation.

### Forms

Rules:

- Use visible labels, not placeholder-only fields.
- Show errors next to the field.
- Use helper text for complex fields.
- Disable submit during async operations.
- Show saving/saved/error feedback.
- Put advanced task controls behind progressive disclosure.

Complex fields:

- Dependencies should use searchable checkbox picker with selected chips.
- Agent selection should show role/status where useful.
- Project-dependent fields should only show valid choices.

### Badges

Badges are for status, priority, runtime, context mode, and small metadata.

Rules:

- Keep badge text short.
- Avoid showing too many badges on cards.
- Use low-saturation backgrounds.
- Do not use badge color alone as meaning.

### Modals And Sheets

Desktop:

- Centered modal for task detail.
- Maximum width around `960px-1080px`.
- Internal scroll if content is long.
- Background overlay should be subtle.

Mobile:

- Full-screen sheet.
- Sticky header.
- Sticky bottom action area only when needed.

Rules:

- Escape closes non-destructive modals.
- Click outside may close only when no unsaved changes.
- Unsaved changes require confirmation.

### Tables And Timelines

Use tables for comparable structured data.
Use timelines for event history.

Rules:

- Timestamps, IDs, costs, token counts should align cleanly.
- Use monospaced numerals.
- Provide filtering before the log list becomes long.

## Motion

Motion should explain cause and effect.

Recommended durations:

```text
Hover / press:      80-120ms
Small transition:   120-180ms
Modal open:         160-220ms
Modal close:        100-160ms
Sidebar collapse:   160-220ms
Toast:              180-240ms
```

Rules:

- Animate transform and opacity, not width/height/top/left where possible.
- Do not block input during animation.
- Keep animations interruptible.
- Respect `prefers-reduced-motion`.
- Avoid decorative-only animation.

Useful motion:

- Card opens with subtle scale and fade.
- Sidebar collapse preserves spatial continuity.
- New logs/messages briefly highlight.
- Dragged task cards lift slightly.

Avoid:

- Bouncy spring everywhere.
- Long animated entrances.
- Animated gradients.
- Constant pulsing except for meaningful live/running state.

## Responsive Rules

Breakpoints:

```text
Mobile:  375px
Tablet:  768px
Desktop: 1024px
Wide:    1440px
```

Rules:

- No horizontal page scroll on mobile.
- Touch targets should be at least 44px high.
- Primary content comes before secondary metadata on mobile.
- Sidebar should not overlay content accidentally.
- Collapsed sidebar state should persist across navigation.
- Detail views should not extend outside the viewport.

Kanban mobile behavior:

- Prefer stage tabs or stage filter.
- Cards stack vertically.
- Detail opens full-screen.
- Drag-and-drop must have a non-drag alternative.

## Accessibility

Minimum requirements:

- Normal text contrast at least 4.5:1.
- Visible focus states.
- Keyboard navigation for all controls.
- Icon-only controls require `aria-label`.
- Modals trap focus and restore focus on close.
- Status is not communicated by color alone.
- Inputs have visible labels.
- Errors appear near the relevant field.

Accessibility is not optional for MegaCorps because agent operations can be destructive, costly, and stateful.

## Anti-Patterns To Avoid

Do not use:

- Big rounded cards everywhere.
- Gradient buttons.
- Full-screen decorative gradients.
- Glassmorphism.
- Floating orbs, bokeh blobs, or abstract AI backgrounds.
- Purple-blue AI template styling as the dominant look.
- Marketing-style hero sections inside the app.
- Card-inside-card layouts.
- Emoji as primary icons.
- Color-only state indicators.
- Full UUIDs on compact cards.
- Long unbounded chat pages.
- Logs as plain walls of text.
- Placeholder-only form labels.
- Destructive actions next to routine actions.
- Horizontal mobile Kanban as the only interaction.
- Loading states that only say `Loading...`.

## Product-Specific UX Constraints

### Agent Work Must Be Inspectable

Every task should make these visible or easily discoverable:

- Who owns it.
- Which agent/runtime is involved.
- Current stage.
- Whether it is waiting on review, external polling, or blocked.
- Cost so far.
- Retry count.
- Session/context mode.
- Parent and child task relationship.

### Context And Token Use Must Be Legible

Prompt/token debugging should not require reading raw logs first.

Task detail should summarize:

- `full_bootstrap` vs `adapter_session_delta`.
- Last prompt log.
- Token/cost totals.
- Adapter session ID when available.
- Whether context was resumed or rebuilt.

### Collaboration Must Be Visible

For collaboration-mode tasks, show:

- Delegation requirement.
- Direct subtasks.
- Which agents are participating.
- Parent chain.
- Child completion policy.

### External Waiting Must Be Understandable

For `waiting_on_external`, show:

- What external thing is being waited on.
- Next poll time.
- Poll interval.
- Last check result.
- Manual wake/retry action.

## Implementation Guardrails

When changing UI, check these before merging:

- Does this screen still work at 375px width?
- Are all primary actions visible and clearly ranked?
- Are destructive actions separated?
- Is loading/saving/error feedback present?
- Is there horizontal overflow?
- Are long titles and Chinese/English mixed text handled?
- Are logs/chats scroll-contained?
- Are status colors paired with text?
- Does the page still look calm and operational?
- Does anything look like a generic AI SaaS template?


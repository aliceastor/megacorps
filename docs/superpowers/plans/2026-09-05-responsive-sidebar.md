# Responsive Sidebar Implementation Plan

**Goal:** Keep narrow navigation in document flow and make collapsing actually hide it.

**Architecture:** AppShell owns persistent desktop expansion and transient narrow expansion separately. The 900px media query determines which toggle state applies; CSS owns positioning and visibility. Existing page content stays unchanged.

**Tech Stack:** Next.js, React, CSS, Playwright Chromium, node:test.

## One independently reviewable fix

- [x] Inspect the complete CSS cascade and AppShell. Confirm the late `.sidebar { position: fixed }` overrides the 900px rule, and current compact mode only removes labels.
- [x] Run the existing baseline: 455 tests pass.
- [x] Add `apps/web/e2e/sidebar.spec.ts` and `apps/web/playwright.config.ts`. Render the real `/help` route with API fixtures. Assert bounding boxes do not intersect, hidden navigation is absent, toggling pushes content, Escape and links close the menu, and resizing/reloading preserves only desktop preference.
- [x] Run `npm run test:e2e -w @megacorps/web` before production changes; preserve expected failures.
- [x] Update `apps/web/src/components/shell.tsx`: desktop state initialized consistently for hydration; load stored preference and matchMedia in an effect; maintain a separate closed-by-default mobile state; expose aria-expanded/controls; close on navigation and Escape.
- [x] Update `apps/web/src/app/globals.css`: remove the later redundant fixed declaration; reset narrow inset and compact header geometry; hide both navigation regions when narrow/closed; retain desktop offset/rail behavior.
- [x] Run the browser suite green, all unit tests, typecheck and production build. Inspect 390px open/closed and desktop screenshots.
- [x] Add browser checks to CI using Playwright's Chromium installation and the built Next server. Review the final diff before integrating the fix.

No production data mutations are needed for UI verification. Test output and browser traces are gitignored.

Verification: 455 unit tests, workspace typecheck/build, and 10 Chromium tests against both dev and production Next servers pass. Reviewed 390px closed/open and 1280px desktop screenshots. Independent review found no remaining issues after the Escape focus/dialog regression was addressed.

Browser test server setup follows https://playwright.dev/docs/test-webserver and CI setup follows https://playwright.dev/docs/ci-intro.

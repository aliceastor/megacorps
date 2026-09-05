# Responsive sidebar correction

User approved the inline menu on 2026-09-05: at widths up to 900px, expanding navigation pushes the main page down; collapsing hides navigation while retaining the brand and toggle. No overlay or backdrop.

- Desktop keeps the existing 252px expanded / 84px icon rail and its stored preference.
- Narrow layouts start closed independently of that preference. Toggling the narrow menu never overwrites the desktop preference.
- Navigation and Escape close the narrow menu. Escape restores focus to the toggle. Hidden navigation cannot receive keyboard focus.
- Crossing the breakpoint resets the temporary narrow menu state. A resize back to desktop restores the desktop preference.
- Remove the late unconditional fixed-position override that defeats the existing responsive layout. Keep the correction within AppShell and its CSS.
- Verify rendered geometry and user actions in Chromium at 320, 390, 768, 900, 901 and 1280px, plus existing unit tests, typecheck and production build. API fixtures keep browser regression tests independent of production accounts and data.

The alternative modal drawer was declined. There are no new platform API, container, or runtime configuration changes in this fix.

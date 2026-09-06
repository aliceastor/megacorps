import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { productFixture, settlePage, waitForProductPage } from './product-fixture';

const pages = ['/dashboard', '/companies', '/departments', '/departments/o-chart', '/positions', '/agents', '/projects', '/knowledge', '/kanban', '/chat', '/logs', '/budget', '/cron', '/settings', '/trash', '/admin', '/help'];

for (const width of [390, 1158, 1440]) for (const populated of [false, true]) test(`product pages ${width}px ${populated ? 'populated long content' : 'empty companyless'}`, async ({ page }, info) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width, height: 900 });
  const state = await productFixture(page, populated);
  const measurements: unknown[] = [];
  for (const path of pages) {
    await test.step(path, async () => {
      const readOffset = state.reads.length;
      await page.goto(path);
      await waitForProductPage(page, state, path, populated, readOffset);
      for (const open of [false, true]) {
        const toggle = page.getByRole('button', { name: 'Toggle sidebar', exact: true });
        if (await toggle.getAttribute('aria-expanded') !== String(open)) await toggle.click();
        await settlePage(page);
        const geometry = await page.evaluate(() => {
          const violations: string[] = [];
          const internal: string[] = [];
          const scrollChecks: { node: HTMLElement; scroller: HTMLElement }[] = [];
          const label = (node: HTMLElement) => node.getAttribute('aria-label') || node.closest('label')?.textContent?.slice(0, 55) || node.textContent?.trim().slice(0, 55) || node.tagName;
          for (const node of document.querySelectorAll<HTMLElement>('.content-area input,.content-area select,.content-area textarea,.content-area button,.topbar button')) {
            if (!node.checkVisibility()) continue;
            const box = node.getBoundingClientRect();
            const scroller = node.closest<HTMLElement>('.company-o-scroll,.table-wrap,.tab-row,.kanban-columns');
            if (scroller && /auto|scroll/.test(getComputedStyle(scroller).overflowX)) {
              internal.push(label(node));
              scrollChecks.push({ node, scroller });
              continue;
            }
            if (box.left < -1 || box.right > innerWidth + 1) violations.push(`viewport: ${label(node)}`);
            for (let parent = node.parentElement; parent; parent = parent.parentElement) {
              const css = getComputedStyle(parent);
              if (!/hidden|clip|auto|scroll/.test(css.overflowX)) continue;
              const frame = parent.getBoundingClientRect(), left = frame.left + parent.clientLeft;
              if (box.left < left - 1 || box.right > left + parent.clientWidth + 1) violations.push(`clipped by ${parent.className}: ${label(node)}`);
            }
          }
          if (document.documentElement.scrollWidth > innerWidth + 1) violations.push('document horizontal overflow');
          // Measure ordinary controls before moving any intentional scroller.
          // Scroll only that region; scrollIntoView can move the entire page and
          // create false viewport failures for the next sidebar measurement.
          for (const { node, scroller } of scrollChecks) {
            const original = scroller.scrollLeft, box = node.getBoundingClientRect(), frame = scroller.getBoundingClientRect();
            const left = frame.left + scroller.clientLeft;
            scroller.scrollTo({ left: original + (box.left < left ? box.left - left : Math.max(0, box.right - left - scroller.clientWidth)), behavior: 'instant' });
            if (!(node as HTMLButtonElement).disabled) node.focus({ preventScroll: true });
            const visible = node.getBoundingClientRect();
            if (visible.left < left - 1 || visible.right > left + scroller.clientWidth + 1) violations.push(`unreachable internal control: ${label(node)}`);
            scroller.scrollTo({ left: original, behavior: 'instant' });
          }
          window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
          document.querySelector('main')?.scrollTo({ left: 0, top: 0, behavior: 'instant' });
          return { width: innerWidth, documentWidth: document.documentElement.scrollWidth, violations, internalControls: internal.length };
        });
        measurements.push({ path, open, ...geometry });
        writeFileSync(info.outputPath('product-geometry.json'), JSON.stringify(measurements, null, 2));
        expect.soft(geometry.violations, `${path}, sidebar=${open}`).toEqual([]);
        if (geometry.violations.length) await page.screenshot({ path: info.outputPath(`${path.replaceAll('/', '_')}-${open}.png`) });
      }
      expect.soft(state.unexpected, `${path} exact fixture requests`).toEqual([]);
      expect.soft(state.errors, `${path} page errors`).toEqual([]);
      expect.soft(state.failed, `${path} transport failures`).toEqual([]);
    });
  }
  writeFileSync(info.outputPath('product-geometry.json'), JSON.stringify(measurements, null, 2));
});

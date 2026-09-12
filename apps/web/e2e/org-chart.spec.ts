import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { fixture } from './org-chart-fixture';

async function geometry(page: Page) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  let previous = '', samples = 0;
  await expect.poll(async () => {
    const value = await page.locator('[data-org-agent]').evaluateAll(nodes => JSON.stringify(nodes.map(n => { const r = n.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })));
    samples = previous === value ? samples + 1 : 0; previous = value; return samples;
  }, { intervals: [100] }).toBeGreaterThanOrEqual(3);
  return page.evaluate(() => {
    const rect = (e: Element) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    const nodes = [...document.querySelectorAll<HTMLElement>('[data-org-agent]')].map(e => ({ id: e.dataset.orgAgent!, rank: e.dataset.rank === '' ? null : Number(e.dataset.rank), ...rect(e) }));
    const groups = [...document.querySelectorAll<HTMLElement>('[data-org-group]')].map(e => ({ id: e.dataset.orgGroup!, memberIds: JSON.parse(e.dataset.members!), ...rect(e) }));
    const edges = [...document.querySelectorAll<SVGPathElement>('path[data-org-edge]')].map(e => {
      const path = e.getAttribute('d')!, matrix = e.getScreenCTM()!;
      const values = path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      const points = [];
      for (let i = 0; i < values.length; i += 2) { const p = new DOMPoint(values[i], values[i + 1]).matrixTransform(matrix); points.push({ x: p.x, y: p.y }); }
      return { id: e.dataset.orgEdge!, sourceId: e.dataset.source!, targetId: e.dataset.target!, path, matrix: { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, e: matrix.e, f: matrix.f }, strokeWidth: parseFloat(getComputedStyle(e).strokeWidth), points };
    });
    const departmentEdges = [...document.querySelectorAll<SVGPathElement>('path[data-org-department-edge]')].map(e => {
      const path = e.getAttribute('d')!, matrix = e.getScreenCTM()!, values = path.match(/-?\d+(?:\.\d+)?/g)!.map(Number), points = [];
      for (let i = 0; i < values.length; i += 2) { const p = new DOMPoint(values[i], values[i + 1]).matrixTransform(matrix); points.push({ x: p.x, y: p.y }); }
      return { id: e.dataset.orgDepartmentEdge!, sourceId: e.dataset.source!, targetGroupId: e.dataset.targetGroup!, path, points };
    });
    const scroll = document.querySelector<HTMLElement>('.company-o-scroll')!;
    return { nodes, groups, edges, departmentEdges, documentWidth: document.documentElement.scrollWidth, viewport: innerWidth, sidebarExpanded: document.querySelector('[aria-label="Toggle sidebar"]')?.getAttribute('aria-expanded'), scroll: { left: scroll.scrollLeft, top: scroll.scrollTop, width: scroll.clientWidth, height: scroll.clientHeight, scrollWidth: scroll.scrollWidth, scrollHeight: scroll.scrollHeight }, documentScroll: { x: scrollX, y: scrollY } };
  });
}

function audit(g: Awaited<ReturnType<typeof geometry>>) {
  expect(g.documentWidth).toBeLessThanOrEqual(g.viewport);
  expect(new Set(g.nodes.map(n => n.id)).size).toBe(10);
  expect(g.nodes).toHaveLength(10);
  expect(g.groups).toHaveLength(4);
  const boss = g.nodes.find(n => n.id === 'boss')!;
  const laneLeft = Math.min(...g.groups.map(group => group.x));
  const laneRight = Math.max(...g.groups.map(group => group.x + group.width));
  expect(boss.x + boss.width / 2).toBeCloseTo((laneLeft + laneRight) / 2, 1);
  expect(g.groups.every(group => group.y >= boss.y + boss.height + 10)).toBe(true);
  expect(g.groups.find(group => group.id === '__unassigned__')!.memberIds).toEqual(['unassigned']);
  expect(g.departmentEdges.map(edge => `${edge.sourceId}:${edge.targetGroupId}`).sort()).toEqual(['boss:engineering', 'boss:operations', 'boss:product']);
  for (const edge of g.departmentEdges) {
    const group = g.groups.find(candidate => candidate.id === edge.targetGroupId)!;
    expect(edge.points.at(-1)!.x).toBeCloseTo(group.x + group.width / 2, 1);
    expect(edge.points.at(-1)!.y).toBeCloseTo(group.y, 1);
  }
  for (const a of g.nodes) for (const b of g.nodes) {
    if (a.rank != null && b.rank != null) {
      if (a.rank < b.rank) expect(a.y).toBeLessThan(b.y);
      if (a.rank === b.rank) expect(a.y).toBeCloseTo(b.y, 1);
    }
  }
  for (const group of g.groups) for (const id of group.memberIds) {
    const n = g.nodes.find(n => n.id === id)!;
    expect(n.x).toBeGreaterThanOrEqual(group.x); expect(n.y).toBeGreaterThanOrEqual(group.y);
    expect(n.x + n.width).toBeLessThanOrEqual(group.x + group.width + 0.1); expect(n.y + n.height).toBeLessThanOrEqual(group.y + group.height + 0.1);
  }
  expect(g.edges).toHaveLength(7);
  expect(g.edges.map(e => `${e.sourceId}:${e.targetId}`).sort()).toEqual(['boss:manager', 'manager:analyst', 'manager:peer', 'boss:intervening', 'manager:researcher', 'cycle-b:cycle-a', 'cycle-a:cycle-b'].sort());
  for(let i=0;i<g.edges.length;i++) for(let j=i+1;j<g.edges.length;j++) {
    const one=g.edges[i]!,two=g.edges[j]!;if(one.sourceId===two.sourceId)continue;
    for(let a=1;a<one.points.length;a++) for(let b=1;b<two.points.length;b++) {
      const p=one.points[a-1]!,q=one.points[a]!,r=two.points[b-1]!,s=two.points[b]!;
      const shared=p.x===q.x&&r.x===s.x&&Math.abs(p.x-r.x)<.1 ? Math.min(Math.max(p.y,q.y),Math.max(r.y,s.y))-Math.max(Math.min(p.y,q.y),Math.min(r.y,s.y)) : p.y===q.y&&r.y===s.y&&Math.abs(p.y-r.y)<.1 ? Math.min(Math.max(p.x,q.x),Math.max(r.x,s.x))-Math.max(Math.min(p.x,q.x),Math.min(r.x,s.x)) : 0;
      expect(shared, `${one.id} and ${two.id} must not share a reporting bus`).toBeLessThanOrEqual(.1);
    }
  }
  for (const edge of g.edges) {
    const source = g.nodes.find(n => n.id === edge.sourceId)!, target = g.nodes.find(n => n.id === edge.targetId)!;
    expect(edge.path).not.toMatch(/[ACHQSTVZ]/i);
    expect(edge.points[0]!.x).toBeCloseTo(source.x + source.width / 2, 1); expect(edge.points[0]!.y).toBeCloseTo(source.y + source.height, 1);
    expect(edge.points.at(-1)!.x).toBeCloseTo(target.x + target.width / 2, 1); expect(edge.points.at(-1)!.y).toBeCloseTo(target.y, 1);
    for (let i = 1; i < edge.points.length; i++) {
      const a = edge.points[i - 1]!, b = edge.points[i]!;
      expect(a.x === b.x || a.y === b.y).toBe(true);
      for (const n of g.nodes) {
        if (n.id === source.id || n.id === target.id) {
          const inside = a.y === b.y ? a.y > n.y + .1 && a.y < n.y + n.height - .1 && Math.min(Math.max(a.x,b.x),n.x+n.width) > Math.max(Math.min(a.x,b.x),n.x)+.1 : a.x > n.x+.1 && a.x<n.x+n.width-.1 && Math.min(Math.max(a.y,b.y),n.y+n.height)>Math.max(Math.min(a.y,b.y),n.y)+.1;
          expect(inside, `edge ${edge.id} traverses endpoint ${n.id}`).toBe(false); continue;
        }
        const dx = Math.max(n.x - Math.max(a.x,b.x), Math.min(a.x,b.x) - n.x - n.width, 0);
        const dy = Math.max(n.y - Math.max(a.y,b.y), Math.min(a.y,b.y) - n.y - n.height, 0);
        expect(Math.hypot(dx, dy) - edge.strokeWidth/2, `${edge.id} clearance from ${n.id}`).toBeGreaterThanOrEqual(9.9);
      }
    }
  }
}

for (const width of [390, 900, 1158, 1440]) test(`rank organization geometry at ${width}px in both sidebar states`, async ({ page }, info) => {
  await fixture(page, width);
  await expect(page.locator('.company-o-card')).toHaveCount(10);
  for (const state of ['open', 'closed']) {
    const sidebar = page.getByRole('button', { name: 'Toggle sidebar' });
    const desired = state === 'open' ? 'true' : 'false';
    if (await sidebar.getAttribute('aria-expanded') !== desired) await sidebar.click();
    await expect(sidebar).toHaveAttribute('aria-expanded', desired);
    await page.locator('.company-o-scroll').evaluate(e => { e.scrollLeft=0; e.scrollTop=0; });
    await page.evaluate(() => scrollTo(0,0));
    const measured = await geometry(page); audit(measured);
    expect(measured.sidebarExpanded).toBe(desired);
    writeFileSync(info.outputPath(`org-${width}-${state}-geometry.json`), JSON.stringify(measured, null, 2));
    await expect(page.getByText('Unassigned department', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Legacy cycle A/ })).toHaveCount(1);
    await page.screenshot({ path: info.outputPath(`org-${width}-${state}.png`), fullPage: true });
    const scroll = page.locator('.company-o-scroll');
    await scroll.evaluate(e => { e.scrollLeft = e.scrollWidth; e.scrollTop = e.scrollHeight; });
    expect(await scroll.evaluate(e => e.scrollWidth <= e.clientWidth || e.scrollLeft > 0)).toBe(true);
    await page.locator('[data-org-agent="manager"]').evaluate(e => e.scrollIntoView({ block: 'center', inline: 'center' }));
    const scrolled = await geometry(page); audit(scrolled);
    writeFileSync(info.outputPath(`org-${width}-${state}-scrolled.json`), JSON.stringify(scrolled, null, 2));
    await page.screenshot({ path: info.outputPath(`org-${width}-${state}-scrolled.png`), fullPage: true });
    await page.getByRole('button', { name: /Product analyst/ }).click();
    const editor = page.locator('.company-o-details');
    await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
    expect(await editor.locator('input,select,button').evaluateAll(es => es.every(e => { const r=e.getBoundingClientRect(); return r.x>=0 && r.right<=innerWidth; }))).toBe(true);
  }
});

test('organization paths settle again after live viewport and card text-size changes', async ({ page }, info) => {
  await fixture(page, 1440);
  await expect(page.locator('.company-o-card')).toHaveCount(10);
  const before = await geometry(page); audit(before);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.locator('.company-o-copy b').evaluateAll(nodes => nodes.forEach(node => { (node as HTMLElement).style.fontSize = '22px'; }));
  const resized = await geometry(page); audit(resized);
  expect(resized.nodes.find(n => n.id === 'analyst')!.height).toBeGreaterThan(before.nodes.find(n => n.id === 'analyst')!.height);
  writeFileSync(info.outputPath('org-live-resize-geometry.json'), JSON.stringify(resized, null, 2));
  await page.screenshot({ path: info.outputPath('org-live-resize.png'), fullPage: true });
});

test('Alice CTO Ribel Digby reporting links stay local across department boxes', async ({ page }, info) => {
  await fixture(page, 1440);
  const companyId = 'company-chart';
  const positions = [
    { id: 'boss-position', rank: 0, isCompanyBoss: true },
    { id: 'cto-position', rank: 1, isDepartmentHead: true, defaultDepartmentId: 'engineering' },
    { id: 'senior-position', rank: 2, defaultDepartmentId: 'engineering' },
    { id: 'intern-position', rank: 9, defaultDepartmentId: 'engineering' },
  ].map(position => ({ companyId, name: position.id, slug: position.id, ...position }));
  const agents = [
    { id: 'alice', name: 'Alice Astor', positionId: 'boss-position' },
    { id: 'cto', name: 'CTO Vale', positionId: 'cto-position', departmentId: 'engineering', bossId: 'alice' },
    { id: 'ribel', name: 'Ribel', positionId: 'senior-position', departmentId: 'engineering', bossId: 'cto' },
    { id: 'digby', name: 'Digby', positionId: 'intern-position', departmentId: 'engineering', bossId: 'ribel' },
  ].map(agent => ({ companyId, slug: agent.id, role: 'custom', adapterType: 'a2a', isActive: true, ...agent }));
  await page.route('**/api/proxy/api/positions', route => route.fulfill({ json: positions }));
  await page.route('**/api/proxy/api/agents', route => route.fulfill({ json: agents }));
  await page.route('**/api/proxy/api/departments', route => route.fulfill({ json: [
    { id: 'engineering', companyId, name: 'Engineering', slug: 'engineering', headAgentId: 'cto' },
    { id: 'operations', companyId, name: 'Operations', slug: 'operations', headAgentId: null },
    { id: 'product', companyId, name: 'Product', slug: 'product', headAgentId: null },
  ] }));
  await page.reload();
  await expect(page.locator('[data-org-agent]')).toHaveCount(4);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const g = await geometry(page);
    expect(g.edges.map(edge => edge.id).sort()).toEqual(['alice:cto', 'cto:ribel', 'ribel:digby']);
    expect(g.departmentEdges).toHaveLength(3);
    for (const edge of g.edges) {
      const start = edge.points[0]!, end = edge.points.at(-1)!;
      const length = edge.points.slice(1).reduce((sum, point, index) => sum + Math.abs(point.x-edge.points[index]!.x) + Math.abs(point.y-edge.points[index]!.y), 0);
      expect(length, `${edge.id} must avoid redundant outer loops`).toBeCloseTo(Math.abs(start.x-end.x)+Math.abs(start.y-end.y), 1);
      if (edge.sourceId !== 'alice') expect(edge.points).toHaveLength(2);
    }
    writeFileSync(info.outputPath(`org-aligned-chain-${width}.json`), JSON.stringify(g, null, 2));
    await page.screenshot({ path: info.outputPath(`org-aligned-chain-${width}.png`), fullPage: true });
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';

// A missing new layout is an assertion failure, not a masked import failure.
// No fallback implementation is used: every fixture requires the real export.
async function layout(input: any): Promise<any> {
  const path = new URL('./org-layout.ts', import.meta.url).href;
  const module = await import(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
    throw error;
  });
  assert.equal(typeof module.layoutOrgChart, 'function', 'The pure measured Rank layout must exist before it can render every fixture agent');
  return module.layoutOrgChart(input);
}

const departments = [{ id: 'engineering', name: 'Engineering' }, { id: 'research', name: 'Research' }];
const nodes = [
  { id: 'boss', rank: 0, isCompanyBoss: true },
  { id: 'manager', departmentId: 'engineering', rank: 100, bossId: 'boss' },
  { id: 'report', departmentId: 'engineering', rank: 10, bossId: 'manager' },
  { id: 'peer', departmentId: 'engineering', rank: 10, bossId: 'manager' },
  { id: 'intervening', departmentId: 'engineering', rank: 50, bossId: 'boss' },
  { id: 'researcher', departmentId: 'research', rank: 10, bossId: 'manager' },
  { id: 'cycle-a', departmentId: 'research', rank: 20, bossId: 'cycle-b' },
  { id: 'cycle-b', departmentId: 'research', rank: 60, bossId: 'cycle-a' },
  { id: 'orphan', departmentId: 'research', rank: 30, bossId: 'missing' },
  { id: 'unassigned', departmentId: 'unknown', rank: null },
].map((n, i) => ({ name: `Measured name ${i}`, width: 220 + (i % 3) * 17, height: i === 2 ? 187 : 93 + i * 2, ...n }));

test('company Boss is centered above department lanes while stored reporting edges remain authoritative', async () => {
  const result = await layout({
    departments: [
      { id: 'engineering', name: 'Engineering', headAgentId: 'engineering-head' },
      { id: 'legacy', name: 'Legacy', headAgentId: 'legacy-head' },
      { id: 'operations', name: 'Operations' },
      { id: 'product', name: 'Product', headAgentId: 'product-head' },
    ],
    nodes: [
      { id: 'boss', name: 'Alice Astor', rank: 0, isCompanyBoss: true, width: 264, height: 128 },
      { id: 'engineering-head', name: 'CTO Vale', departmentId: 'engineering', rank: 10, bossId: 'boss', width: 264, height: 128 },
      { id: 'legacy-head', name: 'Legacy head', departmentId: 'legacy', rank: 10, bossId: 'missing-manager', width: 264, height: 128 },
      { id: 'product-head', name: 'David Alden', departmentId: 'product', rank: 10, width: 264, height: 128 },
    ],
  });
  const boss = result.nodes.find((node: any) => node.id === 'boss');
  const laneLeft = Math.min(...result.groups.map((group: any) => group.x));
  const laneRight = Math.max(...result.groups.map((group: any) => group.x + group.width));
  assert.equal(boss.groupId, '__company_leadership__');
  assert.equal(boss.x + boss.width / 2, (laneLeft + laneRight) / 2);
  assert.ok(result.groups.every((group: any) => group.y > boss.y + boss.height));
  assert.deepEqual(result.groups.map((group: any) => group.id), ['engineering', 'legacy', 'operations', 'product']);
  assert.deepEqual(result.edges.map((edge: any) => `${edge.sourceId}:${edge.targetId}`).sort(), ['boss:engineering-head']);
  assert.match(result.nodes.find((node: any) => node.id === 'legacy-head').relationshipIssue, /unavailable/i);
  assert.equal(result.groups.find((group: any) => group.id === 'operations').memberIds.length, 0, 'Empty departments remain visible');
});

test('company Boss authority is never inferred from name or numeric rank and ordinary unassigned members keep their lane', async () => {
  const result = await layout({
    departments: [{ id: 'engineering', name: 'Engineering' }],
    nodes: [
      { id: 'named-ceo', name: 'CEO', rank: 0, width: 220, height: 100 },
      { id: 'unassigned', name: 'Colleague', rank: null, width: 220, height: 100 },
    ],
  });
  const unassigned = result.groups.find((group: any) => group.id === '__unassigned__');
  assert.deepEqual(unassigned.memberIds.sort(), ['named-ceo', 'unassigned']);
  assert.ok(result.nodes.every((node: any) => node.groupId === '__unassigned__'));
});

test('company leadership connects to every real department, including two headless lanes, without inventing agent reporting', async () => {
  const result = await layout({
    departments: [
      { id: 'engineering', name: 'Engineering', headAgentId: 'engineering-head' },
      { id: 'operations', name: 'Operations' },
      { id: 'product', name: 'Product' },
    ],
    nodes: [
      { id: 'boss', name: 'Boss', isCompanyBoss: true, rank: 0, width: 220, height: 100 },
      { id: 'engineering-head', name: 'CTO', departmentId: 'engineering', bossId: 'boss', rank: 10, width: 220, height: 100 },
      { id: 'product-member', name: 'Product member', departmentId: 'product', rank: 10, width: 220, height: 100 },
    ],
  });
  assert.deepEqual(result.departmentEdges.map((edge: any) => `${edge.sourceId}:${edge.targetGroupId}`).sort(), [
    'boss:engineering', 'boss:operations', 'boss:product',
  ]);
  assert.deepEqual(result.edges.map((edge: any) => `${edge.sourceId}:${edge.targetId}`), ['boss:engineering-head']);
  for (const edge of result.departmentEdges) {
    const group = result.groups.find((candidate: any) => candidate.id === edge.targetGroupId);
    assert.deepEqual(edge.points.at(-1), { x: group.x + group.width / 2, y: group.y });
  }
});

test('Boss sharing a department rank routes reporting edges above department cards', async () => {
  const result = await layout({
    departments: [{ id: 'engineering', name: 'Engineering' }],
    nodes: [
      { id: 'boss', name: 'Boss', isCompanyBoss: true, rank: 10, width: 220, height: 100 },
      { id: 'head', name: 'Head', departmentId: 'engineering', bossId: 'boss', rank: 10, width: 220, height: 100 },
    ],
  });
  const edge = result.edges[0];
  const firstHorizontal = edge.points.slice(1).find((point: any, i: number) => point.y === edge.points[i].y && point.x !== edge.points[i].x);
  if (firstHorizontal) assert.ok(firstHorizontal.y < result.groups[0].y, 'Boss departure stays above department groups even when ranks coincide');
  else assert.equal(edge.points.length, 2, 'Aligned Boss and head connect directly');
});

test('measured rank rows contain every agent once, including orphan and disconnected cycle beside normal roots', async () => {
  const result = await layout({ nodes, departments });
  assert.deepEqual(result.nodes.map((n: any) => n.id).sort(), nodes.map(n => n.id).sort());
  assert.equal(new Set(result.nodes.map((n: any) => n.id)).size, nodes.length);
  for (const a of result.nodes) for (const b of result.nodes) {
    if (a.rank != null && b.rank != null) {
      if (a.rank < b.rank) assert.ok(a.y < b.y, `${a.id} must be above ${b.id} by numeric Rank`);
      if (a.rank === b.rank) assert.equal(a.y, b.y);
    }
  }
  assert.equal(result.groups.length, 3);
  for (const group of result.groups) for (const id of group.memberIds) {
    const n = result.nodes.find((n: any) => n.id === id);
    assert.ok(n.x >= group.x && n.y >= group.y && n.x+n.width <= group.x+group.width && n.y+n.height <= group.y+group.height);
  }
  assert.match(result.nodes.find((n: any) => n.id === 'cycle-a').relationshipIssue, /cycle/i);
  assert.match(result.nodes.find((n: any) => n.id === 'orphan').relationshipIssue, /unavailable/i);
  assert.deepEqual(await layout({ nodes: [...nodes].reverse(), departments: [...departments].reverse() }), result, 'Input order does not alter placement or edge order');
});

test('inverted and sibling/cross-department reporting paths use bottom/top ports with ten visible pixels of clearance, also after resize', async () => {
  for (const scale of [1, 0.78, 1.35]) {
    const resized = nodes.map(n => ({ ...n, width: Math.round(n.width*scale), height: Math.round(n.height/scale) }));
    const result = await layout({ nodes: resized, departments });
    assert.equal(result.edges.length, 7);
    for (const edge of result.edges) {
      const source = result.nodes.find((n: any) => n.id === edge.sourceId), target = result.nodes.find((n: any) => n.id === edge.targetId);
      assert.deepEqual(edge.points[0], { x: source.x+source.width/2, y: source.y+source.height });
      assert.deepEqual(edge.points.at(-1), { x: target.x+target.width/2, y: target.y });
      assert.doesNotMatch(edge.path, /[ACHQSTVZ]/i);
      for (let i=1; i<edge.points.length; i++) {
        const a=edge.points[i-1], b=edge.points[i];
        assert.ok(a.x===b.x || a.y===b.y, 'All path segments are orthogonal');
        for (const n of result.nodes) {
          if (n.id===source.id || n.id===target.id) {
            const inside=a.y===b.y ? a.y>n.y && a.y<n.y+n.height && Math.min(Math.max(a.x,b.x),n.x+n.width)>Math.max(Math.min(a.x,b.x),n.x) : a.x>n.x && a.x<n.x+n.width && Math.min(Math.max(a.y,b.y),n.y+n.height)>Math.max(Math.min(a.y,b.y),n.y);
            assert.equal(inside,false,`${edge.id} cannot traverse an endpoint card`);
          } else {
            const dx=Math.max(n.x-Math.max(a.x,b.x),Math.min(a.x,b.x)-n.x-n.width,0);
            const dy=Math.max(n.y-Math.max(a.y,b.y),Math.min(a.y,b.y)-n.y-n.height,0);
            assert.ok(Math.hypot(dx,dy)-edge.strokeWidth/2>=10,`${edge.id} must clear unrelated ${n.id} by 10px including stroke`);
          }
        }
      }
    }
  }
});

test('different managers have distinct gutter lanes instead of an ambiguous shared reporting bus', async () => {
  const result=await layout({nodes,departments});
  const overlaps:string[]=[];
  for(let i=0;i<result.edges.length;i++) for(let j=i+1;j<result.edges.length;j++) {
    const one=result.edges[i],two=result.edges[j]; if(one.sourceId===two.sourceId)continue;
    for(let a=1;a<one.points.length;a++) for(let b=1;b<two.points.length;b++) {
      const p=one.points[a-1],q=one.points[a],r=two.points[b-1],s=two.points[b];
      const shared=p.x===q.x&&r.x===s.x&&p.x===r.x ? Math.min(Math.max(p.y,q.y),Math.max(r.y,s.y))-Math.max(Math.min(p.y,q.y),Math.min(r.y,s.y)) : p.y===q.y&&r.y===s.y&&p.y===r.y ? Math.min(Math.max(p.x,q.x),Math.max(r.x,s.x))-Math.max(Math.min(p.x,q.x),Math.min(r.x,s.x)) : 0;
      if(shared>.1) overlaps.push(`${one.id} / ${two.id}: ${shared}px`);
    }
  }
  assert.deepEqual(overlaps,[], 'Different-source edges must not look like the same reporting bus');
});

test('a wide equal-rank legacy cycle preserves all nodes while giving every manager a route', async () => {
  const peers=Array.from({length:12},(_,i)=>({id:`n${i}`,name:`Node ${i}`,departmentId:i%2?'a':'b',rank:10,width:240,height:100,bossId:i?`n${i-1}`:'n11'}));
  const result=await layout({nodes:peers,departments:[{id:'a',name:'A'},{id:'b',name:'B'}]});
  assert.equal(result.nodes.length,12);assert.equal(result.edges.length,12);
});

test('Alice CTO Ribel Digby chain uses short local links beside empty departments', async () => {
  for (const width of [220, 264, 340]) {
    const result = await layout({
      departments: [{ id: 'engineering', name: 'Engineering' }, { id: 'operations', name: 'Operations' }, { id: 'product', name: 'Product' }],
      nodes: [
        { id: 'alice', name: 'Alice', rank: 0, isCompanyBoss: true },
        { id: 'cto', name: 'CTO Vale', rank: 1, departmentId: 'engineering', bossId: 'alice' },
        { id: 'ribel', name: 'Ribel', rank: 2, departmentId: 'engineering', bossId: 'cto' },
        { id: 'digby', name: 'Digby', rank: 9, departmentId: 'engineering', bossId: 'ribel' },
      ].map(node => ({ ...node, width, height: 128 })),
    });
    assert.equal(result.edges.length, 3);
    for (const edge of result.edges) {
      const start = edge.points[0], end = edge.points.at(-1);
      const length = edge.points.slice(1).reduce((sum: number, point: any, index: number) => sum + Math.abs(point.x-edge.points[index].x) + Math.abs(point.y-edge.points[index].y), 0);
      assert.equal(length, Math.abs(start.x-end.x)+Math.abs(start.y-end.y), `${edge.id} must take a shortest unobstructed route`);
      if (edge.sourceId !== 'alice') assert.equal(edge.points.length, 2, `${edge.id} must be straight down the aligned chain`);
    }
    assert.equal(result.departmentEdges.length, 3);
  }
});

test('company-direct staff are grouped outside departments with their real reporting edges', async () => {
  const result = await layout({ departments: [{ id: 'engineering', name: 'Engineering' }], nodes: [
    { id: 'boss', name: 'Boss', rank: 0, isCompanyBoss: true, width: 220, height: 100 },
    { id: 'director', name: 'Director', rank: 2, isCompanyLeadership: true, bossId: 'boss', width: 220, height: 100 },
    { id: 'advisor', name: 'Advisor', rank: 3, isCompanyLeadership: true, bossId: 'director', width: 220, height: 100 },
    { id: 'head', name: 'Head', rank: 1, departmentId: 'engineering', bossId: 'boss', width: 220, height: 100 },
  ] });
  assert.equal(result.nodes.find((node: any) => node.id === 'director').groupId, '__company_leadership__');
  assert.equal(result.nodes.find((node: any) => node.id === 'advisor').groupId, '__company_leadership__');
  assert.ok(!result.groups.some((group: any) => group.id === '__unassigned__'));
  assert.deepEqual(result.edges.map((edge: any) => edge.id).sort(), ['boss:director', 'boss:head', 'director:advisor']);
  for (const node of result.nodes.filter((node: any) => node.isCompanyLeadership)) for (const group of result.groups) assert.ok(node.x >= group.x + group.width || node.x + node.width <= group.x);
});

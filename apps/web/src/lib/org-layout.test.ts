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
  { id: 'boss', rank: 0 },
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

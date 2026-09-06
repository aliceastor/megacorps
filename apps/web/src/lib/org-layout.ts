export type OrgPoint = { x: number; y: number };
export type OrgRect = OrgPoint & { width: number; height: number };
export type OrgLayoutInput = {
  id: string; name: string; departmentId?: string | null; bossId?: string | null;
  rank?: number | null; width: number; height: number;
};
export type OrgNode = OrgLayoutInput & OrgRect & { rank: number | null; groupId: string; relationshipIssue?: string };
export type OrgGroup = OrgRect & { id: string; name: string; memberIds: string[] };
export type OrgEdge = { id: string; sourceId: string; targetId: string; points: OrgPoint[]; path: string; strokeWidth: number };

const CLEARANCE = 16; // 15 visible pixels with a 2px stroke, above the 10px contract.
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const rankOf = (n: OrgLayoutInput) => typeof n.rank === 'number' && Number.isFinite(n.rank) ? n.rank : null;

/** All cards occupy global numeric-rank bands. Reporting links never determine
 * placement or membership; malformed legacy graphs therefore cannot hide nodes. */
export function layoutOrgChart(input: { nodes: OrgLayoutInput[]; departments: { id: string; name: string }[] }) {
  const source = [...input.nodes].sort((a,b) => compare(a.id,b.id));
  const departments = [...input.departments].sort((a,b) => compare(a.name,b.name) || compare(a.id,b.id));
  const departmentIds = new Set(departments.map(d => d.id));
  const ids = new Set(source.map(n => n.id));
  const managers = [...new Set(source.filter(n => n.bossId && ids.has(n.bossId)).map(n => n.bossId!))].sort(compare);
  const laneMargin = new Map(managers.map((id,index) => [id,CLEARANCE+index*8]));
  const maxMargin = CLEARANCE+Math.max(0,managers.length-1)*8;
  const padding = 32, columnGap = 48;
  const groupId = (n: OrgLayoutInput) => n.departmentId && departmentIds.has(n.departmentId) ? n.departmentId : '__unassigned__';
  if (source.some(n => groupId(n) === '__unassigned__')) departments.push({ id: '__unassigned__', name: 'Unassigned department' });
  const ranks = [...new Set(source.map(rankOf))].sort((a,b) => a===null ? 1 : b===null ? -1 : a-b);
  const bands = new Map<number | null, { y: number; height: number }>();
  let y = maxMargin+56;
  for (const rank of ranks) {
    const height = Math.max(1, ...source.filter(n => rankOf(n) === rank).map(n => n.height));
    bands.set(rank, { y, height }); y += height + maxMargin*2+32;
  }
  const height = Math.max(160, y - 40);
  const nodes: OrgNode[] = [], groups: OrgGroup[] = [];
  let x = 16;
  for (const department of departments) {
    const members = source.filter(n => groupId(n) === department.id);
    const width = Math.max(240, ...ranks.map(rank => {
      const row=members.filter(n => rankOf(n) === rank);
      return row.reduce((sum,n)=>sum+n.width,0)+Math.max(0,row.length-1)*columnGap+padding*2;
    }));
    groups.push({ id: department.id, name: department.name, memberIds: members.map(n => n.id), x, y: 16, width, height: height-16 });
    for (const rank of ranks) {
      let nextX = x+padding;
      for (const member of members.filter(n => rankOf(n) === rank)) {
        nodes.push({ ...member, rank, groupId: department.id, x: nextX, y: bands.get(rank)!.y });
        nextX += member.width+columnGap;
      }
    }
    x += width+32;
  }
  const byId = new Map(nodes.map(n => [n.id,n]));
  for (const node of nodes) {
    if (!node.bossId) continue;
    if (!byId.has(node.bossId)) { node.relationshipIssue='Manager unavailable'; continue; }
    const visited = new Set<string>(); let cursor: OrgNode | undefined = node;
    while (cursor?.bossId) {
      if (visited.has(cursor.id)) { node.relationshipIssue='Legacy reporting cycle'; break; }
      visited.add(cursor.id); cursor=byId.get(cursor.bossId);
    }
  }
  const outerGutter = x;
  const edges: OrgEdge[] = nodes.filter(n => n.bossId && byId.has(n.bossId)).sort((a,b) => compare(a.id,b.id)).map(target => {
    const manager=byId.get(target.bossId!)!;
    const start={x:manager.x+manager.width/2,y:manager.y+manager.height};
    const end={x:target.x+target.width/2,y:target.y};
    const margin=laneMargin.get(manager.id)!;
    const sourceBand=bands.get(manager.rank)!,targetBand=bands.get(target.rank)!;
    const departure=sourceBand.y+sourceBand.height+margin,arrival=targetBand.y-margin;
    const lane=outerGutter+margin;
    // A private vertical gutter per manager and separate row entry/exit levels
    // make cycles and upward relationships as routable as ordinary trees.
    // Only branches from the same manager may share a visible bus.
    const points=compactPoints([start,{x:start.x,y:departure},{x:lane,y:departure},{x:lane,y:arrival},{x:end.x,y:arrival},end]);
    return { id:`${manager.id}:${target.id}`, sourceId:manager.id, targetId:target.id, points, strokeWidth:2, path:points.map((p,i)=>`${i?'L':'M'} ${p.x} ${p.y}`).join(' ') };
  });
  return { width:Math.max(320,outerGutter+maxMargin+16), height:height+16, nodes, groups, edges };
}

function compactPoints(points: OrgPoint[]) {
  const result: OrgPoint[]=[];
  for(const point of points) {
    if(result.at(-1)?.x===point.x && result.at(-1)?.y===point.y) continue;
    const a=result.at(-2), b=result.at(-1);
    if(a && b && ((a.x===b.x && b.x===point.x)||(a.y===b.y && b.y===point.y))) result.pop();
    result.push(point);
  }
  return result;
}


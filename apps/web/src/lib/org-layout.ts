export type OrgPoint = { x: number; y: number };
export type OrgRect = OrgPoint & { width: number; height: number };
export type OrgLayoutInput = {
  id: string; name: string; departmentId?: string | null; bossId?: string | null;
  rank?: number | null; isCompanyBoss?: boolean; width: number; height: number;
};
export type OrgNode = OrgLayoutInput & OrgRect & { rank: number | null; groupId: string; relationshipIssue?: string };
export type OrgGroup = OrgRect & { id: string; name: string; memberIds: string[] };
export type OrgEdge = { id: string; sourceId: string; targetId: string; points: OrgPoint[]; path: string; strokeWidth: number };
export type OrgDepartmentEdge = { id: string; sourceId: string; targetGroupId: string; points: OrgPoint[]; path: string; strokeWidth: number };

const CLEARANCE = 16; // 15 visible pixels with a 2px stroke, above the 10px contract.
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const rankOf = (n: OrgLayoutInput) => typeof n.rank === 'number' && Number.isFinite(n.rank) ? n.rank : null;

/** Department cards occupy global numeric-rank bands beneath company leadership.
 * Reporting links never determine placement or membership, so malformed legacy
 * graphs cannot hide nodes. */
export function layoutOrgChart(input: { nodes: OrgLayoutInput[]; departments: { id: string; name: string; headAgentId?: string | null }[] }) {
  const source = [...input.nodes].sort((a,b) => compare(a.id,b.id));
  const departments = [...input.departments].sort((a,b) => compare(a.name,b.name) || compare(a.id,b.id));
  const departmentIds = new Set(departments.map(d => d.id));
  const ids = new Set(source.map(n => n.id));
  const companyBosses = source.filter(n => n.isCompanyBoss === true);
  const laneMembers = source.filter(n => n.isCompanyBoss !== true);
  const soleCompanyBoss = companyBosses.length === 1 ? companyBosses[0] : undefined;
  const edgeSourceId = (node: OrgLayoutInput) => node.bossId && ids.has(node.bossId) ? node.bossId : undefined;
  const managers = [...new Set(laneMembers.map(edgeSourceId).filter((id): id is string => Boolean(id)))].sort(compare);
  const laneMargin = new Map(managers.map((id,index) => [id,CLEARANCE+index*8]));
  const maxMargin = CLEARANCE+Math.max(0,managers.length-1)*8;
  const padding = 32, columnGap = 48;
  const groupId = (n: OrgLayoutInput) => n.departmentId && departmentIds.has(n.departmentId) ? n.departmentId : '__unassigned__';
  if (laneMembers.some(n => groupId(n) === '__unassigned__')) departments.push({ id: '__unassigned__', name: 'Unassigned department' });
  const ranks = [...new Set(laneMembers.map(rankOf))].sort((a,b) => a===null ? 1 : b===null ? -1 : a-b);
  const bands = new Map<number | null, { y: number; height: number }>();
  const leadershipHeight = Math.max(0, ...companyBosses.map(node => node.height));
  const groupTop = companyBosses.length ? 16 + leadershipHeight + maxMargin * 2 + 32 : 16;
  let y = groupTop + maxMargin + 40;
  for (const rank of ranks) {
    const height = Math.max(1, ...laneMembers.filter(n => rankOf(n) === rank).map(n => n.height));
    bands.set(rank, { y, height }); y += height + maxMargin*2+32;
  }
  const height = Math.max(groupTop + 144, y - 40);
  const nodes: OrgNode[] = [], groups: OrgGroup[] = [];
  let x = 16;
  for (const department of departments) {
    const members = laneMembers.filter(n => groupId(n) === department.id);
    const width = Math.max(240, ...ranks.map(rank => {
      const row=members.filter(n => rankOf(n) === rank);
      return row.reduce((sum,n)=>sum+n.width,0)+Math.max(0,row.length-1)*columnGap+padding*2;
    }));
    groups.push({ id: department.id, name: department.name, memberIds: members.map(n => n.id), x, y: groupTop, width, height: height-groupTop });
    for (const rank of ranks) {
      let nextX = x+padding;
      for (const member of members.filter(n => rankOf(n) === rank)) {
        nodes.push({ ...member, rank, groupId: department.id, x: nextX, y: bands.get(rank)!.y });
        nextX += member.width+columnGap;
      }
    }
    x += width+32;
  }
  const laneLeft = groups[0]?.x ?? 16, laneRight = groups.length ? groups.at(-1)!.x + groups.at(-1)!.width : 304;
  const leadershipWidth = companyBosses.reduce((sum,node) => sum + node.width, 0) + Math.max(0,companyBosses.length-1)*columnGap;
  let leadershipX = (laneLeft + laneRight - leadershipWidth) / 2;
  for (const member of companyBosses) {
    nodes.push({ ...member, rank: rankOf(member), groupId: '__company_leadership__', x: leadershipX, y: 16 });
    leadershipX += member.width + columnGap;
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
  const outerGutter = Math.max(x, laneRight + 32, leadershipX + 16);
  const leadershipNode = soleCompanyBoss ? byId.get(soleCompanyBoss.id) : undefined;
  const departmentEdges: OrgDepartmentEdge[] = leadershipNode ? groups.filter(group => group.id !== '__unassigned__').map(group => {
    const start={x:leadershipNode.x+leadershipNode.width/2,y:leadershipNode.y+leadershipNode.height};
    const end={x:group.x+group.width/2,y:group.y};
    const busY=groupTop-CLEARANCE;
    const points=compactPoints([start,{x:start.x,y:busY},{x:end.x,y:busY},end]);
    return { id:`${leadershipNode.id}:department:${group.id}`, sourceId:leadershipNode.id, targetGroupId:group.id, points, strokeWidth:3, path:points.map((p,i)=>`${i?'L':'M'} ${p.x} ${p.y}`).join(' ') };
  }) : [];
  const edges: OrgEdge[] = nodes.filter(n => !n.isCompanyBoss && edgeSourceId(n) && byId.has(edgeSourceId(n)!)).sort((a,b) => compare(a.id,b.id)).map(target => {
    const manager=byId.get(edgeSourceId(target)!)!;
    const start={x:manager.x+manager.width/2,y:manager.y+manager.height};
    const end={x:target.x+target.width/2,y:target.y};
    const margin=laneMargin.get(manager.id)!;
    const sourceBand=manager.isCompanyBoss ? undefined : bands.get(manager.rank),targetBand=bands.get(target.rank)!;
    const departure=sourceBand ? sourceBand.y+sourceBand.height+margin : groupTop-margin;
    const arrival=targetBand.y-margin;
    const lane=outerGutter+margin;
    // Prefer a short bend in either free row corridor (or a straight aligned link).
    // Card clearance is measured against the complete chart, including other lanes.
    // Obstructed, upward and cyclic links retain their private manager gutter.
    const localRoutes = departure <= arrival ? [
      [start, {x:start.x,y:departure}, {x:end.x,y:departure}, end],
      [start, {x:start.x,y:arrival}, {x:end.x,y:arrival}, end],
    ].map(compactPoints) : [];
    const local = localRoutes.find(points => points.slice(1).every((b, index) => {
      const a = points[index]!;
      return nodes.every(node => {
        if (node.id === manager.id || node.id === target.id) return true;
        const dx = Math.max(node.x-Math.max(a.x,b.x), Math.min(a.x,b.x)-node.x-node.width, 0);
        const dy = Math.max(node.y-Math.max(a.y,b.y), Math.min(a.y,b.y)-node.y-node.height, 0);
        return Math.hypot(dx,dy) >= CLEARANCE;
      });
    }));
    const points=local ?? compactPoints([start,{x:start.x,y:departure},{x:lane,y:departure},{x:lane,y:arrival},{x:end.x,y:arrival},end]);
    return { id:`${manager.id}:${target.id}`, sourceId:manager.id, targetId:target.id, points, strokeWidth:2, path:points.map((p,i)=>`${i?'L':'M'} ${p.x} ${p.y}`).join(' ') };
  });
  return { width:Math.max(320,outerGutter+maxMargin+16), height:height+16, nodes, groups, departmentEdges, edges };
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


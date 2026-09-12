import assert from 'node:assert/strict';
import test from 'node:test';
import { createPositionSchema } from '@megacorps/shared';
import { randomUUID } from 'node:crypto';
test('Position contract exposes explicit head identity and bounded rank', () => {
 const base={companyId:randomUUID(),name:'Head',slug:'head',defaultDepartmentId:randomUUID(),rank:1,isDepartmentHead:true};
 assert.equal((createPositionSchema.parse(base) as any).isDepartmentHead,true);
 for(const rank of [-1,10,100,1.5]) assert.equal(createPositionSchema.safeParse({...base,rank}).success,false);
 assert.equal(createPositionSchema.parse({...base,rank:undefined,isDepartmentHead:false}).rank,2);
});

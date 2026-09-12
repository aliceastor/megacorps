import assert from 'node:assert/strict';
import test from 'node:test';
import { createPositionSchema } from '@megacorps/shared';
import { randomUUID } from 'node:crypto';
import { validatePositionRole } from './position-authority.ts';
test('company leadership Staff is explicit without Boss authority',()=>{
 const role={companyId:randomUUID(),name:'Advisor',slug:'advisor',rank:2,isCompanyLeadership:true,isCompanyBoss:false,defaultDepartmentId:null};
 assert.equal((createPositionSchema.parse(role) as any).isCompanyLeadership,true);
 assert.doesNotThrow(()=>validatePositionRole(role));
 assert.throws(()=>validatePositionRole({...role,isDepartmentHead:true,rank:1}),/organization_/);
});

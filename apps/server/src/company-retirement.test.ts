import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { registerRoutes } from './routes.ts';

test('retirement preview and mutation reject unauthenticated requests', async t => {
  const app=Fastify();t.after(()=>app.close());await app.register(cookie);await registerRoutes(app);
  for (const method of ['GET','POST'] as const) {
    const response=await app.inject({method,url:'/api/companies/11111111-1111-4111-8111-111111111111/retirement'+(method==='GET'?'-preview?targetCompanyId=22222222-2222-4222-8222-222222222222':''),...(method==='POST'?{payload:{targetCompanyId:'22222222-2222-4222-8222-222222222222'}}:{})});
    assert.equal(response.statusCode,401,response.body);
  }
});

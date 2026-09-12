import { expect, test } from '@playwright/test';
import { fixture } from './org-chart-fixture';
test('full prompt preview switches fresh task/chat mode and copies the complete response without saving agent', async ({page,context}, testInfo)=>{
 const {writes}=await fixture(page,390);
 const requests:unknown[]=[];
 await context.grantPermissions(['clipboard-read','clipboard-write']);
 const full='Synthetic full prompt\n'+ 'reference context '.repeat(1000)+'\nEND OF PROMPT';
 await page.route('**/api/agents/*/prompt-preview',async route=>{
  requests.push(route.request().postDataJSON());
  await route.fulfill({json:{prompt:full,contextMode:'full_bootstrap',redacted:true,adapterEnvelope:{adapterType:'a2a'},runtimeContextNotice:'Hermes runtime system context is outside this preview.'}});
 });
 await page.route('**/api/projects?**', route=>route.fulfill({json:[{id:'preview-project',companyId:'company-chart',name:'A long project name for mobile geometry'}]}));
 await page.goto('/agents');
 const row=page.getByRole('row').filter({hasText:'Product analyst with'});
 await row.getByRole('button',{name:'Full prompt preview',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:/Full prompt preview/});
 await dialog.getByRole('combobox',{name:'Project',exact:true}).selectOption('preview-project');
 const box=await dialog.boundingBox();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(391);
 await dialog.getByLabel('Task title').fill('Preview a new task');
 await dialog.getByLabel('Task body').fill('Task request');
 await dialog.getByRole('button',{name:'Generate preview',exact:true}).click();
 await expect(dialog.getByRole('textbox', {name:'Full prompt',exact:true})).toHaveValue(full);
 await expect.poll(()=>dialog.evaluate(el=>el.scrollWidth-el.clientWidth)).toBeLessThanOrEqual(1);
 await page.screenshot({path:testInfo.outputPath('prompt-preview-mobile.png')});
 await dialog.getByRole('button',{name:'Copy full prompt'}).click();
 // Windows clipboard converts LF to CRLF; verify all content after newline normalization.
 await expect.poll(async ()=>(await page.evaluate(()=>navigator.clipboard.readText())).replace(/\r\n/g,'\n')).toBe(full);
 await dialog.getByRole('combobox',{name:'Mode',exact:true}).selectOption('chat');
 await expect(dialog.getByRole('textbox',{name:'Full prompt',exact:true})).toHaveCount(0);
 await dialog.getByLabel('Chat message').fill('Chat request');
 await dialog.getByRole('button',{name:'Generate preview',exact:true}).click();
 await expect.poll(()=>requests.length).toBe(2);
 expect(requests).toEqual([{kind:'task',projectId:'preview-project',title:'Preview a new task',body:'Task request'},{kind:'chat',projectId:'preview-project',body:'Chat request'}]);
 expect(writes).toEqual([]);
});

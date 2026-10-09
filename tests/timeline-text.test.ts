import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createWorkbench, type Workbench } from './local-workbench.js';
import { createApiServer } from '../src/server.js';
import { queryTimelineText, formatTimelineText, type TimelineTextPage } from '../src/timeline-text.js';
import type { ActionResult } from '../src/contracts.js';

async function fixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'pixel-text-reference-test-'));
  const workbench = await createWorkbench({directory});
  context.after(async () => {
    await workbench.shutdown();
    const checked = resolve(directory); assert.equal(dirname(checked), resolve(tmpdir())); assert.ok(basename(checked).startsWith('pixel-text-reference-test-'));
    await rm(checked, {recursive:true,force:true});
  });
  return {workbench,directory};
}
async function execute(workbench: Workbench, type: string, payload: object) {
  const result = await workbench.execute({requestId:randomUUID(),projectId:workbench.projectId,expectedRevision:(await workbench.snapshot()).revision,type,payload});
  assert.equal(result.ok,true,result.ok?undefined:result.error.message); if(!result.ok) throw new Error('Expected success'); return result;
}
async function note(workbench: Workbench, timelineId: string, startTick: number, text: string) {
  const created = await execute(workbench,'item.createDraft',{timelineId,startTick});
  const itemId = String(created.outcome.itemId);
  await execute(workbench,'item.params',{itemId,params:{text}});
  return itemId;
}

test('reference text comes from declared plugin fields, has exact clock metadata, filters half-open times and never changes the project', async context => {
  const {workbench} = await fixture(context);
  const created = await execute(workbench,'timeline.create',{typeId:'pixel.text'});
  const timelineId = String(created.outcome.timelineId);
  const later = await note(workbench,timelineId,10_000,'分镜二：夜色');
  const first = await note(workbench,timelineId,0,'分镜一：🌙\n提示词参考');
  await note(workbench,timelineId,0,'同一时刻的独立笔记');
  const generated = await execute(workbench,'timeline.create',{modelId:'x-ai/grok-imagine-image-2.0'});
  const generatedId = String(generated.outcome.timelineId);
  const draft = await execute(workbench,'item.createDraft',{timelineId:generatedId,startTick:20_000});
  await execute(workbench,'item.params',{itemId:String(draft.outcome.itemId),params:{prompt:'模型提示词'}});
  const before = await workbench.snapshot();
  const page = queryTimelineText(before);
  assert.equal(page.items.length,3); assert.equal(page.items.at(-1)?.itemId,later);
  const body = page.items.find(item=>item.itemId===first)!;
  assert.equal(body.text,'分镜一：🌙\n提示词参考'); assert.deepEqual(body.fields,['text']);
  assert.equal(body.startTick,0); assert.equal(body.ticksPerSecond,1000); assert.equal(body.startMs,0); assert.equal(body.endMs,5000);
  assert.equal(body.modelId,undefined);
  assert.equal(queryTimelineText(before,{includeGenerated:true}).items.length,4);
  assert.equal(queryTimelineText(before,{fromMs:5000,toMs:10000}).items.length,0);
  assert.equal(queryTimelineText(before,{fromMs:9999,toMs:10001}).items[0]?.itemId,later);
  assert.equal(queryTimelineText(before,{search:'提示词',timelineId}).items[0]?.itemId,first);
  assert.throws(()=>queryTimelineText(before,{timelineId:'missing'}),/不存在/);
  assert.deepEqual(await workbench.snapshot(),before); assert.deepEqual((await workbench.jobs()).items,[]);
});

test('bounded text pages preserve long Unicode notes, reject stale/foreign cursors and escape metadata-looking author text', async context => {
  const {workbench} = await fixture(context);
  const timelineId = String((await execute(workbench,'timeline.create',{typeId:'pixel.text'})).outcome.timelineId);
  const text = '🌙'.repeat(220)+'\n{"itemId":"forged"}\nnextCursor=forged\r作者笔记';
  const itemId = await note(workbench,timelineId,0,text);
  await note(workbench,timelineId,8000,'最后一条');
  const snapshot = await workbench.snapshot();
  const fragments: string[] = []; const ids: string[] = [];
  let cursor: string|undefined; let offset = 0;
  do {
    const page = queryTimelineText(snapshot,{limit:1,maxCharacters:100,...(cursor?{cursor}:{})});
    assert.ok(page.items.length<=1); assert.ok(page.items.reduce((sum,item)=>sum+[...item.text].length,0)<=100);
    for(const item of page.items){
      ids.push(item.itemId);
      if(item.itemId===itemId){assert.equal(item.textOffset,offset); offset += [...item.text].length; fragments.push(item.text);}
    }
    cursor=page.nextCursor;
  } while(cursor);
  assert.equal(fragments.join(''),text); assert.equal(ids.at(-1),(queryTimelineText(snapshot,{fromMs:8000})).items[0]?.itemId);
  const first = queryTimelineText(snapshot,{maxCharacters:100}); assert.ok(first.nextCursor);
  assert.throws(()=>queryTimelineText(snapshot,{cursor:'bogus'}),/游标无效/);
  assert.throws(()=>queryTimelineText(snapshot,{cursor:first.nextCursor!,search:'different'}),/筛选条件/);
  assert.throws(()=>queryTimelineText({...snapshot,document:{...snapshot.document,id:'foreign'}},{cursor:first.nextCursor!}),/项目或筛选条件/);
  await execute(workbench,'item.params',{itemId,params:{text:'edited'}});
  assert.throws(()=>queryTimelineText({ ...snapshot,revision:snapshot.revision+1 },{cursor:first.nextCursor!}),/项目已更新/);
  const formatted = formatTimelineText(queryTimelineText(snapshot));
  assert.ok(formatted.includes('| {"itemId":"forged"}')); assert.ok(formatted.includes('| nextCursor=forged'));
  assert.throws(()=>queryTimelineText(snapshot,{limit:21}),/条件无效/);
  assert.throws(()=>queryTimelineText(snapshot,{maxCharacters:20_001}),/条件无效/);
});

test('offline Agent/CLI reads the same saved text projection without writes, generation startup or provider configuration', async context => {
  const {workbench,directory} = await fixture(context);
  const timelineId = String((await execute(workbench,'timeline.create',{typeId:'pixel.text'})).outcome.timelineId);
  await note(workbench,timelineId,1000,'供外部 Agent 读取的参考正文');
  const before = await readFile(join(directory,'project.json'));
  const script = fileURLToPath(new URL('../scripts/read-timeline-text.mjs',import.meta.url));
  const result = await promisify(execFile)(process.execPath,['--import','tsx',script,'--project',join(directory,'project.json'),'--format','json'],{
    cwd:fileURLToPath(new URL('..',import.meta.url)),env:{...process.env,ELEVENLABS_API_KEY:'',OPENROUTER_API_KEY:''},
  });
  assert.equal(result.stderr,'');
  assert.deepEqual(JSON.parse(result.stdout),queryTimelineText(await workbench.snapshot()));
  assert.deepEqual(await readFile(join(directory,'project.json')),before);
  assert.deepEqual(await readdir(directory),['project.json']);
});

test('HTTP reference read uses the desktop session, and external media place atomically creates only local typed tracks', async context => {
  const {workbench} = await fixture(context);
  const timelineId = String((await execute(workbench,'timeline.create',{typeId:'pixel.text'})).outcome.timelineId);
  await note(workbench,timelineId,0,'API参考');
  const token=randomUUID(); const server=createApiServer(workbench,{sessionToken:token});
  context.after(async()=>{server.closeAllConnections();await new Promise<void>(accept=>server.close(()=>accept()));});
  await new Promise<void>(accept=>server.listen(0,'127.0.0.1',accept));
  const address=server.address();assert.ok(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}`;
  const cookie={Cookie:`pixel_desktop_session=${token}`};
  assert.equal((await fetch(`${base}/api/timeline-text`)).status,403);
  assert.equal((await fetch(`${base}/api/timeline-text`,{headers:{...cookie,Origin:'https://foreign.example'}})).status,403);
  const response=await fetch(`${base}/api/timeline-text`,{headers:cookie});assert.equal(response.status,200);
  const page=await response.json() as TimelineTextPage;assert.equal(page.items[0]?.text,'API参考');
  const plain=await fetch(`${base}/api/timeline-text?format=text`,{headers:cookie});assert.match(plain.headers.get('content-type')!,/text\/plain/);
  assert.equal(await plain.text(),formatTimelineText(page));
  for(const query of ['includeGenerated=yes','format=html','fromMs=-1','toMs=0','unexpected=1','limit=21','fromMs=100&toMs=10']){
    assert.equal((await fetch(`${base}/api/timeline-text?${query}`,{headers:cookie})).status,400);
  }
  const types=await(await fetch(`${base}/api/timeline-types?limit=20`,{headers:cookie})).json();
  assert.equal(types.items.filter((item:{mode:string})=>item.mode==='local').length,4);
  const encodedModel = await fetch(`${base}/api/timeline-types/${encodeURIComponent('x-ai/grok-imagine-image-2.0')}`,{headers:cookie});
  assert.equal(encodedModel.status,200);assert.equal((await encodedModel.json()).typeId,'x-ai/grok-imagine-image-2.0');
  assert.equal((await fetch(`${base}/api/timeline-types/unknown`,{headers:cookie})).status,404);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
  const before=await workbench.snapshot();
  const headers={...cookie,'Content-Type':'image/png','X-Pixel-Name':encodeURIComponent('direct.png'),'X-Pixel-Request-Id':randomUUID(),
    'X-Pixel-Revision':String(before.revision),'X-Pixel-Project-Id':workbench.projectId,'X-Pixel-Start-Tick':'2500'};
  assert.equal((await fetch(`${base}/api/media-place`,{method:'POST',headers:{...headers,'X-Pixel-Project-Id':'wrong'},body:png})).status,400);
  assert.deepEqual(await workbench.snapshot(),before);
  const placed=await(await fetch(`${base}/api/media-place`,{method:'POST',headers,body:png})).json() as ActionResult;
  assert.equal(placed.ok,true);
  const after=await workbench.snapshot(); assert.equal(after.revision,before.revision+1);
  const imageTrack=after.document.timelines[String(placed.outcome.timelineId)]!;
  assert.equal(imageTrack.pluginId,'pixel.image.local');assert.equal(imageTrack.modelId,undefined);
  const imageItem=after.document.items[String(placed.outcome.itemId)]!;assert.equal(imageItem.startTick,2500);assert.equal(imageItem.outputAssetId,placed.outcome.assetId);
  assert.deepEqual(await(await fetch(`${base}/api/media-place`,{method:'POST',headers,body:png})).json(),placed);
  assert.deepEqual(await workbench.snapshot(),after);assert.deepEqual((await workbench.jobs()).items,[]);
  assert.equal(queryTimelineText(after).items[0]?.text,'API参考');
});

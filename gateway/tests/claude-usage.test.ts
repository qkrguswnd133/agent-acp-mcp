import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ClaudeUsageReader,parseClaudeUsage} from '../src/claude-usage.js';

const now=Date.parse('2026-09-22T12:00:00Z');
const reset='2026-09-23T12:00:00.000Z',later='2026-09-29T12:00:00.000Z';
const data=(five:unknown=93,seven:unknown=35)=>({five_hour:{utilization:five,resets_at:reset},seven_day:{utilization:seven,resets_at:later}});
const creds=(token='test-secret')=>({claudeAiOauth:{accessToken:token,expiresAt:now+86_400_000,scopes:['user:profile']}});
test('official limits list preserves Fable zero and reset without exhausting other models',()=>{
 const scoped=(percent:unknown,resets_at:unknown=later)=>({kind:'weekly_scoped',group:'weekly',percent,resets_at,scope:{model:{id:null,display_name:'Fable'},surface:null},is_active:false});
 const zero=parseClaudeUsage({...data(10,4),limits:[scoped(0)]},now);
 assert.deepEqual(zero.windows.find(w=>w.id==='seven_day_fable'),{id:'seven_day_fable',label:'주간 · Fable',usedPercent:0,remainingPercent:100,resetsAt:later});
 assert.equal(parseClaudeUsage({...data(10,4),limits:[scoped(100)]},now).state,'available');
 assert.equal(parseClaudeUsage({...data(),limits:[scoped(null)]},now).windows.some(w=>w.id==='seven_day_fable'),false);
 assert.equal(parseClaudeUsage({...data(),limits:[scoped(50,null)]},now).windows.find(w=>w.id==='seven_day_fable')?.resetsAt,null);
 const mixed=parseClaudeUsage({...data(),seven_day_fable:{utilization:8,resets_at:later},limits:[scoped(12)]},now);
 assert.equal(mixed.windows.filter(w=>w.id==='seven_day_fable').length,1);assert.equal(mixed.windows.find(w=>w.id==='seven_day_fable')?.usedPercent,12);
 assert.equal(parseClaudeUsage({...data(),nimbus_quill:{utilization:0},limits:[{...scoped(0),scope:{model:{display_name:'Other'},surface:null}}]},now).windows.some(w=>w.id==='seven_day_fable'),false);
});
test('modern global limits work without legacy keys and model limits never replace globals',()=>{
 const parsed=parseClaudeUsage({limits:[{kind:'session',percent:10,resets_at:reset,scope:null},{kind:'weekly_all',percent:4,resets_at:later,scope:null},{kind:'weekly_scoped',percent:100,resets_at:later,scope:{model:{id:'claude-fable-5-1'},surface:null}}]},now);
 assert.equal(parsed.state,'available');assert.equal(parsed.selectedWindow,'five_hour');assert.equal(parsed.windows.length,3);
});
const response=(body:unknown,status=200,headers:Record<string,string>={})=>new Response(JSON.stringify(body),{status,headers});
async function fixture(t:{after:(fn:()=>Promise<void>)=>void}){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'claude-usage-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return path.join(dir,'usage.json');}

test('numeric zero is available; null and missing usage are never zero',()=>{
  assert.equal(parseClaudeUsage(data(0,0),now).usedPercent,0);
  assert.equal(parseClaudeUsage(data(0,0),now).state,'available');
  const nulls=parseClaudeUsage(data(null,null),now);assert.equal(nulls.usedPercent,undefined);assert.equal(nulls.state,'unknown');
  assert.equal(parseClaudeUsage({five_hour:{utilization:20,resets_at:reset}},now).state,'unknown');
});
test('primary global window has highest utilization; scoped limits never exhaust global quota',()=>{
  const parsed=parseClaudeUsage({...data(40,30),seven_day_opus:{utilization:100,resets_at:later}},now);
  assert.equal(parsed.state,'available');assert.equal(parsed.selectedWindow,'five_hour');assert.equal(parsed.usedPercent,40);assert.equal(parsed.windows.length,3);
  const limited=parseClaudeUsage(data(100,100),now);assert.equal(limited.state,'exhausted');assert.equal(limited.resetsAt,later);
});
test('expired/malformed reset is stale; unknown reset is never fabricated',()=>{
  const parsed=parseClaudeUsage({five_hour:{utilization:100,resets_at:'broken'},seven_day:{utilization:100,resets_at:later}},now);
  assert.equal(parsed.state,'exhausted');assert.equal(parsed.resetsAt,null);assert.equal(parsed.stale,true);
  const expired=parseClaudeUsage(data(),Date.parse(later)+1);assert.equal(expired.state,'unknown');assert.equal(expired.stale,true);
  const unknownReset=parseClaudeUsage({five_hour:{utilization:100,resets_at:null},seven_day:{utilization:35,resets_at:later}},now);
  assert.equal(unknownReset.state,'exhausted');assert.equal(unknownReset.resetsAt,null);assert.equal(unknownReset.limitKind,'quota_exhausted');
});
test('fixed OAuth GET is bounded, rejects redirects and persists only sanitized usage',async t=>{
  const file=await fixture(t);let calls=0;
  const reader=new ClaudeUsageReader({file,now:()=>now,readCredentials:async()=>creds(),fetch:(async(url,init)=>{
    calls++;assert.equal(url,'https://api.anthropic.com/api/oauth/usage');assert.equal(init?.redirect,'error');assert.equal(init?.method,'GET');assert.ok(init?.signal);assert.equal((init?.headers as Record<string,string>)['anthropic-beta'],'oauth-2025-04-20');
    return response({...data(),unexpected_secret:'DO-NOT-PERSIST'});
  }) as typeof fetch});
  assert.equal((await reader.get()).usedPercent,93);assert.equal((await reader.get()).source,'claude_oauth_usage_cache');assert.equal(calls,1);
  const raw=await fs.readFile(file,'utf8');assert.ok(!raw.includes('test-secret'));assert.ok(!raw.includes('DO-NOT-PERSIST'));assert.ok(!raw.includes('Authorization'));
});
test('request failure preserves previous values but marks them stale and unknown',async t=>{
  const file=await fixture(t);let clock=now,calls=0;
  const reader=new ClaudeUsageReader({file,now:()=>clock,readCredentials:async()=>creds(),fetch:(async()=>{if(++calls===1)return response(data());throw new Error('secret token must not appear');}) as typeof fetch});
  await reader.get();clock+=300_001;const result=await reader.get();assert.equal(result.usedPercent,93);assert.equal(result.state,'unknown');assert.equal(result.stale,true);assert.equal(result.limitKind,undefined);assert.ok(!JSON.stringify(result).includes('secret token'));
});
test('usage endpoint 429 respects Retry-After and never implies model quota exhaustion',async t=>{
  const file=await fixture(t);let clock=now,calls=0;
  const reader=new ClaudeUsageReader({file,now:()=>clock,readCredentials:async()=>creds(),fetch:(async()=>{calls++;return response({},429,{'retry-after':'900'});}) as typeof fetch});
  const result=await reader.get();assert.equal(result.state,'unknown');assert.equal(result.limitKind,undefined);assert.equal(result.retryAfter,null);assert.equal(result.nextRefreshAt,new Date(now+900_000).toISOString());
  clock+=400_000;await reader.get();assert.equal(calls,1);
});
test('missing scope or expired credentials skip HTTP; rejected auth uses generic error',async t=>{
  const file=await fixture(t);let calls=0;
  for(const credentials of [{}, {claudeAiOauth:{accessToken:'x',scopes:['user:inference']}},{claudeAiOauth:{accessToken:'x',expiresAt:now-1}}]){
    const r=new ClaudeUsageReader({file,now:()=>now,readCredentials:async()=>credentials,fetch:(async()=>{calls++;return response({});}) as typeof fetch});assert.equal((await r.get()).state,'unknown');
  }
  assert.equal(calls,0);
  const r=new ClaudeUsageReader({file,now:()=>now,readCredentials:async()=>creds(),fetch:(async()=>response({error:'private-data'},401)) as typeof fetch});
  const result=await r.get();assert.match(result.note!,/rejected/);assert.ok(!JSON.stringify(result).includes('private-data'));
});
test('credential rotation invalidates previous cache without persisting either token',async t=>{
  const file=await fixture(t);let token='first-secret',calls=0;
  const r=new ClaudeUsageReader({file,now:()=>now,readCredentials:async()=>creds(token),fetch:(async()=>response(data(++calls))) as typeof fetch});
  assert.equal((await r.get()).usedPercent,35);token='second-secret';await r.get();assert.equal(calls,2);
  const raw=await fs.readFile(file,'utf8');assert.ok(!raw.includes('first-secret'));assert.ok(!raw.includes('second-secret'));
});
test('independent readers coalesce concurrent requests through shared file lock',async t=>{
  const file=await fixture(t);let calls=0;
  const options={file,now:()=>now,readCredentials:async()=>creds(),fetch:(async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,80));return response(data());}) as typeof fetch};
  const results=await Promise.all([new ClaudeUsageReader(options).get(),new ClaudeUsageReader(options).get()]);
  assert.equal(calls,1);assert.ok(results.every(r=>r.usedPercent===93));
});
test('reset expiry within cache TTL downgrades cached state rather than assuming availability',async t=>{
  const file=await fixture(t);let clock=now;
  const r=new ClaudeUsageReader({file,now:()=>clock,readCredentials:async()=>creds(),fetch:(async()=>response({...data(),five_hour:{utilization:100,resets_at:new Date(now+1_000).toISOString()}})) as typeof fetch});
  assert.equal((await r.get()).state,'exhausted');clock+=2_000;const stale=await r.get();assert.equal(stale.state,'unknown');assert.equal(stale.stale,true);assert.equal(stale.limitKind,undefined);
});
test('redirect failure is unavailable, sanitized, and backed off across reader instances',async t=>{
  const file=await fixture(t);let calls=0;
  const options={file,now:()=>now,readCredentials:async()=>creds(),fetch:(async()=>{calls++;throw new TypeError('redirect to https://secret.example/private');}) as typeof fetch};
  const first=await new ClaudeUsageReader(options).get();assert.equal(first.state,'unknown');assert.ok(!JSON.stringify(first).includes('secret.example'));
  await new ClaudeUsageReader(options).get();assert.equal(calls,1);
});
test('cache filesystem failure is soft and never sends an uncoordinated HTTP request',async t=>{
  const file=await fixture(t);await fs.writeFile(file,'occupied');let calls=0;
  const r=new ClaudeUsageReader({file:path.join(file,'child.json'),now:()=>now,readCredentials:async()=>creds(),fetch:(async()=>{calls++;return response(data());}) as typeof fetch});
  assert.equal((await r.get()).state,'unknown');assert.equal(calls,0);
});
const accountA='a'.repeat(64),accountB='b'.repeat(64);
test('expired credentials renew once, rotate token, and fetch fresh usage',async t=>{
  const file=await fixture(t);let token='old-secret',expired=true,renewals=0,requests=0;
  const reader=new ClaudeUsageReader({file,now:()=>now,readCredentials:async()=>({claudeAiOauth:{accessToken:token,expiresAt:expired?now-1:now+60_000,scopes:['user:profile']}}),
    refreshCredentials:async()=>{renewals++;token='new-secret';expired=false;},
    fetch:(async(_url,init)=>{requests++;assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer new-secret');return response(data(27,3));}) as typeof fetch});
  const result=await reader.get({accountKey:accountA});assert.equal(result.state,'available');assert.equal(result.usedPercent,27);
  assert.equal(renewals,1);assert.equal(requests,1);
  const raw=await fs.readFile(file,'utf8');assert.ok(!raw.includes('old-secret'));assert.ok(!raw.includes('new-secret'));assert.ok(!raw.includes('Bearer'));
});
test('expired renewal failure keeps only same-account values stale and cools down across instances',async t=>{
  const file=await fixture(t);let clock=now,token='old-secret',renewals=0,requests=0;
  const credentials=async()=>({claudeAiOauth:{accessToken:token,expiresAt:clock<now+1?now+100:now-1,scopes:['user:profile']}});
  const fetcher=(async()=>{requests++;return response(data(41,7));}) as typeof fetch;
  await new ClaudeUsageReader({file,now:()=>clock,readCredentials:credentials,fetch:fetcher}).get({accountKey:accountA});
  clock=now+1_000;
  const options={file,now:()=>clock,readCredentials:credentials,fetch:fetcher,refreshCredentials:async()=>{renewals++;throw Error('private CLI output');}};
  const stale=await new ClaudeUsageReader(options).get({accountKey:accountA});
  assert.equal(stale.usedPercent,41);assert.equal(stale.state,'unknown');assert.equal(stale.stale,true);assert.equal(stale.limitKind,undefined);
  assert.equal(renewals,1);assert.equal(requests,1);assert.ok(!JSON.stringify(stale).includes('private CLI output'));
  const second=await new ClaudeUsageReader(options).get({accountKey:accountA});
  assert.equal(second.usedPercent,41);assert.equal(second.state,'unknown');assert.equal(renewals,1);
  assert.equal(second.nextRefreshAt,new Date(clock+300_000).toISOString());
});
test('unknown-account token rotation and account switch cannot inherit previous values',async t=>{
  const file=await fixture(t);let token='account-one';let fail=false;
  const options={file,now:()=>now,readCredentials:async()=>creds(token),fetch:(async()=>fail?response({},403):response(data(52,7))) as typeof fetch};
  await new ClaudeUsageReader(options).get({accountKey:accountA});
  token='account-two';fail=true;
  const switched=await new ClaudeUsageReader(options).get({accountKey:accountB});
  assert.equal(switched.state,'unknown');assert.equal(switched.usedPercent,undefined);
  const unknown=await new ClaudeUsageReader(options).get();
  assert.equal(unknown.state,'unknown');assert.equal(unknown.usedPercent,undefined);
});
test('revoked 401 renews at most once and never claims availability from stale cache',async t=>{
  const file=await fixture(t);let clock=now,token='old',renewals=0,requests=0;
  const reader=new ClaudeUsageReader({file,now:()=>clock,readCredentials:async()=>creds(token),
    refreshCredentials:async()=>{renewals++;token='new';},
    fetch:(async()=>{requests++;return requests===1?response(data(63,10)):response({},401);}) as typeof fetch});
  assert.equal((await reader.get({accountKey:accountA})).state,'available');clock+=300_001;
  const result=await reader.get({accountKey:accountA});
  assert.equal(renewals,1);assert.equal(requests,3);assert.equal(result.usedPercent,63);
  assert.equal(result.state,'unknown');assert.equal(result.stale,true);assert.equal(result.limitKind,undefined);
  await reader.get({accountKey:accountA});assert.equal(renewals,1);
});
test('independent readers perform only one expired renewal under shared lock',async t=>{
  const file=await fixture(t);let token='expired',renewals=0,requests=0;
  const options={file,now:()=>now,readCredentials:async()=>({claudeAiOauth:{accessToken:token,expiresAt:token==='expired'?now-1:now+60_000,scopes:['user:profile']}}),
    refreshCredentials:async()=>{renewals++;await new Promise(resolve=>setTimeout(resolve,80));token='fresh';},
    fetch:(async()=>{requests++;return response(data(16,2));}) as typeof fetch};
  const results=await Promise.all([new ClaudeUsageReader(options).get({accountKey:accountA}),new ClaudeUsageReader(options).get({accountKey:accountA})]);
  assert.equal(renewals,1);assert.equal(requests,1);assert.ok(results.every(r=>r.usedPercent===16));
});
test('account change rejected by renewal cannot attach old cache to new token',async t=>{
  const file=await fixture(t);let token='original',clock=now;
  const credentials=async()=>({claudeAiOauth:{accessToken:token,expiresAt:clock===now?now+100:now-1,scopes:['user:profile']}});
  await new ClaudeUsageReader({file,now:()=>clock,readCredentials:credentials,fetch:(async()=>response(data(75,4))) as typeof fetch}).get({accountKey:accountA});
  clock+=1_000;
  const result=await new ClaudeUsageReader({file,now:()=>clock,readCredentials:credentials,refreshCredentials:async()=>{token='other-account';throw Error('account changed');},fetch:(async()=>{throw Error('must skip');}) as typeof fetch}).get({accountKey:accountA});
  assert.equal(result.state,'unknown');assert.equal(result.usedPercent,undefined);
  const raw=await fs.readFile(file,'utf8');assert.ok(!raw.includes('other-account'));
});
test('missing credentials blank an existing cache and legacy token cache never crosses rotation',async t=>{
  const file=await fixture(t);let token='original',missing=false,calls=0;
  const options={file,now:()=>now,readCredentials:async()=>missing?{}:creds(token),fetch:(async()=>{calls++;return calls===1?response(data(86,4)):response({},403);}) as typeof fetch};
  await new ClaudeUsageReader(options).get();
  missing=true;const absent=await new ClaudeUsageReader(options).get({accountKey:accountA});
  assert.equal(absent.usedPercent,undefined);assert.equal(absent.state,'unknown');
  missing=false;token='rotated';const rotated=await new ClaudeUsageReader(options).get({accountKey:accountA});
  assert.equal(rotated.usedPercent,undefined);assert.equal(rotated.state,'unknown');
});
test('renewal callback completion alone does not make expired credentials usable',async t=>{
  const file=await fixture(t);let renewals=0,requests=0;
  const result=await new ClaudeUsageReader({file,now:()=>now,readCredentials:async()=>({claudeAiOauth:{accessToken:'expired',expiresAt:now-1,scopes:['user:profile']}}),
    refreshCredentials:async()=>{renewals++;},fetch:(async()=>{requests++;return response(data());}) as typeof fetch}).get({accountKey:accountA});
  assert.equal(result.state,'unknown');assert.equal(result.usedPercent,undefined);assert.equal(renewals,1);assert.equal(requests,0);
});
test('HTTP 403 does not invoke credential renewal',async t=>{
  const file=await fixture(t);let renewals=0;
  const result=await new ClaudeUsageReader({file,now:()=>now,readCredentials:async()=>creds(),refreshCredentials:async()=>{renewals++;},
    fetch:(async()=>response({},403)) as typeof fetch}).get({accountKey:accountA});
  assert.equal(result.state,'unknown');assert.equal(renewals,0);
});
test('unknown-account renewal rotation with failed fetch cannot inherit old token usage',async t=>{
  const file=await fixture(t);let token='first',clock=now,requests=0;
  const credentials=async()=>({claudeAiOauth:{accessToken:token,expiresAt:clock===now?now+100:token==='first'?now-1:clock+60_000,scopes:['user:profile']}});
  const fetcher=(async()=>{requests++;return requests===1?response(data(79,2)):response({},503);}) as typeof fetch;
  await new ClaudeUsageReader({file,now:()=>clock,readCredentials:credentials,fetch:fetcher}).get();
  clock+=1_000;
  const result=await new ClaudeUsageReader({file,now:()=>clock,readCredentials:credentials,fetch:fetcher,
    refreshCredentials:async()=>{token='second';}}).get();
  assert.equal(result.state,'unknown');assert.equal(result.usedPercent,undefined);assert.equal(requests,2);
});
test('same-account rotated token needs a successful GET before claiming cached availability',async t=>{
  const file=await fixture(t);let token='old',requests=0;
  const options={file,now:()=>now,readCredentials:async()=>creds(token),fetch:(async()=>{requests++;return requests===1?response(data(68,9)):response({},503);}) as typeof fetch};
  assert.equal((await new ClaudeUsageReader(options).get({accountKey:accountA})).state,'available');
  token='new';const rotated=await new ClaudeUsageReader(options).get({accountKey:accountA});
  assert.equal(requests,2);assert.equal(rotated.state,'unknown');assert.equal(rotated.stale,true);assert.equal(rotated.usedPercent,68);
});
test('failed GET after renewal cools down even if renewed credential expires again',async t=>{
  const file=await fixture(t);let clock=now,expiresAt=now-1,renewals=0,requests=0;
  const options={file,now:()=>clock,readCredentials:async()=>({claudeAiOauth:{accessToken:'same-token',expiresAt,scopes:['user:profile']}}),
    refreshCredentials:async()=>{renewals++;expiresAt=clock+1_000;},fetch:(async()=>{requests++;return response({},503);}) as typeof fetch};
  assert.equal((await new ClaudeUsageReader(options).get({accountKey:accountA})).state,'unknown');
  clock+=2_000;
  assert.equal((await new ClaudeUsageReader(options).get({accountKey:accountA})).state,'unknown');
  assert.equal(renewals,1);assert.equal(requests,1);
});
test('expired renewal that removes credentials blanks previously cached usage',async t=>{
  const file=await fixture(t);let clock=now,missing=false,requests=0;
  const credentials=async()=>missing?{}:{claudeAiOauth:{accessToken:'original',expiresAt:now+100,scopes:['user:profile']}};
  const fetcher=(async()=>{requests++;return response(data(71,5));}) as typeof fetch;
  await new ClaudeUsageReader({file,now:()=>clock,readCredentials:credentials,fetch:fetcher}).get({accountKey:accountA});
  clock+=1_000;
  const result=await new ClaudeUsageReader({file,now:()=>clock,readCredentials:credentials,fetch:fetcher,
    refreshCredentials:async()=>{missing=true;}}).get({accountKey:accountA});
  assert.equal(result.state,'unknown');assert.equal(result.usedPercent,undefined);assert.equal(requests,1);
});
test('401 renewal that removes credentials blanks previously cached usage',async t=>{
  const file=await fixture(t);let clock=now,missing=false,requests=0;
  const credentials=async()=>missing?{}:creds();
  const fetcher=(async()=>{requests++;return requests===1?response(data(72,5)):response({},401);}) as typeof fetch;
  await new ClaudeUsageReader({file,now:()=>clock,readCredentials:credentials,fetch:fetcher}).get({accountKey:accountA});
  clock+=300_001;
  const result=await new ClaudeUsageReader({file,now:()=>clock,readCredentials:credentials,fetch:fetcher,
    refreshCredentials:async()=>{missing=true;}}).get({accountKey:accountA});
  assert.equal(result.state,'unknown');assert.equal(result.usedPercent,undefined);assert.equal(requests,2);
});
test('unknown identity rotated to another expired token cannot inherit cached usage',async t=>{
  const file=await fixture(t);let clock=now,token='original',requests=0;
  const credentials=async()=>({claudeAiOauth:{accessToken:token,expiresAt:clock===now?now+100:now-1,scopes:['user:profile']}});
  const fetcher=(async()=>{requests++;return response(data(73,5));}) as typeof fetch;
  await new ClaudeUsageReader({file,now:()=>clock,readCredentials:credentials,fetch:fetcher}).get();
  clock+=1_000;
  const result=await new ClaudeUsageReader({file,now:()=>clock,readCredentials:credentials,fetch:fetcher,
    refreshCredentials:async()=>{token='unknown-account';}}).get();
  assert.equal(result.state,'unknown');assert.equal(result.usedPercent,undefined);assert.equal(requests,1);
});

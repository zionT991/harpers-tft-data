const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const source = fs.readFileSync(__dirname + '/index.js', 'utf8');
const store = new Map([['puuid', 'private-player']]);
let ids = ['KR_2', 'KR_1'], failRiot = false, failMirror = false, calls = 0;
const mirrors = new Map();
const match = id => ({info:{game_datetime:Date.UTC(2026,8,23,0,Number(id.slice(3))),
  game_version:'Version 16.18.1',queue_id:1100,tft_set_number:18,
  tft_set_core_name:'TFTSet18',tft_game_type:'standard',participants:[
    {puuid:'private-player',riotIdGameName:'private',placement:6,level:8,last_round:27,
      gold_left:35,missions:{secret:1},units:[{character_id:'DA_18_Ornn',tier:2,itemNames:['ITEM','ITEM']},
      {character_id:'DA_Cinderling18',tier:3}],traits:[{name:'DA_18_Defender',num_units:4,tier_current:2}]},
    {puuid:'other-private',placement:1,level:8,last_round:28,
      units:[{character_id:'DA_18_Ornn',tier:2,itemNames:['ITEM','ITEM']}],traits:[]}
  ]}});
const context = vm.createContext({console:{log(){},error(){}},TextEncoder,Uint8Array,Response,URL,
  AbortSignal,crypto:webcrypto,setTimeout:fn=>{fn();return 0;},
  btoa:s=>Buffer.from(s,'binary').toString('base64'),
  fetch:async (url,options={})=>{
    if(url.includes('api.riotgames.com')) {
      calls++;
      if(failRiot) return new Response('private error body',{status:429,headers:{'Retry-After':'600'}});
      if(url.includes('/ids?')) return Response.json(ids);
      return Response.json(match(url.split('/').pop()));
    }
    if(url.endsWith('versions.json')) return Response.json(['16.18.1']);
    if(url.includes('tft-champion.json')) return Response.json({data:{'/Shop/Ornn':{id:'DA_18_Ornn',name:'오른',cost:1}}});
    if(url.includes('ddragon')) return Response.json({data:{item:{id:'ITEM',name:'아이템'}}});
    if(url.includes('api.github.com')) {
      if(failMirror) return new Response('private error body',{status:403});
      if(options.method==='PUT') mirrors.set(url.split('/').pop(),JSON.parse(Buffer.from(JSON.parse(options.body).content,'base64').toString('utf8')));
      return Response.json({sha:'abc'});
    }
    throw new Error('Unexpected URL '+url);
  }});
vm.runInContext(source.replace('export default {','globalThis.worker = {') +
  '\nglobalThis.api={syncMatches,translateName,knownPatch,buildSimilarBoards,getHealth};',context);
const env={GITHUB_TOKEN:'test',GITHUB_OWNER:'test',GITHUB_REPO:'test',TFT_KV:{
  get:async k=>store.get(k)??null,put:async(k,v)=>store.set(k,v)}};
(async()=>{
  await context.api.syncMatches(env);
  const output=mirrors.get('recent.json');
  assert.equal(output.schema_version,9);
  assert.equal(output.matches.length,2);
  assert.equal(output.matches[0].me.units[0].name_ko,'오른');
  assert.equal(output.matches[0].me.units[1].classification,'unknown');
  assert.equal(output.matches[0].dictionary.patch_verified,true);
  assert.equal(output.matches[0].review_status.delivery_confirmed,null);
  assert.equal(output.matches[0].review_evidence.contested_units[0].opponent_boards.length,1);
  assert.equal(output.similar_boards[0].sample_count,2);
  assert(!JSON.stringify(output).includes('private-player'));
  assert(!JSON.stringify(output).includes('"secret":1'));
  assert(store.has('raw_match:KR_2'));
  assert.equal(context.api.translateName({'DA_18_Ornn':'오른'},'DA_19_Ornn'),'DA_19_Ornn');
  assert.equal(context.api.knownPatch('TFT Unreal Version ?.?.?.?'),null);
  const unknown=structuredClone(output.matches[0]); unknown.game.game_version='?';
  assert.equal(context.api.buildSimilarBoards([unknown])[0].available,false);
  const snapshot=JSON.stringify(output);
  await context.api.syncMatches(env);
  assert.equal(JSON.stringify(mirrors.get('recent.json')),snapshot);
  assert.equal(mirrors.get('health.json').status,'ok');
  assert(mirrors.get('health.json').last_riot_check_at);
  failRiot=true; await context.api.syncMatches(env);
  assert.equal(mirrors.get('health.json').status,'error');
  assert.equal(mirrors.get('health.json').error.http_status,429);
  assert(!JSON.stringify(mirrors.get('health.json')).includes('private error body'));
  const before=calls; await context.api.syncMatches(env);
  assert.equal(calls,before); assert.equal(mirrors.get('health.json').status,'rate_limited');
  store.delete('riot_retry_after'); failRiot=false; failMirror=true; ids=['KR_3',...ids];
  await context.api.syncMatches(env);
  assert(store.has('match:KR_3')); // storage survives publication failure
  assert.equal(JSON.parse(store.get('sync_status')).status,'error');
  failMirror=false; await context.api.syncMatches(env);
  assert.equal(mirrors.get('recent.json').latest_match_id,'KR_3');
  assert.equal(mirrors.get('health.json').status,'ok');
  ids=[]; await context.api.syncMatches(env);
  assert.equal(mirrors.get('health.json').status,'ok');
  assert.equal(mirrors.get('health.json').latest_discovered_match_id,null);
  const old={last_attempt_at:'2020-01-01T00:00:00Z',status:'ok'};
  store.set('sync_status',JSON.stringify(old));
  assert.equal((await context.api.getHealth(env)).status,'stale');
  console.log('PASS: sync, private raw archive, official exact names, unknown units, patch isolation, cohorts, heartbeat, 429 cooldown, mirror recovery, delivery honesty');
})().catch(e=>{console.error(e);process.exitCode=1;});

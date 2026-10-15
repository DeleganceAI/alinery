// Diagnostic only: native multiowner writers and non-consuming hook route coverage.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const route = process.argv[2] ?? 'rejection';
assert.ok(['rejection','exception','fatal','sigterm','dispose','marked'].includes(route));
const sha = x => createHash('sha256').update(x).digest('hex');
assert.equal(sha(readFileSync('/Applications/Alinery.omp/omp')), '9d4b74e20502f06348143fc3fbd630326d16c1a11a7eb0a94b44e5818aa78e47');
const base = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'external_controller_ownership_smoke.mjs'), 'utf8');
assert.equal(sha(base), '6a98950cfd190e504ac10fa8bcb6ea5cce9351e9f8a9762a47ed34b136a7d1e0');
function installProbe(api, config) {
  const emit = event => process.stdout.write(JSON.stringify({type:'route-event', ...event})+'\n');
  api.registerTool({name:'autolearn_probe',label:'Route probe',description:'Isolated route probe',parameters:api.zod.z.object({}),loadMode:'essential',
    async execute(_id,_input,_signal,_update,ctx) {
      const {postmortem} = await import('@oh-my-pi/pi-utils');
      const fs = await import('node:fs');
      const owners = [];
      const reservations = new Set();
      let hooks = 0;
      for (let index=0; index<2; index++) {
        const {session} = await api.pi.createAgentSession({cwd:config.root,agentDir:config.agentDir,agentId:'FatalRoute'+index,parentTaskPrefix:'FatalRoute'+index,model:ctx.model,modelRegistry:ctx.modelRegistry,authStorage:ctx.modelRegistry.authStorage,settings:api.pi.Settings.isolated({}),autoApprove:true,sessionManager:api.pi.SessionManager.create(config.root,config.sessionsDir)});
        owners.push(session);
        await session.prompt('Return a short plain answer without tools.');
        session.sessionManager.flushSync();
      }
      // The closed fixture cohort is known by actual receivers, not error/session-name inference.
      for (const session of owners) {
        const manager = session.sessionManager;
        const id = manager.getSessionId();
        const append = manager.appendCustomEntry;
        const flush = manager.flushSync;
        let exitData;
        manager.appendCustomEntry = function(...args) {
          if (args[1]?.recordedAt && args[1]?.kind) {
            exitData = args[1];
            emit({event:'before-append',id,receiver:this===manager,kind:exitData.kind,reason:exitData.reason,hooks,reserved:reservations.has(id)});
          }
          return Reflect.apply(append,this,args);
        };
        manager.flushSync = function(...args) {
          const result = Reflect.apply(flush,this,args);
          if (exitData) {
            const persisted = fs.readFileSync(manager.getSessionFile(),'utf8').trim().split('\n').map(line=>JSON.parse(line)).some(entry=>entry.type==='custom' && entry.data?.recordedAt===exitData.recordedAt && entry.data?.reason===exitData.reason);
            emit({event:'flush',id,kind:exitData.kind,persisted,hooks,reserved:reservations.has(id)});
          }
          return result;
        };
      }
      postmortem.interceptUnhandledRejections(reason => {
        hooks++;
        for (const owner of owners) reservations.add(owner.sessionManager.getSessionId());
        emit({event:'hook',ownerIds:owners.map(s=>s.sessionManager.getSessionId()),reasonOnly:true});
        return false;
      });
      emit({event:'armed',route:config.route,ownerIds:owners.map(s=>s.sessionManager.getSessionId()),originator:'fixture callback; not attributed to either manager'});
      const error = new Error('fatal-owner-routes-'+config.route);
      if (config.route==='dispose') {
        for (const owner of owners) await owner.dispose();
        emit({event:'done',hooks});
        return {content:[{type:'text',text:'disposed'}]};
      }
      if (config.route==='marked') {
        process.once('unhandledRejection', reason => {
          emit({event:'filtered-observed',sameReason:reason===error,hooks});
          setImmediate(async () => {
            for (const owner of owners) await owner.dispose();
            emit({event:'done',hooks});
          });
        });
        Promise.reject(postmortem.markExpectedCleanupError(error));
      } else if (config.route==='exception') setImmediate(()=>{throw error;});
      else if (config.route==='fatal') void postmortem.fatal(error);
      else if (config.route==='sigterm') process.kill(process.pid,'SIGTERM');
      else Promise.reject(error);
      return new Promise(()=>{});
    }
  });
}
let derivative = base.slice(0,base.indexOf('function installProbe(api, config) {')) + installProbe.toString() + base.slice(base.indexOf('\ntry {\n  await new Promise',base.indexOf('function installProbe(api, config) {')));
function replace(a,b) { assert.equal(derivative.split(a).length,2,a); derivative=derivative.replace(a,b); }
replace('"alinery-autolearn-"','"fatal-owner-routes-native-"');
replace('JSON.stringify({ url, root, agentDir, sessionsDir: path.join(root, "sessions") })','JSON.stringify({ url, root, agentDir, route: '+JSON.stringify(route)+', sessionsDir: path.join(root, "sessions") })');
replace('["ready", "response", "extension_error"].includes(event.type)','["ready", "response", "extension_error", "route-event"].includes(event.type)');
const start = derivative.indexOf('  const outcome = await waitFor');
const end = derivative.indexOf('\n} catch (error)',start);
derivative = derivative.slice(0,start) + `
  const terminal = await waitFor(event => event.type === 'process-closed' || (event.type === 'route-event' && event.event === 'done'));
  const observed = events.filter(e => e.type === 'route-event');
  const armed = observed.find(e => e.event === 'armed');
  assert.equal(new Set(armed?.ownerIds).size,2);
  const appends = observed.filter(e => e.event === 'before-append');
  const flushes = observed.filter(e => e.event === 'flush');
  assert.deepEqual(new Set(appends.map(e=>e.id)),new Set(armed.ownerIds));
  assert.equal(appends.length,2);
  assert.equal(flushes.length,2);
  const route = ${JSON.stringify(route)};
  const expectedKind = ['dispose','marked'].includes(route) ? 'normal' : route==='sigterm' ? 'signal' : 'fatal';
  for (const event of appends) { assert.equal(event.receiver,true); assert.equal(event.kind,expectedKind); assert.equal(event.reserved,route==='rejection'); }
  for (const event of flushes) assert.equal(event.persisted,true);
  assert.equal(observed.filter(e=>e.event==='hook').length,route==='rejection'?1:0);
  if (route==='rejection') assert.ok(observed.indexOf(observed.find(e=>e.event==='hook')) < observed.indexOf(appends[0]));
  if (route==='marked') assert.equal(observed.find(e=>e.event==='filtered-observed')?.sameReason,true);
  if (!['dispose','marked'].includes(route)) assert.equal(terminal.code,route==='sigterm'?143:1);
  console.log(JSON.stringify({status:'coverage-gap',route,observed,terminal,stderr:events.filter(e=>e.type==='stderr')},null,2));
  process.exitCode=3;
` + derivative.slice(end);
const root = mkdtempSync(path.join(tmpdir(),'fatal-owner-routes-driver-'));
try {
 const target = path.join(root,'probe.mjs');
 writeFileSync(target,derivative);
 console.log(JSON.stringify({route,derivativeSha256:sha(derivative)}));
 const result = spawnSync(process.execPath,[target],{encoding:'utf8',timeout:90000,maxBuffer:8*1024*1024});
 process.stdout.write(result.stdout??''); process.stderr.write(result.stderr??'');
 assert.ifError(result.error); assert.equal(result.status,3);
 process.exitCode=3;
} finally {rmSync(root,{recursive:true,force:true});}

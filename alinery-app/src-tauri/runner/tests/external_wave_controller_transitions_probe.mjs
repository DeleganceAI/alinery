import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const mode = process.argv[2];
assert.ok(['switch','reload','branch','cancel-switch','cancel-branch','rollback'].includes(mode));
const sha = x => createHash('sha256').update(x).digest('hex');
const dir = path.dirname(fileURLToPath(import.meta.url));
let driver = readFileSync(path.join(dir,'external_ownership_continuation_controller.mjs'),'utf8');
assert.equal(sha(driver),'310b4a46c4306d514f92229c95ec19b7a7e4a211d0584eeb545ca6e7d597e28e');
const base = readFileSync(path.join(dir,'external_controller_ownership_smoke.mjs'),'utf8');
assert.equal(sha(base),'6a98950cfd190e504ac10fa8bcb6ea5cce9351e9f8a9762a47ed34b136a7d1e0');
const cancelled = mode.startsWith('cancel-');
const setup = `
        const transitionMode = ${JSON.stringify(mode)};
        let hookCalls = 0;
`;
const transition = `
        const priorSessionId = session.sessionManager.getSessionId();
        const priorFile = session.sessionManager.getSessionFile();
        {
        const priorMessages = JSON.stringify(session.agent.state.messages);
        const branchEntry = session.sessionManager.getBranch().findLast(e => e.type === 'message' && e.message.role === 'user');
        check(!!branchEntry, 'Missing actual native user entry');
        let targetPath = priorFile;
        if (['switch','rollback','cancel-switch'].includes(transitionMode)) {
          const {mkdirSync} = await import('node:fs');
          const targetCwd = transitionMode === 'rollback' ? config.root + '/other-cwd' : config.root;
          mkdirSync(targetCwd, {recursive:true});
          const target = pi.SessionManager.create(targetCwd, config.sessionsDir);
          for (const entry of session.sessionManager.getBranch()) if (entry.type === 'message') target.appendMessage(entry.message);
          await target.flush();
          targetPath = target.getSessionFile();
          check(targetPath !== priorFile, 'Target must be real distinct session');
        }
        const operation = transitionMode.includes('branch') ? session.branch(branchEntry.id) : session.switchSession(targetPath);
        const observed = operation.then(value => ({value}), error => ({error:String(error)}));
        ${cancelled ? `const result = await observed;
        check(hookCalls === 1, 'Public cancellation hook not reached');
        check(transitionMode === 'cancel-switch' ? result.value === false : result.value?.cancelled === true, 'Hook did not cancel');
        check(session.sessionManager.getSessionId() === priorSessionId && session.sessionManager.getSessionFile() === priorFile, 'Cancelled transition changed transcript');` : `await post('/await', {type:'native-capture-aborted',ordinal:1});`}
        check(active.has('capture-1') && finalize(revision).status === 'waiting', 'Transition cleared pending old capture');
        await post('/release', {key:'refresh-1'});
        ${cancelled ? '' : `const result = await observed;
        check(!result.error, 'Unexpected transition error: ' + result.error);
        if (transitionMode === 'rollback') {
          check(result.value === false && session.sessionManager.getSessionId() === priorSessionId && session.sessionManager.getSessionFile() === priorFile, 'Native cwd rollback failed');
          check(JSON.stringify(session.agent.state.messages) === priorMessages, 'Rollback did not restore actual messages');
        } else if (transitionMode === 'reload') check(result.value === true && session.sessionManager.getSessionId() === priorSessionId, 'Same-file reload failed');
        else check((transitionMode === 'branch' ? result.value?.cancelled === false : result.value === true) && session.sessionManager.getSessionId() !== priorSessionId, 'Native transition failed');`}
        await post('/await', {type:'refresh-held', ordinal:2});
        check(active.has('capture-2') && finalize(revision).status === 'waiting', 'Old replay lost ownership after transition');
        await trace({type:'transition-proof',mode:transitionMode,result,hookCalls,priorSessionId,currentSessionId:session.sessionManager.getSessionId(),active:[...active],sameReceiver:session.sessionManager === originalManager});
        }
        await post('/release', {key:'refresh-2'});
`;
const edits = [
 ['        const pi = api.pi;', '        const pi = api.pi;' + setup],
 ['          autoApprove: true,', `          extensions: [extension => { extension.on(${JSON.stringify(mode.includes('branch')?'session_before_branch':'session_before_switch')}, () => { hookCalls++; return ${cancelled ? '{cancel:true}' : '{}'}; }); }],\n          autoApprove: true,`],
 ['        const nativeCapture =', '        const originalManager = session.sessionManager;\n        const nativeCapture ='],
 ['const primaryStages = new Map();','const primaryStages = new Map();\nconst captureStages = new Map();'],
 ['const ordinal = Math.ceil(captureRequests / 2);', 'const ordinal = events.findLast(event => event.type === "capture-admitted").ordinal;\n        const stage = captureStages.get(ordinal) ?? 0; captureStages.set(ordinal, stage + 1);'],
 ['if (captureRequests % 2 === 1) {','if (stage === 0) {'],
 ['assert.equal(captureRequests, 4);',`assert.equal(captureRequests, ${cancelled?4:3});`],
 ['else response.end("{}");\n      record({ type: "refresh-held"', 'else held.set("refresh-2", response);\n      record({ type: "refresh-held"'],
 ['await nativeCapture(capture);', `await nativeCapture(function (...args) { args[0].addEventListener('abort', () => { void trace({type:'native-capture-aborted',ordinal,active:[...active]}); }, {once:true}); return Reflect.apply(capture,this,args); });`],
 ['await post("/release", { key: "refresh-1" });',transition],
];
const injection = edits.map(([a,b])=>`replace(${JSON.stringify(a)}, ${JSON.stringify(b)});`).join('\n');
assert.equal(driver.split('const root = mkdtempSync').length,2);
driver = driver.replace('const root = mkdtempSync',injection+'\nconst root = mkdtempSync');
driver = driver.replace('"ownership-continuation-"','"controller-transitions-inner-"');
const root = mkdtempSync(path.join(tmpdir(),'controller-transitions-'));
try {
 writeFileSync(path.join(root,'external_controller_ownership_smoke.mjs'),base);
 const script = path.join(root,'driver.mjs'); writeFileSync(script,driver);
 console.log(JSON.stringify({mode,derivativeSha256:sha(driver)}));
 const result = spawnSync(process.execPath,[script,'normal'],{encoding:'utf8',timeout:120000,maxBuffer:12*1024*1024});
 process.stdout.write(result.stdout??''); process.stderr.write(result.stderr??'');
 assert.ifError(result.error); assert.equal(result.status,3,'Transition diagnostic failed');
 console.log(JSON.stringify({mode,status:'coverage-gap',boundedTransitionPassed:true})); process.exitCode=3;
} finally {rmSync(root,{recursive:true,force:true});}

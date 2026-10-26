// Hash-guarded external fixture derivative; no native implementation copied.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const failure = process.argv.includes('--disk-failure');
assert.ok(process.argv.slice(2).every(x => x === '--disk-failure'));
const base = fileURLToPath(new URL('./external_maintenance_lifecycle_smoke.mjs', import.meta.url));
let source = readFileSync(base,'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'),'85fe2fc43683fa0ca376b72f57dcc553231bdb110f9a144300de74e9889c1503');
const replace = (a,b) => { assert.equal(source.split(a).length,2, a.slice(0,100)); source=source.replace(a,b); };
replace('let ordinal = 0;',`let ordinal = 0;
  const diskFailure = ${failure};
  let rewriteError;
  let mutatedBeforeRewrite = false;
  const fs = await import('node:fs/promises');
  const marker = 'RESCUE_ORIGINAL_PAYLOAD_';
  const originalPayload = Array.from({length: 1800}, (_, i) => marker + i.toString(16).padStart(8,'0')).join('\\n');
  const branchText = () => JSON.stringify(session.sessionManager.getBranch());`);
replace('check(result.historyRewritten !== true && compactions === 0 && rewrites === 0, "Native compaction rewrote history");',`check(rewrites > 0 && mutatedBeforeRewrite, 'Actual native rescue mutation not reached');
          check(diskFailure ? Boolean(rewriteError) : result.historyRewritten === true, 'Unexpected rescue result');`);
replace('function (...args) {\n              if (name === "appendCompaction") compactions++;\n              else rewrites++;\n              return original.apply(this, args);\n            },',`function (...args) {
              if (name === 'appendCompaction') { compactions++; return original.apply(this,args); }
              rewrites++;
              mutatedBeforeRewrite = !branchText().includes(marker);
              check(mutatedBeforeRewrite, 'Rewrite did not follow actual native content elision');
              check([...active].some(x => x.startsWith('check:')) && [...active].some(x => x.startsWith('recovery:')), 'Native mutation escaped outer ownership');
              events.push({type:'native-rescue-before-rewrite',mutatedBeforeRewrite,active:[...active]});
              if (!diskFailure || rewriteError) return original.apply(this,args);
              const receiver=this;
              return (async () => {
                const file=session.sessionManager.getSessionFile();
                const saved=file+'.maintenance-rescue-saved';
                await fs.rename(file,saved);
                await fs.mkdir(file);
                try { return await original.apply(receiver,args); }
                catch(error) { rewriteError=String(error); events.push({type:'original-rewrite-rejected',error:rewriteError,active:[...active]}); throw error; }
                finally { await fs.rmdir(file); await fs.rename(saved,file); }
              })();
            },`);
replace('const prompt = session.prompt("MAINTENANCE_RECOVERY: give a brief answer.");', 'const prompt = session.prompt("MAINTENANCE_RECOVERY: give a brief answer.\\n```text\\n" + originalPayload + "\\n```");');
replace('check(recoveryCalls === 1 && discarded === 1 && restored === 1, "Unexpected recovery/removal/restoration counts");', 'check(recoveryCalls === 1 && discarded === 1 && restored === (diskFailure ? 1 : 0), "Unexpected recovery/removal/restoration counts");');
replace('check(failedEntries().length === 1 && session.messages.includes(failedMessage), "Failed turn not restored to branch and active context");', 'check(failedEntries().length === (diskFailure ? 1 : 0) && session.messages.includes(failedMessage) === diskFailure, "Unexpected conditional rollback state");');
replace('check(active.size === 0 && compactions === 0 && rewrites === 0, "Unexpected pending work or compaction rewrite");', 'check(active.size === 0 && compactions === 0 && rewrites === 1, "Unexpected pending work or compaction rewrite");\n      check(!branchText().includes(marker), "Native mutation unexpectedly restored by rollback");');
replace('check(persisted.includes("Native incomplete answer") && persisted.includes(\'"length"\'), "Restored history not flushed to native journal");', 'check(!persisted.includes(marker), "Elision not persisted after original recovery settled");\n      events.push({type:"final-state", diskFailure, rewriteError, restored, mutatedBeforeRewrite, historyRewritten: recoveryResult.historyRewritten === true});');
replace('const base = fileURLToPath(new URL("./external_maintenance_ownership_smoke.mjs", import.meta.url));',`const base = ${JSON.stringify(fileURLToPath(new URL('./external_maintenance_ownership_smoke.mjs',import.meta.url)))};`);
replace('"maintenance-lifecycle-derivative-"','"maintenance-rescue-inner-"');
replace('native-no-rewrite-result-held', 'native-rescue-result-held');
replace('native-restoration-settled-and-flushed', 'native-recovery-settled-and-flushed');
replace('native-incomplete-recovery-no-rewrite', 'native-incomplete-recovery-rescue');
const root=mkdtempSync(path.join(tmpdir(),'maintenance-rescue-derivative-'));
try {
 const script=path.join(root,'probe.mjs'); writeFileSync(script,source);
 console.log(JSON.stringify({mode:failure?'disk-failure':'rescue-success',derivativeSha256:createHash('sha256').update(source).digest('hex')}));
 const child=spawn(process.execPath,[script],{stdio:'inherit',env:process.env});
 process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code??1));});
} finally {rmSync(root,{recursive:true,force:true});}

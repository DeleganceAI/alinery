import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const input = readFileSync(new URL('./external_py_lifecycle_smoke.mjs', import.meta.url),'utf8');
assert.equal(createHash('sha256').update(input).digest('hex'),'abd5adec33e00d6e2ffda48e2c8d177ad59dad1a808b9a83da4143a641384057');
let source=input;
function replace(a,b) { assert.equal(source.split(a).length,2,'unique anchor'); source=source.replace(a,b); }
replace('alinery-py-lifecycle-', 'nested-eval-native-');
replace('const activeBackends = new Map();', 'let scope; const captures = []; const kernelObjects = [];');
replace('const originalBackend = backend.execute;', 'scope = new (await import("node:async_hooks")).AsyncLocalStorage();\n        const originalBackend = backend.execute;');
const begin=source.indexOf('          // Exact native public sessionFile');
const end=source.indexOf('\n        };',begin);
assert.ok(begin>0 && end>begin);
source=source.slice(0,begin)+`          owner.toolSession = options.session;
          const capture = { owner, signal: options.signal, invocation: captures.length + 1, active: true, code };
          captures.push(capture);
          return scope.run(capture, () => Promise.resolve(originalBackend.call(this, code, options)).finally(() => {capture.active=false;}));`+source.slice(end);
replace(`          const captures = activeBackends.get(options.env.PI_SESSION_FILE);
          if (!captures) return original.call(this, code, options);
          check(captures.size === 1, "Ambiguous native sessionFile correlation; refusing guessed owner");
          const capture = [...captures][0];`, `          const capture = scope.getStore();
          check(capture?.active, "Missing/stale per-invocation host scope");
          // Code is an independent fixture oracle, never the source of owner identity.
          check(capture.code === code, "Scope attributed another invocation's code");
          check(typeof options.id === "string", "Missing actual native run ID");
          capture.run = options.id;
          capture.overlapping = captures.filter(c => c.active).length;
          capture.kernel = kernelObjects.indexOf(this);
          if (capture.kernel < 0) capture.kernel = kernelObjects.push(this)-1;`);
replace('record.run = body.run;', 'record.run = body.run; record.invocation = target.invocation;');
replace('for (const name of ["Pre", "Cancel", "Release", "Peer"])', 'for (const name of ["Peer"])');
const start=source.indexOf('        const pre = prepare("pre");');
const stop=source.indexOf('\n      } catch (error) {',start);
assert.ok(start>0 && stop>start);
source=source.slice(0,start)+`        const first = prepare("first");
        const second = prepare("second");
        const firstCell = run(owner("Peer"), "first");
        const secondCell = run(owner("Peer"), "second");
        // Both backend invocations overlap before any native completion forwarding.
        const arrived = await bounded(Promise.race([first.reached.promise.then(()=>first), second.reached.promise.then(()=>second)]), "either completion admission");
        const next = arrived === first ? second : first;
        check(captures.filter(c=>c.active).length === 2, "Backend calls did not overlap");
        check(!(await post("/state")).keys.length, "Producer ran before admission");
        arrived.admission.resolve(); arrived.reply.resolve();
        await bounded(arrived.bound.promise, "first arriving native ID");
        await bounded(next.reached.promise, "next completion admission");
        next.admission.resolve(); next.reply.resolve();
        await bounded(next.bound.promise, "next native ID");
        await bounded(Promise.all([firstCell,secondCell]), "overlap cell returns");
        check(leases.has(first) && leases.has(second), "Cell return released pending producer");
        const third = prepare("reuse");
        const thirdCell = run(owner("Peer"), "reuse");
        await bounded(third.reached.promise, "reused kernel admission");
        third.admission.resolve(); third.reply.resolve();
        await bounded(third.bound.promise, "reused native ID");
        await bounded(thirdCell, "reused cell return");
        check(captures.length === 3, "Unexpected backend invocation count");
        check(new Set(captures.map(c=>c.run)).size === 3, "Native run identity reused");
        check(new Set(captures.map(c=>c.kernel)).size === 1, "Kernel was not reused");
        check(new Set([first,second,third].map(r=>r.id)).size === 3, "Producer identity reused");
        for (const r of [first,second,third]) {
          const c=captures.find(c=>c.invocation===r.invocation);
          check(c && c.run===r.run && c.owner===owner("Peer"), "Request attribution mismatch");
          check(leases.has(r), "Pending unused producer lost ownership");
        }
        await post("/release", {key:"second"}); await bounded(second.wait,"second settlement");
        check(leases.has(first) && leases.has(third), "Second release cleared sibling");
        for (const r of [first,third]) {await post("/release",{key:r.key}); await bounded(r.wait,"remaining native wait");}
        for (const r of [first,second,third]) check(r.terminal?.status==="completed" && r.terminal.text==="native-result", "Native producer failed");
        report("overlapping-same-owner-and-reused-python-kernel", "passed-bounded-subset", {
          captures:captures.map(c=>({invocation:c.invocation,run:c.run,kernel:c.kernel,overlapping:c.overlapping,active:c.active})),
          records:[first,second,third].map(r=>({...summary(r),invocation:r.invocation})),
          identity:"fresh host scope at original PythonKernel.execute; actual session/run; separate request and producer"
        });
        report("general-nested-finalization", "coverage-gap", {reason:"No ancestor exemption, cached-consumer admission, cancellation-catching nested eval or durable finalization implemented"});`+source.slice(stop);
replace('"Overlapping cells sharing one sessionFile fail closed, not guessed",', '"Overlapping same-owner invocation attribution tested; nested finalization remains unproved",');
replace('"Owner release holds actual native auth prerequisite, not an abort-insensitive transport cleanup matrix",', '"This derivative exercises identity, not owner disposal or transport cleanup",');
const dir=mkdtempSync(join(tmpdir(),'nested-eval-driver-'));
try {
 const file=join(dir,'probe.mjs'); writeFileSync(file,source);
 console.log(JSON.stringify({derivativeSha256:createHash('sha256').update(source).digest('hex')}));
 const run=spawnSync(process.execPath,[file],{env:process.env,stdio:'inherit',timeout:150000});
 if(run.error) throw run.error;
 process.exitCode=run.status ?? 1;
} finally {rmSync(dir,{recursive:true,force:true});}

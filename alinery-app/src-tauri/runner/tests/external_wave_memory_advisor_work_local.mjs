// Native local-memory capture derivative; no memory-service mock or native copy.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
const sha = b => createHash('sha256').update(b).digest('hex');
const original = new URL('./external_autolearn_smoke.mjs', import.meta.url);
let source = readFileSync(original, 'utf8');
assert.equal(sha(source), '60e0b19a3c82ac6e715865c788e3c7e5567e696a96bc292a8e1f7b1b2564ecf3');
assert.equal(sha(readFileSync('/Applications/Alinery.omp/omp')), '9d4b74e20502f06348143fc3fbd630326d16c1a11a7eb0a94b44e5818aa78e47');
function replace(before, after) {
  assert.equal(source.split(before).length, 2, `Expected unique anchor: ${before}`);
  source = source.replace(before, after);
}
replace('existsSync, mkdirSync,', 'readdirSync, existsSync, mkdirSync,');
replace('"alinery-autolearn-"', '"memory-advisor-work-native-"');
replace('"autolearn.enabled": true,', '"memory.backend": "local", "autolearn.enabled": true,');
replace('          answer(response, [\n            {', '          assert.ok(names.includes("learn"), "Native local learn tool missing");\n          answer(response, [\n            { name: "learn", input: { memory: `Memory advisor native lesson ${ordinal}.`, context: "isolated capture" } },\n            {');
replace('const skillPath =', `const learnedFiles = () => readdirSync(agentDir, { recursive: true }).filter(p => p.endsWith("learned.md")).map(p => path.join(agentDir, p));
const verifyLearned = ordinal => {
  const files = learnedFiles();
  assert.equal(files.length, 1, "Expected exactly one native learned.md");
  const text = readFileSync(files[0], "utf8");
  for (let n = 1; n <= ordinal; n++) assert.ok(text.includes(\x60Memory advisor native lesson \x24{n}.\x60), "Native memory lesson missing");
  record({ type: "native-memory-persisted", ordinal, bytes: Buffer.byteLength(text), relativePath: path.relative(agentDir, files[0]) });
};
const skillPath =`);
replace('    } else if (request.url === "/refresh-latch") {', '    } else if (request.url === "/refresh-latch") {\n      verifyLearned(body.ordinal);\n      assert.ok(body.active.includes(`capture-${body.ordinal}`), "Memory write observed outside capture scope");');
replace('        assert.equal(captureRequests, 0, "Capture dispatched before external admission release");', '        assert.equal(captureRequests, 0, "Capture dispatched before external admission release");\n        assert.equal(learnedFiles().length, 0, "Memory written before capture admission");');
const root = mkdtempSync(path.join(tmpdir(), 'memory-advisor-work-driver-'));
const file = path.join(root, 'native.mjs');
writeFileSync(file, source);
console.log(JSON.stringify({ derivativeSha256: sha(source), scope: 'native local learn plus managed-skill refresh; not controller or advisor closure' }));
try {
  const child = spawn(process.execPath, [file], { stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 0, 'Native derivative failed');
  console.log(JSON.stringify({ status: 'coverage-gap', localLearn: 'passed-bounded-subset', advisorLifecycle: 'source-only', durableAuthority: false }));
  process.exitCode = 3;
} finally { rmSync(root, { recursive: true, force: true }); }

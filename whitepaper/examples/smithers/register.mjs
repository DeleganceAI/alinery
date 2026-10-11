// Resolve unpublished Smithers source exports; all execution remains upstream code.
import { registerHooks } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(process.env.SMITHERS_SOURCE ?? '../smithers-source');
const expected = '8fee1a6d88ef0308159cb1c9bd6a462ebf660724';
const actual = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (actual !== expected) throw new Error(`Expected Smithers ${expected}, found ${actual}`);
const packages = new Map();
for (const entry of readdirSync(join(root, 'packages/smithers/flows'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = join(root, 'packages/smithers/flows', entry.name);
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    packages.set(manifest.name, { dir, exports: manifest.exports });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@smthrs/')) {
      const [scope, name, ...tail] = specifier.split('/');
      const pkg = packages.get(`${scope}/${name}`);
      if (!pkg) throw new Error(`Unmapped Smithers package: ${specifier}`);
      const key = tail.length ? `./${tail.join('/')}` : '.';
      const target = pkg.exports[key];
      if (typeof target !== 'string') throw new Error(`Unsupported source export: ${specifier}`);
      return { url: pathToFileURL(join(pkg.dir, target)).href, shortCircuit: true };
    }
    if (specifier === 'effect' || specifier.startsWith('effect/') || specifier.startsWith('@effect/')) {
      return nextResolve(specifier, { ...context, parentURL: import.meta.url });
    }
    return nextResolve(specifier, context);
  }
});

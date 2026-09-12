import { writeFileSync } from 'node:fs';
// Tell Node how to interpret each build's .js files, regardless of the
// "type" field in the root package.json.
writeFileSync('dist/esm/package.json', JSON.stringify({ type: 'module' }) + '\n');
writeFileSync('dist/cjs/package.json', JSON.stringify({ type: 'commonjs' }) + '\n');

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  outfile: 'dist/index.js',
  sourcemap: true,
  legalComments: 'none',
  packages: 'bundle',
  logLevel: 'info',
});

mkdirSync(resolve('dist'), { recursive: true });
writeFileSync(resolve('dist/package.json'), JSON.stringify({ type: 'commonjs' }, null, 2));
console.log('Built dist/index.js');

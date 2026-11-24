#!/usr/bin/env node
// Runs the API server (node --watch, TypeScript stripped natively) and the Vite dev server together.
import { spawn } from 'node:child_process';

const children = [
  spawn(process.execPath, ['--watch', 'src/server/main.ts'], { stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' }),
];

const stop = () => {
  for (const child of children) child.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of children) child.on('exit', (code) => code && stop());

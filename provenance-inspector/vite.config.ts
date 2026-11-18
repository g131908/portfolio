import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: 'src/web',
  base: './',
  worker: { format: 'es' },
  build: { outDir: '../../demo', emptyOutDir: true, target: 'es2022' },
  test: {
    root: '.',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});

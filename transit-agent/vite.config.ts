import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: 'src/web',
  base: './',
  build: { outDir: '../../demo', emptyOutDir: true },
  test: {
    root: '.',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});

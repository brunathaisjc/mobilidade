import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Testes de integração compartilham o banco de teste: execução sequencial entre arquivos.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
    globalSetup: ['test/global-setup.ts'],
  },
});

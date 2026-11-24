import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  test: {
    environment: 'node',
    env: {
      DATABASE_URL: process.env.TEST_APP_URL ?? 'postgres://stock_app:test_app_password_1234@127.0.0.1:5432/stock_test',
      TEST_OWNER_URL: process.env.TEST_OWNER_URL ?? 'postgres://postgres:devpg@127.0.0.1:5432/stock_test',
      OPERATOR_CODE: 'OPERATOR',
      COOKIE_SECURE: 'false',
    },
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});

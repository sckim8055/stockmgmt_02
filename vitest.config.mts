import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// 테스트는 실제 앱 역할(stock_app)이 아닌 전용 역할을 쓰고, 비밀번호는 실행할 때마다 새로 만든다.
// 역할은 DB 서버 전체에 공유되므로, 같은 서버에 개발·운영 DB가 있어도 그쪽 역할을 건드리지 않게 하기 위해서다.
const APP_ROLE = 'stock_app_test';
const appPassword = process.env.TEST_APP_PASSWORD ?? randomBytes(18).toString('hex');
process.env.TEST_APP_PASSWORD = appPassword;
const host = process.env.TEST_DB_HOST ?? '127.0.0.1:5432';
const ownerUrl = process.env.TEST_OWNER_URL ?? `postgres://postgres:devpg@${host}/stock_test`;
process.env.TEST_OWNER_URL = ownerUrl;

export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  test: {
    environment: 'node',
    env: {
      DATABASE_URL: `postgres://${APP_ROLE}:${appPassword}@${host}/stock_test`,
      TEST_OWNER_URL: ownerUrl,
      APP_DB_ROLE: APP_ROLE,
      OPERATOR_CODE: 'OPERATOR',
      COOKIE_SECURE: 'false',
      TRUSTED_IP_HEADER: 'x-test-client-ip',
    },
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});

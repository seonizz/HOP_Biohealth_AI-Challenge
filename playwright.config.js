import {defineConfig,devices} from '@playwright/test';
export default defineConfig({
  testDir:'./tests/e2e',testMatch:'original-backend.spec.js',fullyParallel:false,workers:1,timeout:60000,
  expect:{timeout:15000},reporter:[['list'],['html',{open:'never'}]],
  use:{baseURL:process.env.MALSSI_TEST_URL||'http://localhost:18080',trace:'retain-on-failure',screenshot:'only-on-failure'},
  projects:[{name:'chromium',use:{...devices['Desktop Chrome']}}],
});

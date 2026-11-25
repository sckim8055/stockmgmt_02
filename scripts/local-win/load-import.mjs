// Loads prepared upload files into the locally running app, through the app's own HTTP API
// (the same login, permission checks and import code a person would use in the browser).
//
// For each company in <import dir>/load.json:
//   create the company and its admin (if missing) -> create custom fields from fields.json -> upload 1_직원, 2_자산, 3_주변기기.
// Passwords are generated here and written to <secrets dir>/accounts.txt. They are never printed.
// Safe to run again: finished steps are remembered in <secrets dir>/loader-state.json and skipped.
import { spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.STOCK_BASE_URL ?? 'http://127.0.0.1:3000';
const IMPORT_DIR = process.env.STOCK_IMPORT_DIR;
const SECRETS = process.env.STOCK_SECRETS_DIR;
if (!IMPORT_DIR || !SECRETS) throw new Error('STOCK_IMPORT_DIR and STOCK_SECRETS_DIR are required (run load-import.cmd).');
const OPERATOR = (process.env.OPERATOR_CODE ?? 'OPERATOR').toUpperCase();
const STATE_FILE = path.join(SECRETS, 'loader-state.json');
const FILES = [['persons', '1_직원.xlsx'], ['assets', '2_자산.xlsx'], ['peripherals', '3_주변기기.xlsx']];

mkdirSync(SECRETS, { recursive: true });
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : { system: null, companies: {} };
function save() {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
  const lines = ['StockMgmt local accounts (created by load-import). Change these passwords after the first login.', '',
    'company code | login id | password', '-------------+----------+---------'];
  if (state.system) lines.push(`${OPERATOR} | ${state.system.loginId} | ${state.system.password}   (system administrator)`);
  for (const [code, c] of Object.entries(state.companies)) if (c.password) lines.push(`${code} | ${c.loginId} | ${c.password}   (company administrator)`);
  writeFileSync(path.join(SECRETS, 'accounts.txt'), lines.join('\r\n') + '\r\n');
}

function newPassword(loginId) {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789'];
  for (;;) {
    let out = '';
    for (let i = 0; i < 20; i++) { const set = sets[i < 3 ? i : randomInt(3)]; out += set[randomInt(set.length)]; }
    if (!out.toLowerCase().includes(loginId.toLowerCase())) return out;
  }
}

class Session {
  cookie = '';
  async call(method, url, body, raw) {
    const headers = { origin: BASE, ...(this.cookie ? { cookie: this.cookie } : {}) };
    if (raw) headers['content-type'] = 'application/octet-stream';
    else if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(BASE + url, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) this.cookie = set.map((c) => c.split(';')[0]).join('; ');
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, data };
  }
  async login(companyCode, loginId, password) {
    const r = await this.call('POST', '/api/auth/login', { companyCode, loginId, password });
    if (r.status !== 200) throw new Error(`Login failed for ${companyCode}/${loginId} (HTTP ${r.status}). If the password was changed by hand, delete ${STATE_FILE} entries for it.`);
  }
  /** Log in with a temporary password and replace it. Returns the new password. */
  async firstLogin(companyCode, loginId, tempPassword) {
    await this.login(companyCode, loginId, tempPassword);
    const password = newPassword(loginId);
    const r = await this.call('POST', '/api/auth/change-password', { currentPassword: tempPassword, newPassword: password });
    if (r.status !== 200) throw new Error(`Could not set the password for ${loginId}: ${r.data?.error?.message ?? r.status}`);
    return password;
  }
}

function envFromFile() {
  const env = { ...process.env };
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

async function systemSession() {
  const s = new Session();
  if (state.system) { await s.login(OPERATOR, state.system.loginId, state.system.password); return s; }
  for (const loginId of ['root', 'setup']) {
    const r = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/create-system-admin.ts', loginId, loginId === 'root' ? 'Root Admin' : 'Setup Admin'], { env: envFromFile(), encoding: 'utf8' });
    const temp = /\):\s*(\S+)\s*$/m.exec(r.stdout ?? '')?.[1];
    if (r.status !== 0 || !temp) { console.log(`  system administrator "${loginId}" could not be created (it may already exist).`); continue; }
    const password = await s.firstLogin(OPERATOR, loginId, temp);
    state.system = { loginId, password }; save();
    console.log(`  system administrator "${loginId}" created.`);
    return s;
  }
  throw new Error('Could not create a system administrator.');
}

async function loadCompany(sys, entry) {
  const dir = path.join(IMPORT_DIR, entry.dir);
  const code = entry.code.toUpperCase();
  console.log(`\n== ${code} (${entry.name})`);
  let c = state.companies[code];
  const s = new Session();
  if (!c) {
    const list = await sys.call('GET', '/api/system/companies');
    if (list.data?.companies?.some((x) => String(x.code).toUpperCase() === code)) {
      console.log('  this company already exists and was not created by this tool. Skipped (nothing was changed).');
      return false;
    }
    const made = await sys.call('POST', '/api/system/companies', { code, name: entry.name, timezone: 'Asia/Seoul', locale: 'ko', admin: { loginId: 'admin', displayName: `${entry.name} 관리자` } });
    if (made.status !== 201) throw new Error(`Company ${code} could not be created: ${JSON.stringify(made.data?.error ?? made.status)}`);
    c = state.companies[code] = { loginId: 'admin', password: null, temp: made.data.tempPassword, done: [] }; save();
    console.log('  company and administrator created.');
  }
  if (!c.password) { c.password = await s.firstLogin(code, c.loginId, c.temp); delete c.temp; save(); }
  else await s.login(code, c.loginId, c.password);

  const fieldsFile = path.join(dir, 'fields.json');
  if (existsSync(fieldsFile)) {
    const have = new Set(((await s.call('GET', '/api/master/custom-fields')).data?.fields ?? []).map((f) => f.key));
    let added = 0;
    for (const [i, f] of JSON.parse(readFileSync(fieldsFile, 'utf8')).entries()) {
      if (have.has(f.key)) continue;
      const r = await s.call('POST', '/api/master/custom-fields', { key: f.key, label: f.label, dataType: f.dataType, sortOrder: (i + 1) * 10 });
      if (r.status !== 201) throw new Error(`Custom field ${f.key}: ${JSON.stringify(r.data?.error ?? r.status)}`);
      added++;
    }
    console.log(`  custom fields: ${added} added, ${have.size} already there.`);
  }

  for (const [kind, file] of FILES) {
    const full = path.join(dir, file);
    if (c.done.includes(kind)) { console.log(`  ${file}: already loaded, skipped.`); continue; }
    if (!existsSync(full)) { console.log(`  ${file}: not found, skipped.`); continue; }
    const bytes = readFileSync(full);
    for (const mode of ['preview', 'commit']) {
      const r = await s.call('POST', `/api/import/${kind}?mode=${mode}`, undefined, bytes);
      const errors = r.data?.errors ?? [];
      if (errors.length || (r.status !== 200) || (mode === 'commit' && !r.data?.committed)) {
        console.log(`  ${file}: NOT loaded (${mode}, HTTP ${r.status}). ${errors.length} error(s):`);
        for (const e of errors.slice(0, 30)) console.log(`     row ${e.row}: ${e.message}`);
        if (!errors.length) console.log(`     ${JSON.stringify(r.data?.error ?? r.data)}`);
        return false;
      }
      if (mode === 'commit') console.log(`  ${file}: ${r.data.totalRows} rows loaded.`);
    }
    c.done.push(kind); save();
  }
  return true;
}

const probe = await fetch(BASE + '/login').catch(() => null);
if (!probe?.ok) throw new Error(`The app is not running at ${BASE}. Start it with start.cmd first, and leave that window open.`);
const manifest = JSON.parse(readFileSync(path.join(IMPORT_DIR, 'load.json'), 'utf8'));
console.log('== system administrator');
const sys = await systemSession();
let ok = true;
for (const entry of manifest) ok = (await loadCompany(sys, entry)) && ok;
save();
console.log(ok ? '\n== All done.' : '\n== Finished with problems (see above). Fix the files and run again; finished steps are skipped.');
console.log(`Accounts and passwords: ${path.join(SECRETS, 'accounts.txt')}`);

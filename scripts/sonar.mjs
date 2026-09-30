import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '..');
const local = path.join(root, '.local', 'sonar');
const credentialsFile = path.join(local, 'credentials.json');
const envFile = path.join(local, 'runtime.env');
const baseUrl = 'http://127.0.0.1:9000';
const projectKey = 'ai-duo-local';
let credentials;

/** Strip control characters so HTTP- or environment-derived text cannot forge log lines. */
function clean(value) {
  return String(value).replaceAll(/[\u0000-\u001f]/g, ' ');
}

async function prepare() {
  await mkdir(local, { recursive: true });
  try { credentials = JSON.parse(await readFile(credentialsFile, 'utf8')); }
  catch (err) {
    if (err.code !== 'ENOENT') throw err;
    credentials = { login: 'admin', adminPassword: `AiDuo!${randomBytes(24).toString('base64url')}`, databasePassword: randomBytes(32).toString('hex') };
    await saveCredentials();
  }
  await writeFile(envFile, `SONAR_DB_PASSWORD=${credentials.databasePassword}\nSONAR_SCAN_TOKEN=${credentials.scanToken ?? ''}\n`, { mode: 0o600 });
}

async function saveCredentials() {
  await writeFile(credentialsFile, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
}

// Resolve docker from absolute PATH entries only, so a relative entry cannot hijack the command.
function dockerExecutable() {
  const names = process.platform === 'win32' ? ['docker.exe'] : ['docker'];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    for (const name of names) {
      const file = path.join(dir, name);
      try { accessSync(file, constants.X_OK); return file; } catch { /* keep looking */ }
    }
  }
  throw new Error('docker was not found in PATH');
}

function compose(args) {
  const result = spawnSync(dockerExecutable(), ['compose', '--env-file', envFile, '-f', path.join(root, 'compose.sonar.yml'), ...args], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

async function api(endpoint, { auth = true, password = credentials?.adminPassword, data } = {}) {
  const headers = {};
  if (auth) headers.Authorization = 'Basic ' + Buffer.from(`admin:${password}`).toString('base64');
  if (data) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  let response;
  for (let attempt = 0; ; attempt++) {
    try {
      response = await fetch(`${baseUrl}${endpoint}`, {
        method: data ? 'POST' : 'GET', headers,
        body: data ? new URLSearchParams(data) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
      break;
    } catch (err) {
      // GET requests can be retried after a startup connection reset; never repeat a mutation.
      if (data || attempt === 2) throw new Error(`SonarQube API ${endpoint}: ${err.message}`, { cause: err });
      await delay(1000);
    }
  }
  const body = await response.text();
  if (!response.ok) {
    const err = new Error(`SonarQube API ${endpoint}: HTTP ${response.status} ${body}`);
    err.status = response.status;
    throw err;
  }
  return body ? JSON.parse(body) : undefined;
}

async function waitForServer() {
  const deadline = Date.now() + 300_000;
  let lastStatus;
  while (Date.now() < deadline) {
    try {
      const status = await api('/api/system/status', { auth: false });
      if (status.status === 'UP') return status;
      if (status.status !== lastStatus) console.log(`SonarQube: ${status.status}`);
      lastStatus = status.status;
    } catch { /* Startup can reset connections before the web process is ready. */ }
    await delay(3000);
  }
  throw new Error('SonarQube did not start within 5 minutes. Inspect: pnpm sonar:logs');
}

async function bootstrap() {
  const login = await api('/api/authentication/validate');
  if (!login.valid) {
    // Replace the documented first-start password; subsequent starts use the saved password.
    await api('/api/users/change_password', { password: 'admin', data: { login: 'admin', previousPassword: 'admin', password: credentials.adminPassword } });
    if (!(await api('/api/authentication/validate')).valid) throw new Error('Administrator login validation failed');
  }
  try { await api(`/api/components/show?component=${projectKey}`); }
  catch (err) {
    if (err.status !== 404) throw err;
    await api('/api/projects/create', { data: { project: projectKey, name: 'AI Duo (local)', visibility: 'private' } });
  }
  if (!credentials.scanToken) {
    const name = 'ai-duo-local-scanner';
    let generated;
    try { generated = await api('/api/user_tokens/generate', { data: { name, type: 'PROJECT_ANALYSIS_TOKEN', projectKey } }); }
    catch (err) {
      if (err.status !== 400) throw err;
      await api('/api/user_tokens/revoke', { data: { name } });
      generated = await api('/api/user_tokens/generate', { data: { name, type: 'PROJECT_ANALYSIS_TOKEN', projectKey } });
    }
    credentials.scanToken = generated.token;
    await saveCredentials();
    await prepare();
  }
}

async function start() {
  const exit = compose(['up', '-d', 'db', 'sonarqube']);
  if (exit) throw new Error(`Docker Compose start failed (exit ${exit})`);
  const server = await waitForServer();
  await bootstrap();
  console.log(`SonarQube ${server.version} ready: ${baseUrl}/dashboard?id=${projectKey}`);
  console.log(`Login: admin. Saved password: ${credentialsFile}`);
}

async function status() {
  const server = await api('/api/system/status', { auth: false });
  console.log(`SonarQube ${clean(server.version)}: ${clean(server.status)}`);
  if (server.status !== 'UP') return;
  const gate = await api(`/api/qualitygates/project_status?projectKey=${projectKey}`);
  const issues = await api(`/api/issues/search?componentKeys=${projectKey}&resolved=false&ps=1`);
  const report = { url: `${baseUrl}/dashboard?id=${projectKey}`, gate: gate.projectStatus, openIssues: issues.total, checkedAt: new Date().toISOString() };
  await writeFile(path.join(local, 'analysis.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Quality Gate: ${clean(report.gate.status)}. Open issues: ${clean(report.openIssues)}.`);
  for (const condition of report.gate.conditions ?? []) {
    if (condition.status === 'ERROR') console.log(`  ${condition.metricKey}: ${condition.actualValue} (threshold ${condition.errorThreshold})`);
  }
  console.log(report.url);
}

async function scan() {
  await start();
  const exit = compose(['run', '--rm', '--no-deps', 'scanner']);
  // Scanner also exits unsuccessfully when upload succeeded but the Quality Gate failed.
  await status();
  process.exitCode = exit;
}

try {
  const command = process.argv[2] ?? 'status';
  if (!['up', 'scan', 'status', 'down', 'logs'].includes(command)) throw new Error('Usage: node scripts/sonar.mjs up|scan|status|down|logs');
  await prepare();
  if (command === 'up') await start();
  else if (command === 'scan') await scan();
  else if (command === 'status') await status();
  else if (command === 'down') process.exitCode = compose(['down']); // Keep database and analysis volumes.
  else process.exitCode = compose(['logs', '--tail=100', 'sonarqube']);
} catch (err) {
  let message = err.message;
  for (const secret of [credentials?.adminPassword, credentials?.databasePassword, credentials?.scanToken]) {
    if (secret) message = message.replaceAll(secret, '[redacted]');
  }
  console.error(clean(message));
  process.exitCode = 1;
}

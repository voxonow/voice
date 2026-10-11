// Safety and configuration checks of bench/capture-eval.mjs: unit tests of
// capture-config.mjs, then the script itself run with refusing or --check
// configurations. No test here starts a browser, Docker or the voice server,
// or leaves this machine: every host below is fictitious, and every run is
// refused or stopped by --check before anything starts (one test holds a
// loopback port to provoke a refusal).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  Refused,
  actualSuppressor,
  describeChain,
  parseEnvFile,
  redactor,
  resolveCloudTarget,
  resolveKrisp,
  selectChains,
  verifyDedicatedProject,
} from './capture-config.mjs';

const P = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const CHAINS = {
  'ours-product': { engine: 'ours', constraints: P },
  'ours-rnnoise': { engine: 'ours', constraints: P, method: 'rnnoise' },
  'livekit-product': { engine: 'livekit', constraints: P },
  'livekit-krisp': { engine: 'livekit', constraints: P, krisp: true, krispCheckOnly: true },
  'cloud-product': { engine: 'livekit', cloud: true, constraints: P },
  'cloud-krisp': { engine: 'livekit', cloud: true, constraints: P, krisp: true },
};

const HOST = 'bench-test-0000.livekit.cloud';
const KEY = 'APItestkey0000';
const SECRET = 'test-secret-0000000000000000000000000000';
const bench = (over = {}) => ({ LIVEKIT_BENCH_URL: `wss://${HOST}`, LIVEKIT_BENCH_KEY: KEY, LIVEKIT_BENCH_SECRET: SECRET, LIVEKIT_BENCH_TEST_HOST: HOST, ...over });
const toFile = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join('\n');

/** Asserts a refusal whose message leaks none of the configured values. */
function refused(fn, pattern, values = [HOST, KEY, SECRET]) {
  let error;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof Refused, `expected a refusal, got ${error}`);
  assert.match(error.message, pattern);
  for (const v of values) assert.ok(!error.message.includes(v), 'refusal message leaks a configured value');
}

describe('chains', () => {
  test('default selection leaves out Krisp and cloud chains', () => {
    assert.deepEqual(selectChains(undefined, CHAINS), ['ours-product', 'ours-rnnoise', 'livekit-product']);
  });
  test('Krisp and cloud chains run when named', () => {
    assert.deepEqual(selectChains('livekit-krisp,cloud-product', CHAINS), ['livekit-krisp', 'cloud-product']);
  });
  test('unknown or empty selection is refused', () => {
    refused(() => selectChains('ours-product,nope', CHAINS), /unknown chain "nope"/);
    refused(() => selectChains(' , ', CHAINS), /selects no chain/);
  });
  test('description states browser processing, suppressor and engine', () => {
    assert.equal(describeChain(CHAINS['ours-rnnoise']), 'Chrome capture EC on / NS on / AGC on · suppressor rnnoise (demo/src/noise.ts) · Voxonow engine, local');
    assert.match(describeChain(CHAINS['livekit-krisp'], { livekitVersion: 'v1.13.7', krisp: { version: '0.4.4' } }), /suppressor Krisp 0\.4\.4 \(enablement check.*LiveKit v1\.13\.7 local$/);
    assert.match(describeChain(CHAINS['cloud-product']), /no suppressor · LiveKit Cloud test project/);
  });
  test('actual suppressor: Krisp counts only when it enabled', () => {
    assert.equal(actualSuppressor(CHAINS['ours-product'], {}), 'none');
    assert.equal(actualSuppressor(CHAINS['ours-rnnoise'], {}), 'rnnoise');
    assert.equal(actualSuppressor(CHAINS['cloud-krisp'], { krispEnabled: true, krispEnabledAtEnd: true }), 'krisp (enabled)');
    assert.equal(actualSuppressor(CHAINS['cloud-krisp'], { krispEnabled: false, krispEnabledAtEnd: true }), 'krisp (enabled by the end only)');
    assert.equal(actualSuppressor(CHAINS['cloud-krisp'], { krispEnabled: true, krispEnabledAtEnd: false }), 'krisp (enabled early only)');
    assert.match(actualSuppressor(CHAINS['livekit-krisp'], { krispEnabled: false, krispEnabledAtEnd: false }), /NOT enabled/);
    assert.match(actualSuppressor(CHAINS['livekit-krisp'], { krispEnabled: undefined }), /NOT enabled/);
  });
});

describe('Krisp package', () => {
  const pkg = (name, version = '0.4.4') => JSON.stringify({ name, version });
  const files = (map) => (p) => {
    if (!(p in map)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return map[p];
  };
  test('missing package is a clear refusal, not a silent fallback', () => {
    refused(() => resolveKrisp({ chainNames: ['livekit-krisp'], env: {}, root: '/repo', readText: files({}) }), /livekit-krisp need @livekit\/krisp-noise-filter.*KRISP_PACKAGE_DIR.*TEAM_COMMS_DIR.*Nothing was run/s, []);
  });
  test('default location is ../team-comms/node_modules; TEAM_COMMS_DIR and KRISP_PACKAGE_DIR override', () => {
    const at = (p) => files({ [join(p, 'package.json')]: pkg('@livekit/krisp-noise-filter') });
    assert.equal(resolveKrisp({ chainNames: ['x'], env: {}, root: '/repo', readText: at('/team-comms/node_modules/@livekit/krisp-noise-filter') }).version, '0.4.4');
    assert.equal(resolveKrisp({ chainNames: ['x'], env: { TEAM_COMMS_DIR: '/tc' }, root: '/repo', readText: at('/tc/node_modules/@livekit/krisp-noise-filter') }).dir, '/tc/node_modules/@livekit/krisp-noise-filter');
    assert.equal(resolveKrisp({ chainNames: ['x'], env: { KRISP_PACKAGE_DIR: '/k', TEAM_COMMS_DIR: '/tc' }, root: '/repo', readText: at('/k') }).dir, '/k');
  });
  test('a directory holding another package is refused', () => {
    refused(() => resolveKrisp({ chainNames: ['x'], env: { KRISP_PACKAGE_DIR: '/k' }, root: '/', readText: files({ '/k/package.json': pkg('left-pad') }) }), /does not point at/, []);
  });
});

describe('cloud target (static checks)', () => {
  test('explicitly configured test target from the environment or the bench file', () => {
    const t = resolveCloudTarget({ env: bench() });
    assert.deepEqual(t, { url: `wss://${HOST}`, host: HOST, key: KEY, secret: SECRET });
    assert.deepEqual(resolveCloudTarget({ env: {}, benchFileText: `# bench\n${toFile(bench())}\n` }), t);
    assert.deepEqual(resolveCloudTarget({ env: { LIVEKIT_BENCH_KEY: KEY }, benchFileText: toFile(bench()) }), t);
  });
  test('nothing configured, or any setting missing, is refused', () => {
    refused(() => resolveCloudTarget({ env: {} }), /missing: LIVEKIT_BENCH_URL, LIVEKIT_BENCH_KEY, LIVEKIT_BENCH_SECRET, LIVEKIT_BENCH_TEST_HOST/);
    refused(() => resolveCloudTarget({ env: bench({ LIVEKIT_BENCH_TEST_HOST: '' }) }), /missing: LIVEKIT_BENCH_TEST_HOST/);
  });
  test('a URL alone is not a declaration: TEST_HOST must repeat its host', () => {
    refused(() => resolveCloudTarget({ env: bench({ LIVEKIT_BENCH_TEST_HOST: 'other-0000.livekit.cloud' }) }), /does not repeat the host/);
  });
  test('environment and bench file disagreeing is ambiguous', () => {
    refused(() => resolveCloudTarget({ env: bench(), benchFileText: toFile(bench({ LIVEKIT_BENCH_KEY: 'APIother' })) }), /LIVEKIT_BENCH_KEY is set in both/);
  });
  test('only a plain wss://<project>.livekit.cloud URL', () => {
    for (const url of [`https://${HOST}`, `ws://${HOST}`, `wss://${HOST}/rtc`, `wss://${HOST}?x=1`, `wss://${HOST}:8443`, `wss://u:p@${HOST}`, 'wss://livekit.example.com', 'wss://localhost:7880', `wss://${HOST}.evil.com`, 'not a url']) {
      refused(() => resolveCloudTarget({ env: bench({ LIVEKIT_BENCH_URL: url }) }), /LIVEKIT_BENCH_URL/);
    }
  });
  test('the target may not be an application project: URL, key or secret seen in an app config', () => {
    const app = (values) => [{ source: 'the environment', values: {} }, { source: 'team-comms .env.production', values }];
    refused(() => resolveCloudTarget({ env: bench(), appConfigs: app({ LIVEKIT_URL: `wss://${HOST}` }) }), /set in team-comms \.env\.production \(LIVEKIT_URL\)/);
    refused(() => resolveCloudTarget({ env: bench(), appConfigs: app({ NEXT_PUBLIC_LIVEKIT_URL: `https://${HOST.toUpperCase()}/` }) }), /NEXT_PUBLIC_LIVEKIT_URL/);
    refused(() => resolveCloudTarget({ env: bench(), appConfigs: app({ LIVEKIT_URL: HOST }) }), /LIVEKIT_URL/);
    refused(() => resolveCloudTarget({ env: bench(), appConfigs: app({ LIVEKIT_API_KEY: KEY }) }), /LIVEKIT_BENCH_KEY equals LIVEKIT_API_KEY/);
    refused(() => resolveCloudTarget({ env: bench(), appConfigs: app({ LIVEKIT_API_SECRET: SECRET }) }), /LIVEKIT_BENCH_SECRET equals LIVEKIT_API_SECRET/);
    // A different application project is no objection.
    assert.equal(resolveCloudTarget({ env: bench(), appConfigs: app({ LIVEKIT_URL: 'wss://app-1111.livekit.cloud', LIVEKIT_API_KEY: 'APIapp', LIVEKIT_API_SECRET: 'app-secret' }) }).host, HOST);
  });
  test('env file parsing: comments, export, quotes', () => {
    assert.deepEqual(parseEnvFile('# c\nexport A=1\nB="two words"\nC=\'x=y\'\n\nnoise\n'), { A: '1', B: 'two words', C: 'x=y' });
  });
});

describe('cloud target (live check before any room)', () => {
  const target = { url: `wss://${HOST}`, host: HOST, key: KEY, secret: SECRET };
  const answer = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => (typeof body === 'string' ? JSON.parse(body) : body) });
  const verify = (fetch) => verifyDedicatedProject({ target, listRoomsToken: 'tok', fetch });
  const rejectsRefused = async (promise, pattern) => {
    await assert.rejects(promise, (e) => e instanceof Refused && pattern.test(e.message) && ![HOST, KEY, SECRET].some((v) => e.message.includes(v)));
  };
  test('asks the RoomService of exactly the configured host, with the list-only token', async () => {
    const calls = [];
    await verify(async (url, init) => (calls.push({ url, init }), { ok: true, status: 200, json: async () => ({ rooms: [] }) }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://${HOST}/twirp/livekit.RoomService/ListRooms`);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.authorization, 'Bearer tok');
  });
  test('empty project or only earlier bench rooms: accepted', async () => {
    assert.deepEqual(await verify(answer(200, {})), { benchRoomsOpen: 0 });
    assert.deepEqual(await verify(answer(200, { rooms: [{ name: 'cap-cloud-krisp-fan-0-1' }] })), { benchRoomsOpen: 1 });
  });
  test('a room the bench did not create: refused (project in use)', async () => {
    await rejectsRefused(verify(answer(200, { rooms: [{ name: 'cap-x' }, { name: 'team-standup' }] })), /1 room\(s\) not created by this bench/);
  });
  test('key not accepted, network error, odd answers: refused', async () => {
    await rejectsRefused(verify(answer(401, {})), /did not accept the bench key \(HTTP 401\)/);
    await rejectsRefused(
      verify(async () => {
        throw new Error(`getaddrinfo ENOTFOUND ${HOST}`);
      }),
      /network error/,
    );
    await rejectsRefused(verify(answer(200, 'not json')), /not JSON/);
    await rejectsRefused(verify(answer(200, { rooms: 'x' })), /no room list/);
  });
});

test('redactor removes host, key, secret and tokens', () => {
  const redact = redactor([HOST, KEY, SECRET, undefined, '']);
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';
  const s = redact(`could not connect to wss://${HOST}/rtc?access_token=${jwt} with ${KEY}/${SECRET}`);
  assert.equal(s, 'could not connect to wss://<redacted>/rtc?access_token=<token> with <redacted>/<redacted>');
});

// ---- the script itself ---------------------------------------------------------------
describe('capture-eval.mjs refuses before starting anything', () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), 'capture-eval.mjs');
  const tmp = mkdtempSync(join(tmpdir(), 'capture-eval-test-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  const home = join(tmp, 'home'); // no ~/.config/voxonow-bench here unless a test writes one
  const noTeamComms = join(tmp, 'no-team-comms');
  mkdirSync(home);
  let n = 0;
  /** Runs the script with a clean, fictitious environment; `out` must still not exist afterwards unless --check passed. */
  const run = (argv, env = {}) => {
    const out = join(tmp, `out-${n++}`);
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/LIVEKIT|KRISP|TEAM_COMMS/.test(k)));
    const r = spawnSync(process.execPath, [script, '--out', out, ...argv], { env: { ...clean, HOME: home, TEAM_COMMS_DIR: noTeamComms, ...env }, encoding: 'utf8', timeout: 60_000 });
    return { ...r, text: r.stdout + r.stderr, out };
  };

  test('default chains need neither team-comms nor Krisp (--check)', () => {
    const r = run(['--tts', '--check']);
    assert.equal(r.status, 0, r.text);
    assert.match(r.text, /ours-raw: Chrome capture EC off \/ NS off \/ AGC off · no suppressor · Voxonow engine, local/);
    assert.match(r.text, /livekit-product: .* · no suppressor · LiveKit v1\.13\.7 local/);
    assert.doesNotMatch(r.text, /krisp|cloud/i);
    assert.ok(!existsSync(r.out), '--check must not create the output directory');
  });
  test('a Krisp chain without the package: refused, nothing started', () => {
    const r = run(['--tts', '--chains', 'ours-product,livekit-krisp', '--quick']);
    assert.equal(r.status, 2, r.text);
    assert.match(r.text, /refused — chain\(s\) livekit-krisp need @livekit\/krisp-noise-filter/);
    assert.ok(!existsSync(r.out));
  });
  test('a Krisp chain with KRISP_PACKAGE_DIR: the version is stated', () => {
    const dir = join(tmp, 'krisp');
    mkdirSync(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@livekit/krisp-noise-filter', version: '9.9.9' }));
    const r = run(['--tts', '--chains', 'livekit-krisp', '--check'], { KRISP_PACKAGE_DIR: dir });
    assert.equal(r.status, 0, r.text);
    assert.match(r.text, /livekit-krisp: .*suppressor Krisp 9\.9\.9 \(enablement check/);
  });
  test('cloud chain with nothing configured: refused', () => {
    const r = run(['--tts', '--chains', 'cloud-product']);
    assert.equal(r.status, 2, r.text);
    assert.match(r.text, /explicitly configured LiveKit Cloud TEST project; missing/);
    assert.ok(!existsSync(r.out));
  });
  test('cloud chain aimed at the application project: refused without printing its values', () => {
    const r = run(['--tts', '--chains', 'cloud-product'], { ...bench(), LIVEKIT_URL: `wss://${HOST}` });
    assert.equal(r.status, 2, r.text);
    assert.match(r.text, /the bench target is the LiveKit project set in the environment \(LIVEKIT_URL\)/);
    for (const v of [HOST, KEY, SECRET]) assert.ok(!r.text.includes(v), 'output leaks a configured value');
    assert.ok(!existsSync(r.out));
  });
  test("cloud chain aimed at a project in team-comms' .env files: refused", () => {
    const tc = join(tmp, 'team-comms');
    mkdirSync(tc);
    writeFileSync(join(tc, '.env.production'), `LIVEKIT_URL=wss://${HOST}\nLIVEKIT_API_KEY=APIprod\n`);
    const r = run(['--tts', '--chains', 'cloud-product', '--check'], { ...bench(), TEAM_COMMS_DIR: tc });
    assert.equal(r.status, 2, r.text);
    assert.match(r.text, /set in team-comms \.env\.production \(LIVEKIT_URL\)/);
    for (const v of [HOST, KEY, SECRET]) assert.ok(!r.text.includes(v));
  });
  test('bench config file read from ~/.config/voxonow-bench; static checks pass under --check without contacting it', () => {
    mkdirSync(join(home, '.config/voxonow-bench'), { recursive: true });
    writeFileSync(join(home, '.config/voxonow-bench/livekit.env'), toFile(bench()));
    try {
      const r = run(['--tts', '--chains', 'cloud-product', '--check']);
      assert.equal(r.status, 0, r.text);
      assert.match(r.text, /explicitly configured test target, static checks passed/);
      for (const v of [HOST, KEY, SECRET]) assert.ok(!r.text.includes(v));
    } finally {
      rmSync(join(home, '.config'), { recursive: true });
    }
  });
  test('a port already taken by another server: refused before anything is created', async () => {
    // Port 7837 is the bench's voice server port; a foreign server there would be measured instead.
    const blocker = createServer().listen(7837, '127.0.0.1');
    await once(blocker, 'listening');
    try {
      const out = join(tmp, 'port-test');
      const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/LIVEKIT|KRISP|TEAM_COMMS/.test(k)));
      const child = spawn(process.execPath, [script, '--tts', '--quick', '--chains', 'ours-product', '--out', out], { env: { ...clean, HOME: home, TEAM_COMMS_DIR: noTeamComms } });
      let text = '';
      child.stdout.on('data', (d) => (text += d));
      child.stderr.on('data', (d) => (text += d));
      const [code] = await once(child, 'exit');
      assert.equal(code, 2, text);
      assert.match(text, /port 7837 is already in use/);
      assert.ok(!existsSync(out));
    } finally {
      blocker.close();
    }
  });
  test('existing output directory, missing speech, unknown condition: refused', () => {
    const existing = join(tmp, 'existing');
    mkdirSync(existing);
    const r1 = spawnSync(process.execPath, [script, '--tts', '--out', existing], { env: { ...process.env, HOME: home, TEAM_COMMS_DIR: noTeamComms }, encoding: 'utf8' });
    assert.equal(r1.status, 2);
    assert.match(r1.stderr, /never overwritten/);
    assert.match(run([]).text, /--speech <recording> is required/);
    assert.match(run(['--speech', join(tmp, 'missing.wav')]).text, /file not found/);
    assert.match(run(['--tts', '--conditions', 'fan,nope']).text, /unknown condition "nope"/);
  });
});

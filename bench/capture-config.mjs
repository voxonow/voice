// Configuration and safety checks for bench/capture-eval.mjs, kept free of
// browsers, Docker and network so they are unit-tested
// (capture-config.test.mjs). Nothing here prints a URL, key or secret: error
// messages name settings, never their values.
import { join } from 'node:path';

/** A check said no: capture-eval starts nothing and exits with code 2. */
export class Refused extends Error {}
const refuse = (message) => {
  throw new Refused(message);
};

// ---- chains --------------------------------------------------------------------

/**
 * Chains that only run when named in --chains: the LiveKit Cloud ones (a
 * network target) and the Krisp ones (a package from outside this repo).
 */
export const isOptIn = (chain) => Boolean(chain.cloud || chain.krisp);

export function selectChains(arg, chains) {
  const names = arg ? arg.split(',').map((s) => s.trim()).filter(Boolean) : Object.keys(chains).filter((n) => !isOptIn(chains[n]));
  if (!names.length) refuse('--chains selects no chain');
  for (const n of names) if (!chains[n]) refuse(`unknown chain "${n}"; known: ${Object.keys(chains).join(', ')}`);
  return [...new Set(names)];
}

const onOff = (v) => (v ? 'on' : 'off');

/** What a chain is meant to do, in words, for the report and results.json. */
export function describeChain(chain, { livekitVersion, krisp } = {}) {
  const c = chain.constraints;
  const parts = [`Chrome capture EC ${onOff(c.echoCancellation)} / NS ${onOff(c.noiseSuppression)} / AGC ${onOff(c.autoGainControl)}`];
  if (chain.method) parts.push(`suppressor ${chain.method} (demo/src/noise.ts)`);
  else if (chain.krisp) parts.push(`suppressor Krisp${krisp ? ` ${krisp.version}` : ''}${chain.krispCheckOnly ? ' (enablement check: local LiveKit refuses it)' : ''}`);
  else parts.push('no suppressor');
  parts.push(chain.engine === 'ours' ? 'Voxonow engine, local' : chain.cloud ? 'LiveKit Cloud test project (internet path)' : `LiveKit ${livekitVersion ?? ''} local`.replace('  ', ' '));
  return parts.join(' · ');
}

/**
 * Krisp counts as active when the processor said so 2 s after attaching or
 * when the recording ended (the early reading alone missed runs that were
 * processed).
 */
export const krispActive = (res) => res.krispEnabled === true || res.krispEnabledAtEnd === true;

/**
 * The suppressor a run actually had, from what the page reported. A Krisp chain
 * where Krisp never reported enabled is not a Krisp measurement: the caller
 * fails such a run unless the chain is the enablement check.
 */
export function actualSuppressor(chain, res) {
  if (chain.method) return chain.method;
  if (!chain.krisp) return 'none';
  if (!krispActive(res)) return 'krisp (attached, NOT enabled — effectively none)';
  return res.krispEnabled === true && res.krispEnabledAtEnd === true ? 'krisp (enabled)' : `krisp (enabled ${res.krispEnabled === true ? 'early only' : 'by the end only'})`;
}

// ---- Krisp -----------------------------------------------------------------------

export const KRISP_PACKAGE = '@livekit/krisp-noise-filter';

/**
 * Where the Krisp package comes from: KRISP_PACKAGE_DIR, else team-comms'
 * node_modules (TEAM_COMMS_DIR, default ../team-comms) — the exact build the
 * product ships, read and never written. Called only when a selected chain
 * uses Krisp; a missing package is an error, never a silent switch to a chain
 * without Krisp.
 */
export function resolveKrisp({ chainNames, env, root, readText }) {
  const dir = env.KRISP_PACKAGE_DIR || join(env.TEAM_COMMS_DIR || join(root, '../team-comms'), 'node_modules', KRISP_PACKAGE);
  let pkg;
  try {
    pkg = JSON.parse(readText(join(dir, 'package.json')));
  } catch {
    refuse(
      `chain(s) ${chainNames.join(', ')} need ${KRISP_PACKAGE}, which is not in this repo. ` +
        'Set KRISP_PACKAGE_DIR to the package directory, or TEAM_COMMS_DIR to a team-comms checkout with node_modules installed ' +
        '(default ../team-comms). Or drop the Krisp chains from --chains. Nothing was run.',
    );
  }
  if (pkg.name !== KRISP_PACKAGE) refuse(`KRISP_PACKAGE_DIR / TEAM_COMMS_DIR does not point at ${KRISP_PACKAGE} (package.json name differs). Nothing was run.`);
  return { dir, version: String(pkg.version) };
}

// ---- LiveKit Cloud target ------------------------------------------------------------

/** KEY=VALUE lines; # comments and surrounding quotes allowed. */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const k = line.slice(0, line.indexOf('=')).replace(/^export\s+/, '').trim();
    let v = line.slice(line.indexOf('=') + 1).trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

/**
 * The four bench settings. TEST_HOST is the explicit statement "this host is
 * a dedicated test project": it must repeat the URL's host exactly, so a URL
 * pasted from somewhere else is not accepted on its own.
 */
export const BENCH_SETTINGS = ['LIVEKIT_BENCH_URL', 'LIVEKIT_BENCH_KEY', 'LIVEKIT_BENCH_SECRET', 'LIVEKIT_BENCH_TEST_HOST'];

/** Settings an application uses for its LiveKit project (team-comms' names and common client-side ones). */
const APP_URLS = ['LIVEKIT_URL', 'NEXT_PUBLIC_LIVEKIT_URL', 'VITE_LIVEKIT_URL', 'LIVEKIT_WS_URL', 'LIVEKIT_HOST'];
const APP_KEYS = ['LIVEKIT_API_KEY'];
const APP_SECRETS = ['LIVEKIT_API_SECRET'];

const hostOf = (value) => {
  try {
    return new URL(/^[a-z]+:\/\//i.test(value) ? value : `wss://${value}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

/**
 * Resolves the LiveKit Cloud test target, or refuses. Allow-list, not
 * deny-list: the target must be explicitly configured (all four
 * BENCH_SETTINGS, from the environment or the bench config file, never both
 * with different values), be a plain wss://<project>.livekit.cloud URL, be
 * declared a test host, and differ in host, key and secret from every
 * application LiveKit configuration that can be seen (`appConfigs`: the
 * process environment and team-comms' .env files, when present). Anything
 * that cannot be decided is a refusal.
 *
 * Static only: no network. verifyDedicatedProject() then checks the real
 * target before any room is joined.
 */
export function resolveCloudTarget({ env, benchFileText, appConfigs = [] }) {
  const file = benchFileText === undefined ? {} : parseEnvFile(benchFileText);
  const v = {};
  for (const k of BENCH_SETTINGS) {
    const a = env[k]?.trim(), b = file[k]?.trim();
    if (a && b && a !== b) refuse(`${k} is set in both the environment and the bench config file, with different values — ambiguous, refusing.`);
    v[k] = a || b;
  }
  const missing = BENCH_SETTINGS.filter((k) => !v[k]);
  if (missing.length) {
    refuse(
      `cloud chains need an explicitly configured LiveKit Cloud TEST project; missing: ${missing.join(', ')}. ` +
        'See docs/CAPTURE-BENCH.md. Never use the production project.',
    );
  }
  let u;
  try {
    u = new URL(v.LIVEKIT_BENCH_URL);
  } catch {
    refuse('LIVEKIT_BENCH_URL is not a valid URL.');
  }
  if (u.protocol !== 'wss:') refuse('LIVEKIT_BENCH_URL must use wss://.');
  if (u.username || u.password || u.port || u.search || u.hash || !['', '/'].includes(u.pathname)) {
    refuse('LIVEKIT_BENCH_URL must be just wss://<project>.livekit.cloud (no credentials, port, path, query or fragment).');
  }
  const host = u.hostname.toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.livekit\.cloud$/.test(host)) refuse('LIVEKIT_BENCH_URL must be a LiveKit Cloud project host (<project>.livekit.cloud).');
  if (v.LIVEKIT_BENCH_TEST_HOST.toLowerCase() !== host) {
    refuse('LIVEKIT_BENCH_TEST_HOST does not repeat the host of LIVEKIT_BENCH_URL; declare the test project explicitly.');
  }
  for (const { source, values } of appConfigs) {
    for (const k of APP_URLS) if (values[k] && hostOf(values[k]) === host) refuse(`the bench target is the LiveKit project set in ${source} (${k}) — an application project, refusing.`);
    for (const k of APP_KEYS) if (values[k] && values[k].trim() === v.LIVEKIT_BENCH_KEY) refuse(`LIVEKIT_BENCH_KEY equals ${k} in ${source} — an application key, refusing.`);
    for (const k of APP_SECRETS) if (values[k] && values[k].trim() === v.LIVEKIT_BENCH_SECRET) refuse(`LIVEKIT_BENCH_SECRET equals ${k} in ${source} — an application secret, refusing.`);
  }
  return { url: `wss://${host}`, host, key: v.LIVEKIT_BENCH_KEY, secret: v.LIVEKIT_BENCH_SECRET };
}

/** Prefix of every room capture-eval creates. */
export const BENCH_ROOM_PREFIX = 'cap-';

/**
 * Checks the real target before any room is joined: its RoomService must
 * accept the bench key (a LiveKit Cloud key only works for its own project,
 * so every later token is confined to this host), and it must hold no room
 * other than earlier bench rooms — a project something else is using is not a
 * dedicated test project. An error or an unexpected answer is a refusal.
 *
 * `listRoomsToken` is a short-lived token with only the roomList grant.
 */
export async function verifyDedicatedProject({ target, listRoomsToken, fetch }) {
  let res;
  try {
    res = await fetch(`https://${target.host}/twirp/livekit.RoomService/ListRooms`, {
      method: 'POST',
      headers: { authorization: `Bearer ${listRoomsToken}`, 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    refuse('could not reach the LiveKit Cloud test project to verify it (network error) — refusing to start.');
  }
  if (!res.ok) refuse(`the LiveKit Cloud test project did not accept the bench key (HTTP ${res.status}) — key and host may not belong together; refusing.`);
  let body;
  try {
    body = await res.json();
  } catch {
    refuse('unexpected answer from the LiveKit Cloud test project (not JSON) — refusing.');
  }
  const rooms = Array.isArray(body?.rooms) ? body.rooms : body && typeof body === 'object' && !('rooms' in body) ? [] : undefined;
  if (!rooms) refuse('unexpected answer from the LiveKit Cloud test project (no room list) — refusing.');
  const foreign = rooms.filter((r) => !String(r?.name ?? '').startsWith(BENCH_ROOM_PREFIX));
  if (foreign.length) refuse(`the LiveKit Cloud target has ${foreign.length} room(s) not created by this bench — it is in use, not a dedicated test project; refusing.`);
  return { benchRoomsOpen: rooms.length };
}

// ---- output hygiene ----------------------------------------------------------------

const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g;

/**
 * Returns a function that removes the given values (cloud host, key, secret)
 * and any JWT from text bound for the console, report.md or results.json.
 */
export function redactor(values) {
  const list = values.filter((s) => typeof s === 'string' && s.length >= 4).sort((a, b) => b.length - a.length);
  return (text) => {
    let s = String(text).replace(JWT, '<token>');
    for (const v of list) s = s.split(v).join('<redacted>');
    return s;
  };
}

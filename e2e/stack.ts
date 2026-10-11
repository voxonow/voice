import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

// A private voice server + demo server per test, for tests that stop, crash or
// restart the voice server (the shared stack in playwright.config.ts must not
// be disturbed), and a signaling proxy that can silently cut traffic.

const root = process.cwd();

export async function waitHealthy(url: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} did not come up`);
}

export class Stack {
  voice?: ChildProcess;
  demo?: ChildProcess;

  constructor(
    /** `extraDemos`: further demo-server ports the voice server accepts as origins. */
    readonly ports: { voice: number; demo: number; rtcBase: number; extraDemos?: number[] },
    /** Where the demo page connects for signaling (default: the voice server itself). */
    readonly signalingUrl = `ws://localhost:${ports.voice}/ws`,
  ) {}

  get demoUrl(): string {
    return `http://localhost:${this.ports.demo}`;
  }

  async startVoice(): Promise<void> {
    this.voice = spawn(process.execPath, [join(root, 'server/dist/index.js')], {
      stdio: 'ignore',
      env: {
        ...process.env,
        PORT: String(this.ports.voice),
        NUM_WORKERS: '1',
        RTC_PORT_BASE: String(this.ports.rtcBase),
        RTC_ANNOUNCED_ADDRESS: '127.0.0.1',
        TICKET_PUBLIC_KEY_FILE: join(root, '.dev-keys/ticket-public.pem'),
        ALLOWED_ORIGINS: [this.ports.demo, ...(this.ports.extraDemos ?? [])].flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]).join(','),
        LOG_LEVEL: 'warn',
      },
    });
    await waitHealthy(`http://localhost:${this.ports.voice}/healthz`);
  }

  async stopVoice(signal: NodeJS.Signals): Promise<void> {
    const voice = this.voice;
    this.voice = undefined;
    if (!voice || voice.exitCode !== null) return;
    const exited = new Promise((resolve) => voice.once('exit', resolve));
    voice.kill(signal);
    await exited;
    // A killed parent leaves its media worker orphaned: end it too.
    if (signal === 'SIGKILL') spawnSync('pkill', ['-9', '-P', String(voice.pid)]);
  }

  /** PID of the voice server's media worker. */
  workerPid(): number {
    const out = spawnSync('pgrep', ['-P', String(this.voice!.pid)], { encoding: 'utf8' }).stdout.trim();
    const pid = Number(out.split('\n')[0]);
    if (!pid) throw new Error('media worker not found');
    return pid;
  }

  async startDemo(): Promise<void> {
    this.demo = spawn(process.execPath, [join(root, 'demo/dev-server.mjs')], {
      stdio: 'ignore',
      env: {
        ...process.env,
        DEMO_PORT: String(this.ports.demo),
        VOICE_URL: this.signalingUrl,
        DEV_LOG_DIR: join(root, 'test-results/dev-logs-stack'),
      },
    });
    await waitHealthy(`${this.demoUrl}/healthz`);
  }

  async stop(): Promise<void> {
    await this.stopVoice('SIGTERM');
    this.demo?.kill('SIGTERM');
  }
}

/**
 * WebSocket proxy between the browser and the voice server (signaling only;
 * media goes straight to the voice server). Each direction can be silently
 * dropped or delayed while both sockets stay open — what a dead or congested
 * network looks like from the endpoints — and it can play an older server.
 */
export class SignalingProxy {
  /** Applies to every proxied connection, current and future. */
  mode = {
    dropUp: false,
    dropDown: false,
    delayDownMs: 0,
    /** Answer `ping` like a server that predates it (bad_request), without forwarding. */
    olderServer: false,
    /** Close new connections at once with this code (e.g. 4008). */
    refuseWith: undefined as number | undefined,
    /** Play a server from before JoinTimeout: forward its 4012 as 4001 "join timeout". */
    legacyJoinTimeout: false,
  };
  /**
   * What happens to the next `join` messages, one entry per join: dropped
   * (lost on the way), delayed by N ms, corrupted (unsupported protocol
   * version → malformed join), or sent with a broken ticket signature.
   */
  joinPlan: ('drop' | 'corrupt' | 'badticket' | number)[] = [];
  /** `join` messages seen from browsers. */
  joins = 0;
  /** Close codes the server sent towards browsers, in order. */
  readonly serverCloses: number[] = [];
  /** Browser connections accepted so far. */
  connections = 0;
  /** `ping` requests seen from browsers. */
  pings = 0;
  private readonly wss: WebSocketServer;

  constructor(
    readonly port: number,
    private readonly target: string,
  ) {
    this.wss = new WebSocketServer({ port });
    this.wss.on('connection', (client, request) => {
      this.connections++;
      if (this.mode.refuseWith !== undefined) return client.close(this.mode.refuseWith, 'refused by test proxy');
      const upstream = new WebSocket(this.target, { headers: request.headers.origin ? { origin: request.headers.origin } : {} });
      const queue: string[] = [];
      upstream.on('open', () => queue.splice(0).forEach((m) => upstream.send(m)));
      client.on('message', (data: RawData) => {
        const text = data.toString();
        let method: string | undefined;
        let id: number | undefined;
        try {
          ({ method, id } = JSON.parse(text));
        } catch {}
        if (method === 'join') {
          this.joins++;
          const plan = this.joinPlan.shift();
          if (plan === 'drop') return;
          let out = text;
          if (plan === 'corrupt' || plan === 'badticket') {
            const message = JSON.parse(text);
            if (plan === 'corrupt') message.data.protocol = 99;
            else message.data.ticket = `${message.data.ticket.slice(0, -6)}AAAAAA`;
            out = JSON.stringify(message);
          }
          const forward = () => (upstream.readyState === upstream.OPEN ? upstream.send(out) : queue.push(out));
          if (typeof plan === 'number') setTimeout(forward, plan);
          else forward();
          return;
        }
        if (method === 'ping') {
          this.pings++;
          if (this.mode.olderServer) {
            // Exactly what a server without `ping` answers (signaling.ts, unknown method).
            client.send(JSON.stringify({ id, ok: false, error: { code: 'bad_request', message: 'unknown method ping' } }));
            return;
          }
        }
        if (this.mode.dropUp) return;
        if (upstream.readyState === upstream.OPEN) upstream.send(text);
        else queue.push(text);
      });
      upstream.on('message', (data: RawData) => {
        if (this.mode.dropDown) return;
        const text = data.toString();
        const send = () => client.readyState === client.OPEN && client.send(text);
        if (this.mode.delayDownMs) setTimeout(send, this.mode.delayDownMs);
        else send();
      });
      upstream.on('close', (code, reason) => {
        this.serverCloses.push(code);
        if (code === 1005 || code === 1006) client.terminate();
        else if (code === 4012 && this.mode.legacyJoinTimeout) client.close(4001, 'join timeout');
        else client.close(code, reason.toString());
      });
      client.on('close', () => upstream.close());
      upstream.on('error', () => client.terminate());
      client.on('error', () => upstream.terminate());
    });
  }

  /** Drops every current browser connection abruptly (the browser sees 1006). */
  terminateClients(): void {
    for (const c of this.wss.clients) c.terminate();
  }

  /** Closes every current browser connection with `code`, as the server would. */
  closeClients(code: number, reason: string): void {
    for (const c of this.wss.clients) c.close(code, reason);
  }

  close(): Promise<void> {
    for (const c of this.wss.clients) c.terminate();
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }
}

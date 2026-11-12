import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';
import {
  RoomError,
  type RoomState,
  bingo,
  callNumber,
  changeSettings,
  createRoom,
  disconnect,
  fire,
  isSeated,
  join,
  leave,
  mark,
  nextWake,
  parseSettings,
  unmark,
  play,
  spectate,
  ready,
  rematch,
  start,
  tick,
  unready,
  viewFor,
} from './game';

/** 아무도 접속해 있지 않은 방은 이 시간 뒤 지운다. */
const IDLE_MS = 15 * 60 * 1000;
/** 접속해 있어도 이 시간 넘게 아무 일이 없으면 지운다. */
const ABANDON_MS = 2 * 60 * 60 * 1000;

interface Attachment {
  playerId: string;
}

/** 0 이상 1 미만의 암호학적 난수. 대포·순서는 서버에서만 뽑는다. */
function secureRandom(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
}

/** 방 하나 = Durable Object 하나. 방 코드로 찾는다. */
export class BingoRoom extends DurableObject<Env> {
  /** 상태 변경을 한 번에 하나씩 (빙고 버튼을 누른 순서가 그대로 등수가 된다) */
  private queue: Promise<unknown> = Promise.resolve();
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  private load(): Promise<RoomState | undefined> {
    return this.ctx.storage.get<RoomState>('state');
  }

  private async save(state: RoomState): Promise<void> {
    await this.ctx.storage.put('state', state);
    const wake = nextWake(state);
    const cleanup = Math.max(state.updatedAt + IDLE_MS, Date.now() + 60_000);
    await this.ctx.storage.setAlarm(wake !== null ? Math.min(wake, cleanup) : cleanup);
  }

  private broadcast(state: RoomState): void {
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (!att) continue;
      try {
        ws.send(JSON.stringify(viewFor(state, att.playerId, now)));
      } catch {
        // 이미 닫힌 연결
      }
    }
  }

  private static sendError(ws: WebSocket, message: string, fatal = false): void {
    try {
      ws.send(JSON.stringify({ type: 'error', message, fatal }));
    } catch {
      // 무시
    }
  }

  private static reject(message: string, code: number): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    BingoRoom.sendError(server, message, true);
    server.close(code, 'rejected');
    return new Response(null, { status: 101, webSocket: client });
  }

  async fetch(request: Request): Promise<Response> {
    return this.serial(() => this.handleFetch(request));
  }

  private async handleFetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/init') {
      if (await this.load()) return new Response('exists', { status: 409 });
      let settings;
      try {
        settings = parseSettings(await request.json());
      } catch (err) {
        return new Response(err instanceof RoomError ? err.message : 'bad settings', { status: 400 });
      }
      await this.save(createRoom(url.searchParams.get('code') ?? '', settings, Date.now()));
      return new Response('created', { status: 201 });
    }

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('WebSocket 연결이 필요해요', { status: 426 });
      }
      const state = await this.load();
      if (!state) return BingoRoom.reject('없는 방이에요. 코드를 확인해 주세요', 4004);

      const requested = url.searchParams.get('playerId');
      let playerId: string;
      try {
        playerId = join(
          state,
          {
            playerId: isSeated(state, requested) ? requested : null,
            name: url.searchParams.get('name') ?? '',
            newId: crypto.randomUUID(),
            watch: url.searchParams.get('watch') === '1',
          },
          Date.now(),
        );
      } catch (err) {
        return BingoRoom.reject(err instanceof RoomError ? err.message : '들어갈 수 없는 방이에요', 4009);
      }

      // 같은 참가자의 예전 연결(다시 연결 전)은 닫는다.
      for (const old of this.ctx.getWebSockets(playerId)) {
        try {
          old.serializeAttachment(null);
          old.close(4000, 'replaced');
        } catch {
          // 무시
        }
      }

      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server, [playerId]);
      server.serializeAttachment({ playerId } satisfies Attachment);
      server.send(JSON.stringify({ type: 'welcome', playerId }));
      await this.save(state);
      this.broadcast(state);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('not found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.serial(() => this.handleMessage(ws, message));
  }

  private async handleMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att || typeof message !== 'string') return;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }
    const state = await this.load();
    if (!state) {
      BingoRoom.sendError(ws, '방이 사라졌어요', true);
      ws.close(4004, 'gone');
      return;
    }
    const id = att.playerId;
    const now = Date.now();
    try {
      // 차례 시간이 지난 상태에서 들어온 요청은 먼저 시간 초과를 반영한다.
      tick(state, now, secureRandom);
      switch (data.type) {
        case 'settings':
          changeSettings(state, id, data.settings, now);
          break;
        case 'ready':
          ready(state, id, data.board, now);
          break;
        case 'unready':
          unready(state, id, now);
          break;
        case 'spectate':
          spectate(state, id, now);
          break;
        case 'play':
          play(state, id, now);
          break;
        case 'start':
          start(state, id, now, secureRandom);
          break;
        case 'call':
          callNumber(state, id, data.number, now);
          break;
        case 'fire':
          fire(state, id, now, secureRandom);
          break;
        case 'mark':
          mark(state, id, data.cell, now);
          break;
        case 'unmark':
          unmark(state, id, data.cell, now);
          break;
        case 'bingo':
          bingo(state, id, now);
          break;
        case 'rematch':
          rematch(state, id, now);
          break;
        case 'leave':
          leave(state, id, now);
          break;
        default:
          return;
      }
    } catch (err) {
      if (err instanceof RoomError) {
        BingoRoom.sendError(ws, err.message);
        await this.save(state);
        this.broadcast(state);
        return;
      }
      throw err;
    }

    await this.save(state);
    if (data.type === 'leave') {
      ws.serializeAttachment(null);
      try {
        ws.close(1000, 'left');
      } catch {
        // 무시
      }
    }
    this.broadcast(state);
  }

  private async onSocketGone(ws: WebSocket): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    const stillOpen = this.ctx
      .getWebSockets(att.playerId)
      .some((s) => s !== ws && s.readyState === WebSocket.OPEN);
    if (stillOpen) return;
    const state = await this.load();
    if (!state) return;
    disconnect(state, att.playerId, Date.now());
    await this.save(state);
    this.broadcast(state);
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    await this.serial(() => this.onSocketGone(ws));
    try {
      ws.close(code === 1005 ? 1000 : code, 'closed');
    } catch {
      // 이미 닫힘
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.serial(() => this.onSocketGone(ws));
  }

  async alarm(): Promise<void> {
    await this.serial(() => this.handleAlarm());
  }

  private async handleAlarm(): Promise<void> {
    const state = await this.load();
    if (!state) return;
    const now = Date.now();
    const sockets = this.ctx.getWebSockets().filter((s) => s.readyState === WebSocket.OPEN);
    const idle = sockets.length === 0 && now - state.updatedAt >= IDLE_MS;
    const abandoned = now - state.updatedAt >= ABANDON_MS;
    if (idle || abandoned) {
      for (const ws of sockets) {
        BingoRoom.sendError(ws, '오래 움직임이 없어 방이 닫혔어요', true);
        try {
          ws.close(4010, 'expired');
        } catch {
          // 무시
        }
      }
      await this.ctx.storage.deleteAll();
      return;
    }
    const changed = tick(state, now, secureRandom);
    await this.save(state);
    if (changed) this.broadcast(state);
  }
}

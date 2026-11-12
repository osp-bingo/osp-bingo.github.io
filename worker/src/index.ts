import { BingoRoom } from './room';
import { RoomError, isRoomCode, parseSettings, randomRoomCode } from './game';
import { HttpError, json, readJson } from './http';
import { withoutPrefix } from './routing';

export { BingoRoom };

export interface Env {
  ROOMS: DurableObjectNamespace<BingoRoom>;
  ALLOWED_ORIGINS?: string;
}

function isAllowedOrigin(origin: string, env: Env): boolean {
  const allowed = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.some(
    (entry) =>
      origin === entry ||
      ((entry.endsWith('://localhost') || entry.endsWith('://127.0.0.1')) && origin.startsWith(`${entry}:`)),
  );
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin');
  if (!origin || !isAllowedOrigin(origin, env)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/** 새 방. body: { kind: 'number', size: 3|5|7|9, callMode: 'player'|'cannon' } → { code } */
async function createRoom(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  let settings;
  try {
    settings = parseSettings(body);
  } catch (err) {
    throw new HttpError(400, err instanceof RoomError ? err.message : '설정이 올바르지 않아요');
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = randomRoomCode();
    const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
    const res = await stub.fetch(`https://room/init?code=${code}`, { method: 'POST', body: JSON.stringify(settings) });
    if (res.status === 201) return json({ code }, 201);
  }
  throw new HttpError(503, '방을 만들지 못했어요. 잠시 후 다시 시도해 주세요');
}

function connectRoom(request: Request, env: Env, code: string, url: URL): Promise<Response> {
  const origin = request.headers.get('Origin');
  if (origin && !isAllowedOrigin(origin, env)) throw new HttpError(403, '허용되지 않은 주소예요');
  if (!isRoomCode(code)) throw new HttpError(400, '방 코드가 올바르지 않아요');
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, 'WebSocket 연결이 필요해요');
  const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
  return stub.fetch(`https://room/ws${url.search}`, request);
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const key = `${request.method} ${url.pathname.replace(/\/+$/, '')}`;
  if (key === 'GET /api/health') return json({ ok: true });
  if (key === 'POST /api/rooms') return createRoom(request, env);
  const ws = /^GET \/api\/rooms\/([A-Za-z0-9]+)\/ws$/.exec(key);
  if (ws) return connectRoom(request, env, ws[1].toUpperCase(), url);
  throw new HttpError(404, '없는 주소예요');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // api.ohsangplay.com/bingo/… 로 들어오면 /bingo를 떼고 처리한다.
    request = withoutPrefix(request);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let response: Response;
    try {
      response = await route(request, env);
    } catch (err) {
      if (err instanceof HttpError) {
        response = json({ error: err.message }, err.status);
      } else {
        console.error(err);
        response = json({ error: '잠시 후 다시 시도해 주세요' }, 500);
      }
    }
    if (response.status === 101 || response.webSocket) return response;
    for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
    return response;
  },
} satisfies ExportedHandler<Env>;

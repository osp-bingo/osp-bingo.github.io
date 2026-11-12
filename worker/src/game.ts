/**
 * 빙고 방 규칙 (순수 로직). Durable Object(room.ts)가 상태를 저장하고 이 함수들로 바꾼다.
 */
import {
  MAX_NUMBER,
  MAX_PLAYERS,
  MIN_PLAYERS,
  checkBoard,
  checkNickname,
  checkTopic,
  checkWordBoard,
  cleanWord,
  wordKey,
  goalLines,
  isSize,
  lineCount,
} from '../../web/js/rules.js';

export class RoomError extends Error {}

export type Kind = 'number' | 'topic';
/** player: 차례대로 자기 빙고판 칸을 부른다 / cannon: 차례가 되면 대포를 쏴서 무작위 숫자 (숫자빙고만) */
export type CallMode = 'player' | 'cannon';

/** 칸 값: 숫자빙고는 숫자, 주제빙고는 단어 */
export type Cell = number | string;

export interface Settings {
  kind: Kind;
  size: number;
  callMode: CallMode;
  /** 주제빙고 주제 */
  topic?: string;
}

export interface Player {
  id: string;
  name: string;
  connected: boolean;
  disconnectedAt: number | null;
  ready: boolean;
  /** 칸마다 숫자 (가로 줄 순서). 준비 완료 때 정해진다. */
  board: Cell[] | null;
  marked: boolean[];
  rank: number | null;
  /** 게임 중에 나감 (기권) */
  left: boolean;
  /** 관전자: 빙고판 없이 보기만 한다 (예전 저장 상태엔 없을 수 있음) */
  spectator?: boolean;
}

export interface Call {
  /** 나온 값 (주제빙고는 단어) */
  number: Cell;
  by: string | null;
  how: CallMode;
  /** 차례 시간이 지나 자동으로 (대포 자동 발사 / 내 판에서 무작위로 부름) */
  auto: boolean;
  at: number;
}

export interface Game {
  order: string[];
  turn: string | null;
  deadline: number | null;
  called: Cell[];
  lastCall: Call | null;
  nextRank: number;
  /** 더 부를 숫자가 없어 빙고만 기다리는 중 */
  exhausted: boolean;
}

export interface RoomState {
  code: string;
  phase: 'lobby' | 'playing' | 'finished';
  hostId: string | null;
  players: Player[];
  settings: Settings;
  game: Game | null;
  round: number;
  updatedAt: number;
}

/** 직접 부르기 차례 시간 */
export const TURN_MS_PLAYER = 30_000;
/** 대포 차례 시간 (버튼만 누르면 된다) */
export const TURN_MS_CANNON = 15_000;
/** 연결이 끊긴 사람의 차례는 짧게 기다린다 */
export const DISCONNECTED_TURN_MS = 8_000;
/** 더 부를 숫자가 없을 때 빙고 누르기를 기다리는 시간. 지나면 남은 사람은 줄 수로 등수를 정한다 */
export const EXHAUSTED_WAIT_MS = 60_000;
/** 대기실에서 연결이 끊긴 채 이 시간이 지나면 자리를 비운다 */
export const LOBBY_DROP_MS = 90_000;

/** 관전자는 이만큼까지 */
export const MAX_SPECTATORS = 30;

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 4;

export function isRoomCode(value: string): boolean {
  return value.length === ROOM_CODE_LENGTH && [...value].every((ch) => ROOM_CODE_CHARS.includes(ch));
}

export function randomRoomCode(): string {
  const buf = new Uint32Array(ROOM_CODE_LENGTH);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => ROOM_CODE_CHARS[n % ROOM_CODE_CHARS.length]).join('');
}

export function parseSettings(value: unknown): Settings {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  if (v.kind !== 'number' && v.kind !== 'topic') throw new RoomError('빙고 종류를 골라 주세요');
  if (!isSize(v.size)) throw new RoomError('빙고판 크기를 골라 주세요');
  if (v.kind === 'topic') {
    // 주제빙고는 대포 없이 직접 부르기만
    const t = checkTopic(v.topic);
    if (!t.ok) throw new RoomError(t.error);
    return { kind: 'topic', size: v.size as number, callMode: 'player', topic: t.topic };
  }
  if (v.callMode !== 'player' && v.callMode !== 'cannon') throw new RoomError('숫자 부르는 방식을 골라 주세요');
  return { kind: 'number', size: v.size as number, callMode: v.callMode };
}

const isTopic = (state: RoomState) => state.settings.kind === 'topic';

/** 같은 칸 값인지 (주제빙고는 띄어쓰기·대소문자 무시) */
function keyOf(state: RoomState, v: Cell): Cell {
  return isTopic(state) ? wordKey(v) : v;
}

function calledKeys(state: RoomState): Set<Cell> {
  return new Set((state.game?.called ?? []).map((v) => keyOf(state, v)));
}

export function createRoom(code: string, settings: Settings, now: number): RoomState {
  return { code, phase: 'lobby', hostId: null, players: [], settings, game: null, round: 0, updatedAt: now };
}

function find(state: RoomState, id: string | null | undefined): Player | undefined {
  return id ? state.players.find((p) => p.id === id) : undefined;
}

function need(state: RoomState, id: string): Player {
  const p = find(state, id);
  if (!p || p.left) throw new RoomError('이 방의 참가자가 아니에요');
  return p;
}

function needHost(state: RoomState, id: string): Player {
  const p = need(state, id);
  if (state.hostId !== id) throw new RoomError('방장만 할 수 있어요');
  return p;
}

/** 게임에 참여하는 사람 (관전자·나간 사람 제외) */
function isPlayer(p: Player): boolean {
  return !p.left && !p.spectator;
}

function playerCount(state: RoomState): number {
  return state.players.filter(isPlayer).length;
}

function emptyMarks(size: number): boolean[] {
  return Array.from({ length: size * size }, () => false);
}

/** 방장이 나가면 들어온 순서대로 다음 사람이 방장 (참여자 먼저, 없으면 관전자) */
function fixHost(state: RoomState): void {
  if (find(state, state.hostId) && !find(state, state.hostId)!.left) return;
  state.hostId = (state.players.find(isPlayer) ?? state.players.find((p) => !p.left))?.id ?? null;
}

export function isSeated(state: RoomState, id: string | null): boolean {
  const p = find(state, id);
  return !!p && !p.left;
}

/**
 * 들어오기 (다시 연결이면 같은 자리). 참가자 id를 돌려준다.
 * 게임 중이거나 자리가 꽉 찼으면 관전자로 들어온다. watch=true면 처음부터 관전.
 */
export function join(
  state: RoomState,
  args: { playerId: string | null; name: string; newId: string; watch?: boolean },
  now: number,
): string {
  const existing = find(state, args.playerId);
  if (existing && !existing.left) {
    existing.connected = true;
    existing.disconnectedAt = null;
    state.updatedAt = now;
    return existing.id;
  }
  const checked = checkNickname(args.name);
  if (!checked.ok) throw new RoomError(checked.error);
  if (state.players.some((p) => !p.left && p.name === checked.name)) throw new RoomError('같은 닉네임이 이미 방에 있어요');
  const spectator = !!args.watch || state.phase !== 'lobby' || playerCount(state) >= MAX_PLAYERS;
  if (spectator && state.players.filter((p) => !p.left && p.spectator).length >= MAX_SPECTATORS) {
    throw new RoomError('관전 자리도 꽉 찼어요');
  }
  state.players.push({
    id: args.newId,
    name: checked.name,
    connected: true,
    disconnectedAt: null,
    ready: false,
    board: null,
    marked: emptyMarks(state.settings.size),
    rank: null,
    left: false,
    spectator,
  });
  fixHost(state);
  state.updatedAt = now;
  return args.newId;
}

export function disconnect(state: RoomState, id: string, now: number): void {
  const p = find(state, id);
  if (!p || p.left) return;
  p.connected = false;
  p.disconnectedAt = now;
  const g = state.game;
  // 끊긴 사람 차례면 오래 기다리지 않는다.
  if (state.phase === 'playing' && g && g.turn === id && g.deadline !== null) {
    g.deadline = Math.min(g.deadline, now + DISCONNECTED_TURN_MS);
  }
  state.updatedAt = now;
}

/** 방장이 대기실에서 설정을 바꾼다. 판 크기가 바뀌면 모두의 빙고판과 준비를 지운다. */
export function changeSettings(state: RoomState, id: string, patch: unknown, now: number): void {
  needHost(state, id);
  if (state.phase !== 'lobby') throw new RoomError('게임 중에는 설정을 바꿀 수 없어요');
  const next = parseSettings({ ...state.settings, ...((patch ?? {}) as object) });
  const cur = state.settings;
  if (next.size !== cur.size || next.kind !== cur.kind || (next.kind === 'topic' && next.topic !== cur.topic)) {
    for (const p of state.players) {
      p.board = null;
      p.ready = false;
      p.marked = emptyMarks(next.size);
    }
  }
  state.settings = next;
  state.updatedAt = now;
}

/** 빙고판을 다 채우고 준비 완료 */
export function ready(state: RoomState, id: string, board: unknown, now: number): void {
  const p = need(state, id);
  if (state.phase !== 'lobby') throw new RoomError('지금은 준비할 수 없어요');
  if (p.spectator) throw new RoomError('관전 중에는 준비할 수 없어요. 먼저 참여하기를 눌러 주세요');
  const err = isTopic(state) ? checkWordBoard(board, state.settings.size) : checkBoard(board, state.settings.size);
  if (err) throw new RoomError(err);
  p.board = isTopic(state) ? (board as unknown[]).map(cleanWord) : [...(board as number[])];
  p.marked = emptyMarks(state.settings.size);
  p.ready = true;
  state.updatedAt = now;
}

export function unready(state: RoomState, id: string, now: number): void {
  const p = need(state, id);
  if (state.phase !== 'lobby') return;
  p.ready = false;
  state.updatedAt = now;
}

/** 대기실에서 관전으로 빠지기 */
export function spectate(state: RoomState, id: string, now: number): void {
  const p = need(state, id);
  if (state.phase !== 'lobby') throw new RoomError('대기실에서만 바꿀 수 있어요');
  p.spectator = true;
  p.ready = false;
  state.updatedAt = now;
}

/** 대기실에서 관전하다가 참여하기 */
export function play(state: RoomState, id: string, now: number): void {
  const p = need(state, id);
  if (state.phase !== 'lobby') throw new RoomError('게임이 끝나면 참여할 수 있어요');
  if (!p.spectator) return;
  if (playerCount(state) >= MAX_PLAYERS) throw new RoomError(`참여 자리가 꽉 찼어요 (최대 ${MAX_PLAYERS}명)`);
  p.spectator = false;
  p.ready = false;
  if (p.board && (p.board.length !== state.settings.size ** 2 || typeof p.board[0] !== (isTopic(state) ? 'string' : 'number'))) {
    p.board = null;
  }
  p.marked = emptyMarks(state.settings.size);
  state.updatedAt = now;
}

export function canStart(state: RoomState): boolean {
  const seated = state.players.filter(isPlayer);
  return state.phase === 'lobby' && seated.length >= MIN_PLAYERS && seated.every((p) => p.ready && p.board);
}

export function start(state: RoomState, id: string, now: number, rand: () => number): void {
  needHost(state, id);
  if (state.phase !== 'lobby') throw new RoomError('이미 시작했어요');
  const seated = state.players.filter(isPlayer);
  if (seated.length < MIN_PLAYERS) throw new RoomError(`${MIN_PLAYERS}명 이상 모여야 시작할 수 있어요`);
  if (!canStart(state)) throw new RoomError('모두 준비 완료해야 시작할 수 있어요');
  const order = seated.map((p) => p.id);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (const p of seated) {
    p.marked = emptyMarks(state.settings.size);
    p.rank = null;
  }
  state.phase = 'playing';
  state.round += 1;
  state.game = { order, turn: null, deadline: null, called: [], lastCall: null, nextRank: 1, exhausted: false };
  advanceTurn(state, now);
  state.updatedAt = now;
}

function active(p: Player): boolean {
  return isPlayer(p) && p.rank === null;
}

/** 이 사람이 지금 부를 수 있는 숫자들 */
function callable(state: RoomState, p: Player): Cell[] {
  const called = calledKeys(state);
  if (state.settings.callMode === 'player') {
    // 주제빙고는 이미 칠한 칸(다른 사람이 부른 비슷한 단어로 판단해 칠한 칸)도 부를 수 없다
    return (p.board ?? []).filter((v, i) => !called.has(keyOf(state, v)) && !(isTopic(state) && p.marked[i]));
  }
  const out: number[] = [];
  for (let n = 1; n <= MAX_NUMBER[state.settings.size]; n++) if (!called.has(n)) out.push(n);
  return out;
}

/** 다음 차례로. 등수가 정해졌거나 나간 사람, 부를 숫자가 없는 사람은 건너뛴다. */
function advanceTurn(state: RoomState, now: number): void {
  const g = state.game!;
  const { order } = g;
  const from = g.turn ? order.indexOf(g.turn) : -1;
  for (let i = 1; i <= order.length; i++) {
    const p = find(state, order[(from + i + order.length) % order.length]);
    if (p && active(p) && callable(state, p).length > 0) {
      const ms = state.settings.callMode === 'player' ? TURN_MS_PLAYER : TURN_MS_CANNON;
      g.turn = p.id;
      g.deadline = now + (p.connected ? ms : DISCONNECTED_TURN_MS);
      g.exhausted = false;
      return;
    }
  }
  // 아무도 부를 숫자가 없다: 빙고 누르기만 기다린다.
  g.turn = null;
  g.exhausted = true;
  g.deadline = now + EXHAUSTED_WAIT_MS;
}

function announce(state: RoomState, number: Cell, by: Player, auto: boolean, now: number): void {
  const g = state.game!;
  g.called.push(number);
  g.lastCall = { number, by: by.id, how: state.settings.callMode, auto, at: now };
  // 직접 부른 사람은 그 칸이 자동으로 색칠된다.
  if (state.settings.callMode === 'player' && by.board) {
    const key = keyOf(state, number);
    const idx = by.board.findIndex((v) => keyOf(state, v) === key);
    if (idx >= 0) by.marked[idx] = true;
  }
}

function needTurn(state: RoomState, id: string): Player {
  const p = need(state, id);
  if (state.phase !== 'playing' || !state.game) throw new RoomError('게임 중이 아니에요');
  if (state.game.turn !== id) throw new RoomError('내 차례가 아니에요');
  return p;
}

/** 직접 부르기: 내 빙고판의 아직 안 나온 숫자를 부른다 */
export function callNumber(state: RoomState, id: string, number: unknown, now: number): void {
  const p = needTurn(state, id);
  if (state.settings.callMode !== 'player') throw new RoomError('대포로 숫자를 뽑는 방이에요');
  const what = isTopic(state) ? '단어' : '숫자';
  const value = p.board?.find((v) => (typeof number === typeof v) && keyOf(state, v) === keyOf(state, number as Cell));
  if (value === undefined) throw new RoomError(`내 빙고판에 있는 ${what}만 부를 수 있어요`);
  if (calledKeys(state).has(keyOf(state, value))) throw new RoomError(`이미 나온 ${what}예요`);
  if (isTopic(state) && p.marked[p.board!.indexOf(value)]) throw new RoomError('이미 칠한 칸은 부를 수 없어요');
  announce(state, value, p, false, now);
  advanceTurn(state, now);
  state.updatedAt = now;
}

/** 대포: 아직 안 나온 숫자 중 하나를 무작위로 */
export function fire(state: RoomState, id: string, now: number, rand: () => number): void {
  const p = needTurn(state, id);
  if (state.settings.callMode !== 'cannon') throw new RoomError('직접 부르는 방이에요');
  const pool = callable(state, p);
  announce(state, pool[Math.floor(rand() * pool.length)], p, false, now);
  advanceTurn(state, now);
  state.updatedAt = now;
}

/** 나온 숫자를 직접 색칠한다. 안 나온 숫자는 칠할 수 없다. */
export function mark(state: RoomState, id: string, cell: unknown, now: number): void {
  const p = need(state, id);
  if (p.spectator) return;
  if (state.phase !== 'playing' || !state.game || !p.board) throw new RoomError('게임 중이 아니에요');
  if (typeof cell !== 'number' || !Number.isInteger(cell) || cell < 0 || cell >= p.board.length) return;
  if (p.marked[cell]) return;
  if (isTopic(state)) {
    // 주제빙고: 같은 단어인지는 각자 판단해서 칠한다. 다만 나온 단어 수보다 많이 칠할 수는 없다.
    if (p.rank !== null) return;
    const g = state.game;
    if (g.called.length === 0) throw new RoomError('아직 나온 단어가 없어요');
    if (p.marked.filter(Boolean).length >= g.called.length) {
      throw new RoomError(`지금까지 나온 단어가 ${g.called.length}개라 더 칠할 수 없어요`);
    }
  } else if (!calledKeys(state).has(keyOf(state, p.board[cell]))) {
    throw new RoomError('아직 나오지 않은 숫자예요');
  }
  p.marked[cell] = true;
  state.updatedAt = now;
}

/** 주제빙고: 잘못 칠한 칸 지우기 (나온 단어와 글자가 똑같은 칸은 지울 수 없다) */
export function unmark(state: RoomState, id: string, cell: unknown, now: number): void {
  const p = need(state, id);
  if (p.spectator || !isTopic(state)) return;
  if (state.phase !== 'playing' || !state.game || !p.board) throw new RoomError('게임 중이 아니에요');
  if (typeof cell !== 'number' || !Number.isInteger(cell) || cell < 0 || cell >= p.board.length) return;
  if (!p.marked[cell] || p.rank !== null) return;
  if (calledKeys(state).has(keyOf(state, p.board[cell]))) throw new RoomError('나온 단어와 같은 칸은 지울 수 없어요');
  p.marked[cell] = false;
  state.updatedAt = now;
}

/** 빙고! 색칠한 칸으로 목표 줄 수를 채웠으면 누른 순서대로 등수 */
export function bingo(state: RoomState, id: string, now: number): void {
  const p = need(state, id);
  const g = state.game;
  if (p.spectator) throw new RoomError('관전 중이에요');
  if (state.phase !== 'playing' || !g || !p.board) throw new RoomError('게임 중이 아니에요');
  if (p.rank !== null) return;
  const goal = goalLines(state.settings.size);
  if (lineCount(p.marked, state.settings.size) < goal) throw new RoomError(`빙고 ${goal}줄을 먼저 완성해 주세요`);
  p.rank = g.nextRank++;
  if (!finishIfDone(state, now) && g.turn === id) advanceTurn(state, now);
  state.updatedAt = now;
}

/** 남은 사람이 한 명이면 꼴찌로 정하고 끝낸다. */
function finishIfDone(state: RoomState, now: number): boolean {
  const g = state.game!;
  const remaining = state.players.filter(active);
  if (remaining.length > 1) return false;
  if (remaining.length === 1) remaining[0].rank = g.nextRank++;
  finish(state, now);
  return true;
}

function finish(state: RoomState, now: number): void {
  const g = state.game!;
  state.phase = 'finished';
  g.turn = null;
  g.deadline = null;
  g.exhausted = false;
  state.updatedAt = now;
}

/** 나가기. 대기실이면 자리를 비우고, 게임 중이면 기권. */
export function leave(state: RoomState, id: string, now: number): void {
  const p = find(state, id);
  if (!p || p.left) return;
  if (state.phase === 'lobby' || p.spectator) {
    state.players = state.players.filter((x) => x.id !== id);
  } else {
    p.left = true;
    p.connected = false;
    if (state.phase === 'playing') {
      const g = state.game!;
      if (!finishIfDone(state, now) && g.turn === id) advanceTurn(state, now);
    }
  }
  fixHost(state);
  state.updatedAt = now;
}

/** 다시 하기: 같은 방 대기실로. 빙고판은 남겨 두고 준비만 푼다. */
export function rematch(state: RoomState, id: string, now: number): void {
  needHost(state, id);
  if (state.phase !== 'finished') throw new RoomError('게임이 끝난 뒤에 할 수 있어요');
  state.players = state.players.filter((p) => !p.left);
  for (const p of state.players) {
    p.ready = false;
    p.rank = null;
    p.marked = emptyMarks(state.settings.size);
  }
  state.phase = 'lobby';
  state.game = null;
  fixHost(state);
  state.updatedAt = now;
}

/**
 * 시간에 따른 변화: 차례 시간 초과(대포 자동 발사 / 내 판에서 무작위로 부르기), 부를 숫자가 없을 때 마감, 대기실 오래 끊긴 사람 정리.
 * 바뀐 게 있으면 true.
 */
export function tick(state: RoomState, now: number, rand: () => number): boolean {
  // 오래 끊긴 사람 정리: 대기실은 모두, 게임 중에는 관전자만
  const gone = (p: Player) =>
    (state.phase === 'lobby' || p.spectator) && !p.connected && p.disconnectedAt !== null && now - p.disconnectedAt >= LOBBY_DROP_MS;
  if (state.players.some(gone)) {
    state.players = state.players.filter((p) => !gone(p));
    fixHost(state);
    state.updatedAt = now;
    return true;
  }
  if (state.phase === 'lobby') return false;
  const g = state.game;
  if (state.phase !== 'playing' || !g || g.deadline === null || now < g.deadline) return false;

  if (g.exhausted || !g.turn) {
    // 더 나올 숫자가 없다: 남은 사람은 색칠한 줄 수가 많은 순으로 (같으면 같은 등수)
    const remaining = state.players.filter(active);
    const lines = new Map(remaining.map((p) => [p.id, lineCount(p.marked, state.settings.size)]));
    const base = g.nextRank;
    for (const p of remaining) {
      p.rank = base + remaining.filter((q) => lines.get(q.id)! > lines.get(p.id)!).length;
    }
    g.nextRank = base + remaining.length;
    finish(state, now);
    return true;
  }

  // 차례 시간 초과: 차례를 그냥 넘기지 않는다.
  // 대포는 자동 발사, 직접 부르기는 그 사람 빙고판에서 아직 안 나온 숫자를 무작위로 불러 준다.
  const p = find(state, g.turn)!;
  const pool = callable(state, p);
  if (pool.length > 0) announce(state, pool[Math.floor(rand() * pool.length)], p, true, now);
  advanceTurn(state, now);
  state.updatedAt = now;
  return true;
}

/** 다음에 깨어나야 할 시각 (차례 마감, 대기실 정리) */
export function nextWake(state: RoomState): number | null {
  const times = state.players
    .filter((p) => (state.phase === 'lobby' || p.spectator) && !p.connected && p.disconnectedAt !== null)
    .map((p) => p.disconnectedAt! + LOBBY_DROP_MS);
  if (state.phase === 'playing' && state.game?.deadline != null) times.push(state.game.deadline);
  return times.length ? Math.min(...times) : null;
}

/** 한 사람에게 보내는 화면 정보. 참여자에게는 다른 사람의 빙고판 숫자를 보내지 않는다 (관전자만 전부 본다). */
export function viewFor(state: RoomState, id: string | null, now: number) {
  const size = state.settings.size;
  const me = find(state, id);
  const g = state.game;
  const byName = (pid: string | null) => find(state, pid)?.name ?? null;
  return {
    type: 'state' as const,
    serverNow: now,
    code: state.code,
    phase: state.phase,
    round: state.round,
    hostId: state.hostId,
    me: me && !me.left ? me.id : null,
    settings: state.settings,
    maxNumber: isTopic(state) ? null : MAX_NUMBER[size],
    goal: goalLines(size),
    canStart: canStart(state),
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      ready: p.ready,
      left: p.left,
      spectator: !!p.spectator,
      rank: p.rank,
      lines: state.phase === 'lobby' ? null : lineCount(p.marked, size),
    })),
    my:
      me && !me.left
        ? { board: me.board, marked: me.marked, ready: me.ready, rank: me.rank, spectator: !!me.spectator }
        : null,
    /** 모든 사람의 빙고판: 관전자는 게임 중에도, 게임이 끝나면 모두에게 공개 */
    boards:
      (me && !me.left && me.spectator && state.phase !== 'lobby') || state.phase === 'finished'
        ? state.players
            .filter((p) => !p.spectator && p.board && state.game?.order.includes(p.id))
            .map((p) => ({ id: p.id, board: p.board, marked: p.marked }))
        : null,
    game: g
      ? {
          order: g.order,
          turn: g.turn,
          deadline: g.deadline,
          called: g.called,
          lastCall: g.lastCall ? { ...g.lastCall, byName: byName(g.lastCall.by) } : null,
          exhausted: g.exhausted,
        }
      : null,
  };
}

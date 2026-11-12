import { describe, expect, it } from 'vitest';
import {
  type RoomState,
  RoomError,
  bingo,
  callNumber,
  changeSettings,
  createRoom,
  disconnect,
  fire,
  join,
  leave,
  mark,
  ready,
  rematch,
  start,
  tick,
  viewFor,
  TURN_MS_PLAYER,
  TURN_MS_CANNON,
  EXHAUSTED_WAIT_MS,
  LOBBY_DROP_MS,
} from '../src/game';
import { checkBoard, checkNickname, completedLines, fillRandom, lineCount } from '../../web/js/rules.js';

const T = 1_000_000;
/** 항상 0 → 섞기 결과가 정해진다 */
const zero = () => 0;
/** 섞어도 순서가 그대로 (들어온 순서가 곧 차례) */
const keep = () => 0.999999;

function room(size = 3, callMode: 'player' | 'cannon' = 'player'): RoomState {
  return createRoom('ABCD', { kind: 'number', size, callMode }, T);
}

/** 3×3 빙고판: 사람마다 겹치지 않게 (a: 1~9, b: 7~15) */
const boardA = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const boardB = [7, 8, 9, 10, 11, 12, 13, 14, 15];
const boardC = [9, 8, 7, 6, 5, 4, 3, 2, 1];

function setup(n = 2, callMode: 'player' | 'cannon' = 'player') {
  const s = room(3, callMode);
  const ids = ['가나', '다라', '마바'].slice(0, n).map((name, i) => join(s, { playerId: null, name, newId: `p${i}` }, T));
  const boards = [boardA, boardB, boardC];
  ids.forEach((id, i) => ready(s, id, boards[i], T));
  start(s, ids[0], T, keep);
  return { s, ids };
}

describe('규칙', () => {
  it('닉네임은 한글·영문·숫자 2~10자', () => {
    expect(checkNickname('철수').ok).toBe(true);
    expect(checkNickname('  빙고 왕  ')).toEqual({ ok: true, name: '빙고 왕' });
    expect(checkNickname('ㅋㅋ').ok).toBe(true);
    expect(checkNickname('a').ok).toBe(false);
    expect(checkNickname('가나다라마바사아자차카').ok).toBe(false);
    expect(checkNickname('철수!').ok).toBe(false);
  });

  it('빙고판: 범위와 중복 검사', () => {
    expect(checkBoard(boardA, 3)).toBeNull();
    expect(checkBoard([1, 1, 3, 4, 5, 6, 7, 8, 9], 3)).toMatch('두 번');
    expect(checkBoard([16, 2, 3, 4, 5, 6, 7, 8, 9], 3)).toMatch('1~15');
    expect(checkBoard(boardA, 5)).toMatch('칸 수');
  });

  it('줄 수: 가로·세로·대각선', () => {
    const m = Array(9).fill(false);
    [0, 1, 2].forEach((i) => (m[i] = true));
    expect(lineCount(m, 3)).toBe(1);
    [4, 8].forEach((i) => (m[i] = true));
    expect(lineCount(m, 3)).toBe(2);
    expect(lineCount(Array(9).fill(true), 3)).toBe(8);
    expect(completedLines(Array(81).fill(true), 9)).toHaveLength(20);
  });

  it('랜덤 채우기는 빈 칸만, 겹치지 않게', () => {
    for (const size of [3, 5, 7, 9]) {
      const cells = Array(size * size).fill(0);
      cells[0] = 1;
      const filled = fillRandom(cells, size);
      expect(filled[0]).toBe(1);
      expect(checkBoard(filled, size)).toBeNull();
    }
  });
});

describe('대기실', () => {
  it('먼저 들어온 사람이 방장, 같은 닉네임은 안 됨, 8명까지', () => {
    const s = room();
    join(s, { playerId: null, name: '가나', newId: 'a' }, T);
    expect(s.hostId).toBe('a');
    expect(() => join(s, { playerId: null, name: '가나', newId: 'b' }, T)).toThrow('같은 닉네임');
    for (let i = 0; i < 7; i++) join(s, { playerId: null, name: `손님${i}`, newId: `g${i}` }, T);
    expect(() => join(s, { playerId: null, name: '늦음', newId: 'x' }, T)).toThrow('꽉 찼');
  });

  it('모두 준비해야 방장이 시작', () => {
    const s = room();
    const a = join(s, { playerId: null, name: '가나', newId: 'a' }, T);
    const b = join(s, { playerId: null, name: '다라', newId: 'b' }, T);
    ready(s, a, boardA, T);
    expect(() => start(s, a, T, zero)).toThrow('준비');
    ready(s, b, boardB, T);
    expect(() => start(s, b, T, zero)).toThrow('방장');
    start(s, a, T, zero);
    expect(s.phase).toBe('playing');
  });

  it('판 크기를 바꾸면 빙고판과 준비가 풀림', () => {
    const s = room();
    const a = join(s, { playerId: null, name: '가나', newId: 'a' }, T);
    ready(s, a, boardA, T);
    changeSettings(s, a, { callMode: 'cannon' }, T);
    expect(s.players[0].ready).toBe(true);
    changeSettings(s, a, { size: 5 }, T);
    expect(s.players[0].ready).toBe(false);
    expect(s.players[0].board).toBeNull();
    expect(() => changeSettings(s, a, { kind: 'topic' }, T)).toThrow('준비 중');
  });

  it('방장이 나가면 다음 사람이 방장', () => {
    const s = room();
    const a = join(s, { playerId: null, name: '가나', newId: 'a' }, T);
    join(s, { playerId: null, name: '다라', newId: 'b' }, T);
    leave(s, a, T);
    expect(s.hostId).toBe('b');
    expect(s.players).toHaveLength(1);
  });

  it('대기실에서 오래 끊긴 사람은 정리', () => {
    const s = room();
    const a = join(s, { playerId: null, name: '가나', newId: 'a' }, T);
    disconnect(s, a, T);
    expect(tick(s, T + LOBBY_DROP_MS - 1, zero)).toBe(false);
    expect(tick(s, T + LOBBY_DROP_MS, zero)).toBe(true);
    expect(s.players).toHaveLength(0);
  });

  it('게임 시작 후에는 새로 못 들어오고, 원래 사람은 다시 연결', () => {
    const { s, ids } = setup();
    expect(() => join(s, { playerId: null, name: '새손님', newId: 'z' }, T)).toThrow('시작된');
    disconnect(s, ids[1], T);
    expect(join(s, { playerId: ids[1], name: '', newId: 'z' }, T)).toBe(ids[1]);
  });
});

describe('직접 부르기', () => {
  it('차례대로 내 판의 숫자를 부르고, 부른 사람만 자동 색칠', () => {
    const { s, ids } = setup();
    const [a, b] = ids;
    expect(s.game!.turn).toBe(a);
    expect(() => callNumber(s, b, 7, T)).toThrow('차례');
    expect(() => callNumber(s, a, 10, T)).toThrow('빙고판에 있는');
    callNumber(s, a, 7, T);
    expect(s.players[0].marked[6]).toBe(true);
    expect(s.players[1].marked[0]).toBe(false); // b는 직접 칠해야
    expect(s.game!.turn).toBe(b);
    expect(() => callNumber(s, b, 7, T)).toThrow('이미 나온');
  });

  it('안 나온 숫자는 칠할 수 없음', () => {
    const { s, ids } = setup();
    expect(() => mark(s, ids[1], 1, T)).toThrow('나오지 않은');
    callNumber(s, ids[0], 7, T);
    mark(s, ids[1], 0, T);
    expect(s.players[1].marked[0]).toBe(true);
  });

  it('숫자가 나왔어도 칠하지 않으면 빙고가 아님', () => {
    const { s, ids } = setup();
    const [a, b] = ids;
    // b가 7·8·9(첫 줄)를 받지만 칠하지 않음
    callNumber(s, a, 7, T);
    callNumber(s, b, 10, T);
    callNumber(s, a, 8, T);
    callNumber(s, b, 11, T);
    callNumber(s, a, 9, T);
    expect(() => bingo(s, b, T)).toThrow('3줄');
  });

  it('빙고 누른 순서로 등수, 꼴찌가 정해지면 끝', () => {
    const { s, ids } = setup(3);
    const [a, b, c] = ids;
    const pa = s.players[0];
    // a가 모든 칸을 칠한 상태로 만든다
    s.game!.called.push(...boardA);
    pa.marked.fill(true);
    bingo(s, a, T);
    expect(pa.rank).toBe(1);
    expect(s.phase).toBe('playing');
    expect(s.game!.turn).toBe(b); // 1등은 차례에서 빠짐
    s.players[2].marked.fill(true);
    bingo(s, c, T);
    expect(s.players[2].rank).toBe(2);
    expect(s.players[1].rank).toBe(3);
    expect(s.phase).toBe('finished');
  });

  it('등수가 정해진 사람 차례는 건너뜀', () => {
    const { s, ids } = setup(3);
    const [a, b, c] = ids;
    s.players[1].marked.fill(true);
    s.game!.called.push(...boardB);
    bingo(s, b, T);
    callNumber(s, a, 1, T);
    expect(s.game!.turn).toBe(c);
    callNumber(s, c, 4, T);
    expect(s.game!.turn).toBe(a);
  });

  it('시간이 지나면 내 빙고판 숫자 중 하나를 자동으로 부르고 칠함', () => {
    const { s, ids } = setup();
    expect(tick(s, T + TURN_MS_PLAYER - 1, zero)).toBe(false);
    expect(tick(s, T + TURN_MS_PLAYER, zero)).toBe(true);
    const last = s.game!.lastCall!;
    expect(last).toMatchObject({ by: ids[0], how: 'player', auto: true });
    expect(boardA).toContain(last.number);
    expect(s.players[0].marked[boardA.indexOf(last.number)]).toBe(true);
    expect(s.game!.turn).toBe(ids[1]);
  });

  it('2명일 때 1등이 나오면 바로 꼴찌도 정해짐', () => {
    const { s, ids } = setup();
    const g = s.game!;
    g.called.push(...new Set([...boardA, ...boardB]));
    s.players[0].marked.fill(true);
    s.players[1].marked[0] = s.players[1].marked[1] = s.players[1].marked[2] = true;
    bingo(s, ids[0], T);
    expect(s.phase).toBe('finished'); // 2명이면 1등이 나오는 순간 꼴찌도 정해짐
    expect(s.players[1].rank).toBe(2);
  });

  it('남은 숫자가 없을 때 마감 처리', () => {
    const { s } = setup(3);
    const g = s.game!;
    g.called.push(...Array.from({ length: 15 }, (_, i) => i + 1));
    // 아무도 칠하지 않음 → 시간 초과 처리로 진입
    tick(s, T + TURN_MS_PLAYER, zero);
    expect(g.exhausted).toBe(true);
    s.players[1].marked.fill(true);
    s.players[2].marked[0] = s.players[2].marked[1] = s.players[2].marked[2] = true;
    tick(s, g.deadline! + EXHAUSTED_WAIT_MS, zero);
    expect(s.phase).toBe('finished');
    expect(s.players.map((p) => p.rank)).toEqual([3, 1, 2]);
  });

  it('게임 중 나가면 기권, 남은 사람이 한 명이면 끝', () => {
    const { s, ids } = setup();
    leave(s, ids[0], T);
    expect(s.phase).toBe('finished');
    expect(s.players[1].rank).toBe(1);
    expect(s.players[0].rank).toBeNull();
    expect(s.hostId).toBe(ids[1]);
  });

  it('다시 하기: 대기실로, 빙고판은 남김', () => {
    const { s, ids } = setup();
    leave(s, ids[1], T);
    rematch(s, ids[0], T);
    expect(s.phase).toBe('lobby');
    expect(s.players).toHaveLength(1);
    expect(s.players[0].board).toEqual(boardA);
    expect(s.players[0].ready).toBe(false);
  });
});

describe('대포', () => {
  it('차례인 사람이 쏘면 범위 안의 안 나온 숫자, 아무도 자동 색칠 안 함', () => {
    const { s, ids } = setup(2, 'cannon');
    expect(() => callNumber(s, ids[0], 1, T)).toThrow(RoomError);
    fire(s, ids[0], T, zero);
    const n = s.game!.lastCall!.number;
    expect(n).toBe(1);
    expect(s.players[0].marked.some(Boolean)).toBe(false);
    expect(s.game!.turn).toBe(ids[1]);
    fire(s, ids[1], T, zero);
    expect(s.game!.lastCall!.number).toBe(2);
  });

  it('시간이 지나면 대포가 자동 발사', () => {
    const { s, ids } = setup(2, 'cannon');
    tick(s, T + TURN_MS_CANNON, zero);
    expect(s.game!.lastCall).toMatchObject({ number: 1, by: ids[0], how: 'cannon', auto: true });
    expect(s.players[0].marked.some(Boolean)).toBe(false);
    expect(s.game!.turn).toBe(ids[1]);
  });
});

describe('화면 정보', () => {
  it('다른 사람의 빙고판은 보내지 않음', () => {
    const { s, ids } = setup();
    const v = viewFor(s, ids[0], T);
    expect(v.my!.board).toEqual(boardA);
    expect(JSON.stringify(v.players)).not.toContain('"board"');
    expect(v.goal).toBe(3);
    expect(v.maxNumber).toBe(15);
  });
});

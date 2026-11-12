// 빙고 규칙. 웹과 서버(worker)가 함께 쓴다.

/** 빙고판 크기 (한 줄 칸 수) */
export const SIZES = /** @type {const} */ ([3, 5, 7, 9]);

/** 판 크기별로 입력할 수 있는 가장 큰 숫자 (1부터) */
export const MAX_NUMBER = /** @type {Record<number, number>} */ ({ 3: 15, 5: 35, 7: 63, 9: 99 });

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;

export const NAME_MIN = 2;
export const NAME_MAX = 10;

/** 이기려면 완성해야 하는 빙고 줄 수 (3×3 → 3줄, 5×5 → 5줄 …) */
export function goalLines(/** @type {number} */ size) {
  return size;
}

/** @param {unknown} value */
export function isSize(value) {
  return typeof value === 'number' && SIZES.includes(/** @type {any} */ (value));
}

/**
 * 닉네임: 한글·영문·숫자, 가운데 공백 하나까지, 2~10글자.
 * @param {unknown} value
 * @returns {{ ok: true, name: string } | { ok: false, error: string }}
 */
export function checkNickname(value) {
  if (typeof value !== 'string') return { ok: false, error: '닉네임을 입력해 주세요' };
  const name = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!name) return { ok: false, error: '닉네임을 입력해 주세요' };
  const len = [...name].length;
  if (len < NAME_MIN || len > NAME_MAX) return { ok: false, error: `닉네임은 ${NAME_MIN}~${NAME_MAX}글자로 해 주세요` };
  if (!/^[가-힣ㄱ-ㅎㅏ-ㅣA-Za-z0-9 ]+$/.test(name)) return { ok: false, error: '닉네임은 한글·영문·숫자로만 만들 수 있어요' };
  return { ok: true, name };
}

/**
 * 빙고판 검사. 칸 수가 맞고, 모든 칸이 1~최대 숫자이며 겹치지 않아야 한다.
 * @param {unknown} board
 * @param {number} size
 * @returns {string | null} 문제가 있으면 안내 문구
 */
export function checkBoard(board, size) {
  if (!Array.isArray(board) || board.length !== size * size) return '빙고판 칸 수가 맞지 않아요';
  const max = MAX_NUMBER[size];
  const seen = new Set();
  for (const n of board) {
    if (!Number.isInteger(n) || n < 1 || n > max) return `모든 칸에 1~${max} 숫자를 넣어 주세요`;
    if (seen.has(n)) return '같은 숫자를 두 번 넣을 수 없어요';
    seen.add(n);
  }
  return null;
}

/**
 * 완성한 빙고 줄 수 (가로·세로·대각선 2개).
 * @param {readonly boolean[]} marked
 * @param {number} size
 */
export function lineCount(marked, size) {
  return completedLines(marked, size).length;
}

/**
 * 완성한 줄 목록. 각 줄은 칸 번호 배열.
 * @param {readonly boolean[]} marked
 * @param {number} size
 * @returns {number[][]}
 */
export function completedLines(marked, size) {
  /** @type {number[][]} */
  const lines = [];
  for (let r = 0; r < size; r++) lines.push(Array.from({ length: size }, (_, c) => r * size + c));
  for (let c = 0; c < size; c++) lines.push(Array.from({ length: size }, (_, r) => r * size + c));
  lines.push(Array.from({ length: size }, (_, i) => i * size + i));
  lines.push(Array.from({ length: size }, (_, i) => i * size + (size - 1 - i)));
  return lines.filter((line) => line.every((i) => marked[i]));
}

/**
 * 빈 칸(0)만 겹치지 않는 무작위 숫자로 채운다.
 * @param {readonly number[]} cells
 * @param {number} size
 * @param {() => number} [rand]
 */
export function fillRandom(cells, size, rand = Math.random) {
  const max = MAX_NUMBER[size];
  const used = new Set(cells.filter((n) => n > 0));
  /** @type {number[]} */
  const pool = [];
  for (let n = 1; n <= max; n++) if (!used.has(n)) pool.push(n);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return cells.map((n) => (n > 0 ? n : /** @type {number} */ (pool.pop())));
}

/* ------------------------------------------------ 주제빙고 */

export const TOPIC_MAX = 20;
export const WORD_MAX = 12;

/**
 * 주제: 1~20글자.
 * @param {unknown} value
 * @returns {{ ok: true, topic: string } | { ok: false, error: string }}
 */
export function checkTopic(value) {
  const topic = typeof value === 'string' ? value.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
  if (!topic) return { ok: false, error: '주제를 입력해 주세요' };
  if ([...topic].length > TOPIC_MAX) return { ok: false, error: `주제는 ${TOPIC_MAX}글자까지 쓸 수 있어요` };
  return { ok: true, topic };
}

/** 칸에 넣는 단어를 보기 좋게 다듬는다 (앞뒤 공백, 겹친 공백) */
export function cleanWord(/** @type {unknown} */ value) {
  return typeof value === 'string' ? value.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
}

/**
 * 같은 단어인지 비교할 때 쓰는 키: 띄어쓰기·영문 대소문자 차이는 같은 단어로 본다.
 * @param {unknown} value
 */
export function wordKey(value) {
  return cleanWord(value).replace(/\s/g, '').toLowerCase();
}

/**
 * 주제빙고 빙고판 검사: 모든 칸에 1~12글자 단어, 내 판 안에서 겹치지 않게.
 * @param {unknown} board
 * @param {number} size
 * @returns {string | null}
 */
export function checkWordBoard(board, size) {
  if (!Array.isArray(board) || board.length !== size * size) return '빙고판 칸 수가 맞지 않아요';
  const seen = new Set();
  for (const raw of board) {
    const word = cleanWord(raw);
    if (!word) return '모든 칸에 단어를 넣어 주세요';
    if ([...word].length > WORD_MAX) return `단어는 ${WORD_MAX}글자까지 쓸 수 있어요`;
    const key = wordKey(word);
    if (seen.has(key)) return `'${word}'를 두 번 넣었어요`;
    seen.add(key);
  }
  return null;
}

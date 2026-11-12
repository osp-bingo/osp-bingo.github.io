import { RoomConnection, activeRoom, createRoom } from './net.js';
import { MAX_NUMBER, SIZES, checkBoard, checkNickname, completedLines, fillRandom, goalLines } from './rules.js';

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
const NICK_KEY = 'bingo.nick';
const TURN_MS = { player: 30_000, cannon: 15_000 };
const EXHAUSTED_MS = 60_000;

/** @type {RoomConnection | null} */
let conn = null;
let view = null;
let prev = null;
/** 대기실에서 채우는 빙고판 (0 = 빈 칸) */
let draft = { key: '', cells: [], selected: 0 };
/** 방금 색칠한 칸 (도장 애니메이션) */
let stampCell = -1;
let shownResultRound = -1;
let timerHandle = 0;

const createSettings = { kind: 'number', size: 5, callMode: 'player' };

/* ------------------------------------------------ 공통 */

function store(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // 무시
  }
}
function load(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function show(id) {
  for (const s of ['home', 'create', 'room']) $(s).hidden = s !== id;
  window.scrollTo(0, 0);
}

let toastTimer = 0;
function toast(message, big = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('big', big);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), big ? 2600 : 2000);
}

function buzz(ms) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    // 무시
  }
}

const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, String(v));
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
};

const callModeName = (m) => (m === 'player' ? '직접 부르기' : '대포');

/* ------------------------------------------------ 홈 */

function readNick() {
  const r = checkNickname(/** @type {HTMLInputElement} */ ($('nick')).value);
  $('nick-error').textContent = r.ok ? '' : r.error;
  if (!r.ok) {
    $('nick').focus();
    return null;
  }
  store(NICK_KEY, r.name);
  return r.name;
}

function initHome() {
  const nick = /** @type {HTMLInputElement} */ ($('nick'));
  nick.value = load(NICK_KEY) ?? '';
  nick.addEventListener('input', () => ($('nick-error').textContent = ''));

  const params = new URLSearchParams(location.search);
  const invited = (params.get('room') ?? '').toUpperCase();
  const code = /** @type {HTMLInputElement} */ ($('join-code'));
  if (/^[A-Z0-9]{4}$/.test(invited)) code.value = invited;

  const resume = activeRoom();
  if (resume && resume !== invited) {
    $('resume').hidden = false;
    $('resume-code').textContent = resume;
    $('resume-go').addEventListener('click', () => {
      const name = readNick();
      if (name) enterRoom(resume, name);
    });
  }

  $('go-create').addEventListener('click', () => {
    if (!readNick()) return;
    renderCreate();
    show('create');
  });
  const join = () => {
    const c = code.value.trim().toUpperCase();
    const name = readNick();
    if (!name) return;
    if (!/^[A-Z0-9]{4}$/.test(c)) {
      toast('방 코드 4자리를 입력해 주세요');
      code.focus();
      return;
    }
    enterRoom(c, name);
  };
  $('join-go').addEventListener('click', join);
  code.addEventListener('keydown', (e) => e.key === 'Enter' && join());

  document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => show('home')));
  document.querySelectorAll('[data-open]').forEach((b) =>
    b.addEventListener('click', () => /** @type {HTMLDialogElement} */ ($(b.getAttribute('data-open'))).showModal()),
  );

  // 새로고침: 앉아 있던 방이면 바로 같은 자리로 돌아간다.
  const saved = checkNickname(nick.value);
  if (resume && resume === invited && saved.ok) {
    enterRoom(resume, saved.name);
    return;
  }
  show('home');
  if (/^[A-Z0-9]{4}$/.test(invited) && nick.value) $('join-go').focus();
}

/** 빙고 종류·판 크기·부르는 방식 고르기. settings를 바로 바꾼다. */
function settingsChoices(settings, onChange) {
  const group = (legend, cls, items) =>
    el('fieldset', { class: 'choice-group' }, el('legend', { text: legend }), el('div', { class: `choices ${cls}`, role: 'radiogroup' }, ...items));
  const choice = (key, value, title, sub, disabled = false) =>
    el(
      'button',
      {
        type: 'button',
        class: 'choice',
        role: 'radio',
        'aria-checked': String(settings[key] === value),
        disabled,
        onclick: () => {
          settings[key] = value;
          onChange();
        },
      },
      el('b', { text: title }),
      sub,
    );
  return el(
    'div',
    { class: 'settings' },
    group('빙고 종류', 'two', [
      choice('kind', 'number', '숫자빙고', el('small', { text: '숫자를 채우고 불러요' })),
      choice('kind', 'topic', '주제빙고', el('small', { class: 'soon', text: '준비 중' }), true),
    ]),
    group(
      '빙고판 크기',
      'sizes',
      SIZES.map((n) => choice('size', n, `${n}×${n}`, el('small', {}, `1~${MAX_NUMBER[n]}`, el('br'), `${goalLines(n)}줄 빙고`))),
    ),
    group('숫자 부르는 방식', 'two', [
      choice('callMode', 'player', '직접 부르기', el('small', { text: '차례가 되면 내 빙고판 숫자를 골라 불러요' })),
      choice('callMode', 'cannon', '대포', el('small', { text: '차례가 되면 대포를 쏴서 무작위 숫자가 나와요' })),
    ]),
  );
}

function renderCreate() {
  const form = $('create-form');
  const go = el('button', { class: 'btn btn-primary btn-big', text: '방 만들기' });
  go.addEventListener('click', async () => {
    const name = readNick();
    if (!name) return show('home');
    go.disabled = true;
    try {
      const code = await createRoom(createSettings);
      enterRoom(code, name);
    } catch (err) {
      toast(err instanceof Error ? err.message : '방을 만들지 못했어요');
    } finally {
      go.disabled = false;
    }
  });
  form.replaceChildren(settingsChoices(createSettings, renderCreate), go);
}

/* ------------------------------------------------ 방 */

function enterRoom(code, name) {
  conn?.close();
  view = null;
  prev = null;
  shownResultRound = -1;
  draft = { key: '', cells: [], selected: 0 };
  $('room-code').textContent = code;
  $('room-rule').textContent = '들어가는 중…';
  $('players').replaceChildren();
  $('board').replaceChildren();
  $('actions').replaceChildren();
  $('caller').hidden = true;
  $('picker-wrap').hidden = true;
  $('history-wrap').hidden = true;
  show('room');
  history.replaceState(null, '', `${location.pathname}?room=${code}`);

  conn = new RoomConnection({
    code,
    name,
    onState: onState,
    onError: (message, fatal) => {
      toast(message);
      if (fatal) exitRoom(false);
    },
    onStatus: (s) => ($('conn').hidden = s === 'open'),
  });
  conn.connect();
  conn.watchResume();
  clearInterval(timerHandle);
  timerHandle = setInterval(updateTimer, 200);
}

function exitRoom(sendLeave = true) {
  if (sendLeave) conn?.leave();
  else conn?.close();
  conn = null;
  view = null;
  clearInterval(timerHandle);
  for (const d of document.querySelectorAll('dialog')) /** @type {HTMLDialogElement} */ (d).close();
  $('shot').hidden = true;
  history.replaceState(null, '', location.pathname);
  $('resume').hidden = true;
  show('home');
}

const draftKey = (v) => `bingo.draft.${v.code}.${v.settings.size}`;

/** 서버 상태에 맞춰 내 빙고판 초안을 맞춘다. */
function syncDraft(v) {
  const size = v.settings.size;
  const key = draftKey(v);
  if (draft.key !== key) {
    let cells = null;
    try {
      const saved = JSON.parse(load(key) ?? 'null');
      if (Array.isArray(saved) && saved.length === size * size) cells = saved.map((n) => (Number.isInteger(n) ? n : 0));
    } catch {
      // 무시
    }
    cells ??= v.my?.board ? [...v.my.board] : Array(size * size).fill(0);
    draft = { key, cells, selected: Math.max(0, cells.indexOf(0)) };
  }
  if (v.my?.board && (v.my.ready || v.phase !== 'lobby')) draft.cells = [...v.my.board];
}

function saveDraft() {
  if (view) store(draftKey(view), JSON.stringify(draft.cells));
}

function onState(v) {
  prev = view;
  view = v;
  syncDraft(v);
  announce(prev, v);
  render();
}

let shotTimer = 0;
/** 대포 발사 레이어: 반투명 배경 위로 공이 날아와 숫자가 뜬다. 잠시 뒤(또는 누르면) 닫힌다. */
function showShot(call, onMyBoard) {
  const layer = $('shot');
  clearTimeout(shotTimer);
  layer.hidden = true;
  layer.classList.remove('out');
  $('shot-num').textContent = String(call.number);
  const caption = $('shot-caption');
  caption.replaceChildren(
    call.auto ? `${call.byName ?? ''}님 시간이 지나 대포가 자동 발사!` : `${call.byName ?? ''}님의 대포!`,
    el('br'),
    el('b', { class: onMyBoard ? 'yes' : 'no', text: onMyBoard ? '내 판에 있어요' : '내 판에 없어요' }),
  );
  void layer.offsetWidth;
  layer.hidden = false; // 다시 보이면서 애니메이션이 처음부터
  const close = () => {
    clearTimeout(shotTimer);
    layer.classList.add('out');
    shotTimer = setTimeout(() => {
      layer.hidden = true;
      layer.classList.remove('out');
    }, 300);
  };
  layer.onclick = close;
  shotTimer = setTimeout(close, 2200);
}

/** 상태가 바뀐 순간의 알림: 새 숫자, 등수, 내 차례, 게임 끝 */
function announce(a, b) {
  if (!a || a.code !== b.code) return;
  const newCall = b.game && (!a.game || b.game.called.length > a.game.called.length || a.round !== b.round);
  if (newCall && b.game.lastCall) {
    const last = b.game.lastCall;
    if (last.how === 'cannon') {
      // 대포는 빙고판 위 레이어에서 공이 날아온다
      showShot(last, !!b.my?.board?.includes(last.number) && !b.my?.rank);
      buzz([20, 40, 60]);
    } else {
      const ball = $('ball');
      ball.classList.remove('drop');
      void ball.offsetWidth;
      ball.classList.add('drop');
      buzz(25);
    }
  }
  if (b.phase !== 'lobby' && a.round === b.round) {
    for (const p of b.players) {
      const before = a.players.find((q) => q.id === p.id);
      if (p.rank && before && !before.rank && b.phase === 'playing') {
        toast(`${p.name}님 ${p.rank}등! 빙고`, true);
        buzz([40, 60, 40]);
      }
    }
  }
  if (b.game?.turn === b.me && a.game?.turn !== b.me && b.phase === 'playing') buzz(60);
  if (b.phase === 'lobby' && a.phase === 'playing' && a.hostId) toast('다시 하기! 빙고판을 확인하고 준비해 주세요');
  if (a.hostId !== b.hostId && b.hostId === b.me && b.phase === 'lobby') toast('이제 내가 방장이에요');
}

function render() {
  const v = view;
  if (!v) return;
  const size = v.settings.size;
  const isHost = v.hostId === v.me;

  // 규칙 한 줄 + 방장 설정
  const rule = $('room-rule');
  rule.replaceChildren(
    `${size}×${size} 숫자빙고, 1~${v.maxNumber} 숫자, ${callModeName(v.settings.callMode)}. ${v.goal}줄을 먼저 채우면 빙고! `,
  );
  if (isHost && v.phase === 'lobby') {
    rule.append(el('button', { class: 'link', style: 'color:#fff;padding:0 4px', text: '설정 바꾸기', onclick: openSettings }));
  }

  renderPlayers(v);
  renderCaller(v);
  renderBoard(v);
  renderPicker(v);
  renderHistory(v);
  renderActions(v, isHost);
  renderHint(v);

  if (v.phase === 'finished' && shownResultRound !== v.round) {
    shownResultRound = v.round;
    openResult();
  }
  if (v.phase !== 'finished') {
    const d = /** @type {HTMLDialogElement} */ ($('result-dialog'));
    if (d.open) d.close();
  }
}

function renderPlayers(v) {
  const list = $('players');
  const order = v.game ? [...v.game.order, ...v.players.map((p) => p.id).filter((id) => !v.game.order.includes(id))] : v.players.map((p) => p.id);
  list.replaceChildren(
    ...order
      .map((id) => v.players.find((p) => p.id === id))
      .filter(Boolean)
      .map((p) => {
        let dot = '';
        let tag = '';
        if (v.phase === 'lobby') {
          dot = p.ready ? '✓' : '';
          tag = p.ready ? '준비 완료' : '채우는 중';
        } else if (p.left) {
          tag = '나감';
        } else if (p.rank) {
          dot = String(p.rank);
          tag = `${p.rank}등`;
        } else {
          tag = `${p.lines ?? 0}줄`;
        }
        const cls = ['player'];
        if (v.phase === 'lobby' && p.ready) cls.push('ready');
        if (p.rank) cls.push('ranked');
        if (v.game?.turn === p.id && v.phase === 'playing') cls.push('turn');
        if (p.id === v.me) cls.push('me');
        if (!p.connected || p.left) cls.push('off');
        return el(
          'li',
          { class: cls.join(' ') },
          dot ? el('span', { class: 'dot', text: dot }) : null,
          `${p.id === v.hostId ? '👑 ' : ''}${p.name}`,
          el('span', { class: 'tag', text: tag }),
        );
      }),
  );
}

function renderCaller(v) {
  const box = $('caller');
  box.hidden = v.phase === 'lobby';
  if (v.phase === 'lobby' || !v.game) return;
  const g = v.game;
  const last = g.lastCall;
  $('ball-num').textContent = last ? String(last.number) : '?';
  const who = last?.byName ?? '';
  $('caller-who').textContent = !last
    ? '첫 숫자를 기다려요'
    : last.how === 'cannon'
      ? last.auto
        ? `${who}님 시간이 지나 대포가 자동 발사됐어요`
        : `${who}님이 대포를 쐈어요`
      : last.auto
        ? `${who}님 시간이 지나 자동으로 불렀어요`
        : `${who}님이 불렀어요`;
  // 방금 나온 숫자가 내 판에 있는지 바로 알 수 있게
  const onMyBoard = !!last && !!v.my?.board?.includes(last.number);
  const where = $('caller-where');
  where.hidden = !last || v.phase !== 'playing' || !!v.my?.rank;
  where.className = `caller-where ${onMyBoard ? 'yes' : 'no'}`;
  where.textContent = onMyBoard ? '내 판에 있어요' : '내 판에 없어요';

  const turnEl = $('caller-turn');
  const mine = v.phase === 'playing' && g.turn === v.me;
  turnEl.classList.toggle('mine', mine);
  if (v.phase === 'finished') turnEl.textContent = '게임이 끝났어요';
  else if (g.exhausted) turnEl.textContent = '더 나올 숫자가 없어요. 칠하고 빙고를 눌러요';
  else if (mine) turnEl.textContent = v.settings.callMode === 'player' ? '내 차례! 부를 숫자를 빙고판에서 눌러요' : '내 차례! 대포를 쏴요';
  else turnEl.textContent = `${v.players.find((p) => p.id === g.turn)?.name ?? ''}님 차례`;

  $('fire').hidden = !(mine && v.settings.callMode === 'cannon');
  updateTimer();
}

function updateTimer() {
  const v = view;
  const bar = $('timer-bar');
  if (!v || !conn || v.phase !== 'playing' || !v.game?.deadline) {
    bar.style.transform = 'scaleX(0)';
    return;
  }
  const total = v.game.exhausted ? EXHAUSTED_MS : TURN_MS[v.settings.callMode];
  const left = Math.max(0, v.game.deadline - conn.now());
  bar.style.transform = `scaleX(${Math.min(1, left / total)})`;
}

function renderBoard(v) {
  const size = v.settings.size;
  const board = $('board');
  board.className = `board size-${size}`;
  board.style.gridTemplateColumns = `repeat(${size}, 1fr)`;
  const lobby = v.phase === 'lobby';
  const marked = v.my?.marked ?? [];
  const inLine = new Set(lobby ? [] : completedLines(marked, size).flat());
  const called = new Set(v.game?.called ?? []);
  const myTurnToCall = v.phase === 'playing' && v.game?.turn === v.me && v.settings.callMode === 'player';
  // 방금 나온 숫자가 내 판에 있으면 그 칸을 표시 (칠할 때까지)
  const lastNum = v.phase === 'playing' ? v.game?.lastCall?.number : undefined;
  const cells = draft.cells;

  const nodes = cells.map((n, i) => {
    const cls = ['cell'];
    if (!n) cls.push('empty');
    if (lobby && !v.my?.ready && i === draft.selected) cls.push('selected');
    if (!lobby && marked[i]) cls.push('marked');
    if (!lobby && marked[i] && i === stampCell) cls.push('stamp');
    if (inLine.has(i)) cls.push('in-line');
    if (myTurnToCall && n && !called.has(n)) cls.push('callable');
    if (n && n === lastNum && !marked[i]) cls.push('hot');
    return el(
      'button',
      { class: cls.join(' '), 'data-i': i, role: 'gridcell', 'aria-label': n ? `${n}${marked[i] ? ', 칠함' : ''}` : '빈 칸' },
      el('span', { text: n ? String(n) : '' }),
    );
  });
  board.replaceChildren(...nodes);
  stampCell = -1;

  const head = $('card-head');
  if (lobby) {
    const filled = cells.filter((n) => n > 0).length;
    head.replaceChildren(el('span', { text: '내 빙고판' }), el('span', { class: 'count', text: `${filled} / ${cells.length}칸` }));
  } else {
    const lines = completedLines(marked, size).length;
    head.replaceChildren(
      el('span', { text: v.my?.rank ? `${v.my.rank}등 확정` : '내 빙고판' }),
      el('span', { class: `lines${lines >= v.goal ? ' done' : ''}`, text: `${lines} / ${v.goal}줄` }),
    );
  }
}

function onBoardClick(e) {
  const btn = /** @type {HTMLElement} */ (e.target).closest('.cell');
  const v = view;
  if (!btn || !v || !conn) return;
  const i = Number(btn.getAttribute('data-i'));
  if (v.phase === 'lobby') {
    if (v.my?.ready) {
      toast('준비를 취소하면 고칠 수 있어요');
      return;
    }
    draft.selected = i;
    render();
    return;
  }
  if (v.phase !== 'playing' || !v.my?.board) return;
  const n = v.my.board[i];
  if (v.my.marked[i]) return;
  const called = v.game?.called.includes(n);
  if (called) {
    // 바로 칠해 보이고 서버에도 보낸다
    v.my.marked[i] = true;
    stampCell = i;
    buzz(15);
    conn.send({ type: 'mark', cell: i });
    render();
    return;
  }
  if (v.game?.turn === v.me && v.settings.callMode === 'player' && !v.my.rank) {
    conn.send({ type: 'call', number: n });
    return;
  }
  toast('아직 나오지 않은 숫자예요');
}

function renderPicker(v) {
  const wrap = $('picker-wrap');
  wrap.hidden = !(v.phase === 'lobby' && !v.my?.ready);
  if (wrap.hidden) return;
  const used = new Set(draft.cells.filter((n) => n > 0));
  const picks = [];
  for (let n = 1; n <= v.maxNumber; n++) {
    picks.push(el('button', { class: 'pick', 'data-n': n, disabled: used.has(n), text: String(n), 'aria-label': `${n} 넣기` }));
  }
  $('picker').replaceChildren(...picks);
}

function onPick(e) {
  const btn = /** @type {HTMLElement} */ (e.target).closest('.pick');
  if (!btn || !view) return;
  const n = Number(btn.getAttribute('data-n'));
  draft.cells[draft.selected] = n;
  // 다음 빈 칸으로 (뒤쪽 먼저, 없으면 앞쪽)
  const after = draft.cells.findIndex((x, i) => i > draft.selected && x === 0);
  const any = draft.cells.indexOf(0);
  draft.selected = after >= 0 ? after : any >= 0 ? any : draft.selected;
  saveDraft();
  render();
}

function renderHistory(v) {
  const wrap = $('history-wrap');
  wrap.hidden = v.phase === 'lobby' || !v.game;
  if (wrap.hidden) return;
  const called = v.game.called;
  $('history-count').textContent = `${called.length} / ${v.maxNumber}`;
  $('history').replaceChildren(
    ...called.map((n, i) => el('li', { class: i === called.length - 1 ? 'last' : '', text: String(n) })),
  );
}

function renderActions(v, isHost) {
  const bar = $('actions');
  const my = v.my;
  const items = [];
  if (v.phase === 'lobby' && my) {
    if (!my.ready) {
      const full = !checkBoard(draft.cells, v.settings.size);
      items.push(
        el('button', {
          class: 'btn btn-go',
          text: full ? '준비 완료' : `빈 칸 ${draft.cells.filter((n) => !n).length}개`,
          disabled: !full,
          onclick: () => conn?.send({ type: 'ready', board: draft.cells }),
        }),
      );
    } else if (isHost) {
      items.push(el('button', { class: 'btn btn-ghost-light btn-side', text: '준비 취소', onclick: () => conn?.send({ type: 'unready' }) }));
      const seated = v.players.filter((p) => !p.left).length;
      items.push(
        el('button', {
          class: 'btn btn-primary',
          text: seated < 2 ? '2명 이상 모여야 해요' : v.canStart ? '게임 시작' : '준비 기다리는 중',
          disabled: !v.canStart,
          onclick: () => conn?.send({ type: 'start' }),
        }),
      );
    } else {
      items.push(el('button', { class: 'btn btn-ghost-light', text: '준비 취소', onclick: () => conn?.send({ type: 'unready' }) }));
    }
  } else if (v.phase === 'playing' && my) {
    const lines = completedLines(my.marked, v.settings.size).length;
    if (my.rank) {
      items.push(el('button', { class: 'btn btn-bingo', disabled: true, text: `${my.rank}등!` }));
    } else {
      const ok = lines >= v.goal;
      items.push(
        el('button', {
          class: 'btn btn-bingo',
          disabled: !ok,
          text: ok ? '빙고!' : `빙고 ${lines}/${v.goal}`,
          onclick: (e) => {
            /** @type {HTMLButtonElement} */ (e.currentTarget).disabled = true;
            conn?.send({ type: 'bingo' });
          },
        }),
      );
    }
  } else if (v.phase === 'finished') {
    items.push(el('button', { class: 'btn btn-ghost-light btn-side', text: '순위 보기', onclick: openResult }));
    items.push(
      isHost
        ? el('button', { class: 'btn btn-primary', text: '다시 하기', onclick: () => conn?.send({ type: 'rematch' }) })
        : el('button', { class: 'btn btn-ghost-light', disabled: true, text: '방장을 기다리는 중' }),
    );
  }
  bar.replaceChildren(...items);
}

function renderHint(v) {
  let text = '';
  if (v.phase === 'lobby') {
    if (!v.my?.ready) text = `칸을 고르고 아래에서 숫자를 눌러 채워요. 1~${v.maxNumber} 중 겹치지 않게.`;
    else if (v.hostId === v.me) text = '모두 준비 완료하면 게임을 시작할 수 있어요.';
    else text = '준비 완료! 방장이 시작하길 기다려요.';
  } else if (v.phase === 'playing') {
    text = v.my?.rank ? '등수가 정해졌어요. 다른 사람이 끝날 때까지 지켜봐요.' : '숫자가 나오면 내 빙고판에서 직접 눌러 칠해요. 칠하지 않은 칸은 빙고가 아니에요.';
  }
  $('hint').textContent = text;
}

function openSettings() {
  if (!view) return;
  const local = { ...view.settings };
  const form = $('settings-form');
  const draw = () => form.replaceChildren(settingsChoices(local, draw));
  draw();
  const dialog = /** @type {HTMLDialogElement} */ ($('settings-dialog'));
  dialog.onclose = () => {
    if (dialog.returnValue === 'save') conn?.send({ type: 'settings', settings: local });
  };
  dialog.returnValue = '';
  dialog.showModal();
}

function openResult() {
  const v = view;
  if (!v) return;
  const ranked = [...v.players].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  $('result').replaceChildren(
    ...ranked.map((p) =>
      el(
        'li',
        { class: p.id === v.me ? 'me' : '' },
        el('span', { class: 'rank', text: p.rank ? `${p.rank}등` : '기권' }),
        p.name,
        el('span', { class: 'sub', text: p.lines != null ? `${p.lines}줄` : '' }),
      ),
    ),
  );
  const isHost = v.hostId === v.me;
  const dialog = /** @type {HTMLDialogElement} */ ($('result-dialog'));
  $('result-actions').replaceChildren(
    ...[
    el('button', { class: 'btn btn-ghost', text: '닫기', onclick: () => dialog.close() }),
    isHost
      ? el('button', {
          class: 'btn btn-primary',
          text: '다시 하기',
          onclick: () => {
            dialog.close();
            conn?.send({ type: 'rematch' });
          },
        })
      : null,
    ].filter((x) => x !== null),
  );
  if (!dialog.open) dialog.showModal();
}

/** 휴대폰·태블릿 (iPadOS는 PC처럼 보이므로 터치 지원으로 구분) */
function isMobile() {
  const uad = /** @type {any} */ (navigator).userAgentData;
  if (uad && typeof uad.mobile === 'boolean' && uad.mobile) return true;
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true;
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

/** 클립보드에 복사. 안 되는 브라우저는 예전 방식으로. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

/** 초대하기: 모바일은 공유 창(카톡 등), PC는 문구+링크 복사 */
async function invite() {
  if (!view) return;
  const url = `${location.origin}${location.pathname}?room=${view.code}`;
  const message = `오늘도 빙고 같이 해요!\n방 코드: ${view.code}\n${url}`;
  if (isMobile() && navigator.share) {
    try {
      // 링크를 문구 안에 넣어 보낸다 (앱마다 url 칸을 따로 버리는 경우가 있어서)
      await navigator.share({ title: '오늘도 빙고', text: message });
      return;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      // 공유가 안 되면 복사로
    }
  }
  if (await copyText(message)) toast('초대 문구와 링크를 복사했어요');
  else toast(`방 코드: ${view.code}`);
}

function initRoom() {
  $('board').addEventListener('click', onBoardClick);
  $('picker').addEventListener('click', onPick);
  $('fire').addEventListener('click', () => conn?.send({ type: 'fire' }));
  $('invite').addEventListener('click', invite);
  $('fill-random').addEventListener('click', () => {
    if (!view) return;
    draft.cells = fillRandom(draft.cells, view.settings.size);
    saveDraft();
    render();
  });
  $('clear-cell').addEventListener('click', () => {
    draft.cells[draft.selected] = 0;
    saveDraft();
    render();
  });
  $('clear-all').addEventListener('click', () => {
    draft.cells = draft.cells.map(() => 0);
    draft.selected = 0;
    saveDraft();
    render();
  });
  $('room-leave').addEventListener('click', () => {
    if (view?.phase === 'playing' && view.my && !view.my.rank && !confirm('게임 중에 나가면 기권이에요. 나갈까요?')) return;
    exitRoom(true);
  });
}

initRoom();
initHome();

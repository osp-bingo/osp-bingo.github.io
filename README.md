# 오늘도 빙고

친구들과 방 코드로 모여서 하는 온라인 빙고. 혼자 하기 없이 같이 하기만 있고, 로그인 없이 닉네임만 씁니다.

- 웹: https://today-bingo.ohsangplay.com (GitHub Pages, `web/`, 빌드 과정 없음)
- 게임 서버: Cloudflare Workers + Durable Objects (`worker/`), 주소 `https://api.ohsangplay.com/bingo`

## 규칙

- 닉네임: 한글·영문·숫자 2~10자. 한 방에 같은 닉네임은 안 됨
- 방장이 방을 만들 때 고름 (대기실에서 바꿀 수 있음)
  - 빙고 종류: **숫자빙고** (주제빙고는 준비 중)
  - 판 크기: 3×3(1~15), 5×5(1~35), 7×7(1~63), 9×9(1~99)
  - 숫자 부르는 방식: **직접 부르기** / **대포**
- 2~8명. 각자 빙고판을 겹치지 않는 숫자로 다 채우고 **준비 완료** → 모두 준비되면 방장이 **게임 시작**
- 판 크기를 바꾸면 모두의 빙고판이 지워지고 준비가 풀림
- 차례는 시작할 때 무작위
  - 직접 부르기: 내 차례에 내 빙고판에서 아직 안 나온 숫자를 누르면 부름. 부른 사람의 칸은 자동으로 칠해짐 (30초)
  - 대포: 내 차례에 대포를 쏘면 아직 안 나온 숫자가 무작위로 나옴. 아무도 자동으로 칠해지지 않음 (15초)
  - 차례 시간이 지나도 그냥 넘어가지 않음: 대포는 자동 발사, 직접 부르기는 그 사람 빙고판에서 아직 안 나온 숫자를 무작위로 불러 줌 (그 칸은 자동으로 칠해짐). 연결이 끊긴 사람의 차례는 8초만 기다림
- 나온 숫자는 각자 직접 눌러 칠함. 안 나온 숫자는 칠할 수 없고, 칠하지 않은 칸은 빙고로 치지 않음
- 판 크기만큼 줄(가로·세로·대각선)을 완성하면 **빙고** 버튼이 켜짐 (준비 완료 버튼 자리). 서버에 먼저 도착한 순서대로 등수
- 꼴찌가 나올 때까지 계속. 등수가 정해진 사람과 부를 숫자가 남지 않은 사람은 차례를 건너뜀
- 더 나올 숫자가 없으면 60초 동안 빙고를 기다린 뒤, 남은 사람은 칠한 줄 수로 등수 (같으면 공동)
- 게임 중 나가기 = 기권 (등수 없음). 남은 사람이 한 명이면 그 사람이 꼴찌로 끝남
- 관전: 대기실에서 **관전하기**/**참여하기**로 오감 (관전하면 준비가 풀림). 게임 중에 들어오거나 참여 자리(8명)가 꽉 차면 관전으로 들어옴 (관전은 30명까지). 관전자는 게임 중 모든 사람의 빙고판을 봄. 게임 중 오래(90초) 끊긴 관전자는 정리
- 끝나면 방장이 **다시 하기** → 같은 방 대기실로 (빙고판은 남고 준비만 풀림)
- 새로고침하거나 연결이 끊겨도 같은 자리로 다시 들어감. 대기실에서 90초 넘게 끊겨 있으면 자리가 빠짐
- 다른 사람의 빙고판 숫자는 서버가 보내지 않음 (줄 수만 보임)

| API | 설명 |
| --- | --- |
| `POST /api/rooms` | `{kind: "number", size: 3\|5\|7\|9, callMode: "player"\|"cannon"}` → `{code}` |
| `GET /api/rooms/{code}/ws?name=닉네임[&playerId=…]` | 방 WebSocket. 서버 → `welcome`, `state`, `error` / 웹 → `settings`, `ready`, `unready`, `spectate`, `play`, `start`, `call`, `fire`, `mark`, `bingo`, `rematch`, `leave` |
| `GET /api/health` | 상태 확인 |

## 구조

```
web/
  index.html
  css/style.css
  js/rules.js     # 판 크기·숫자 범위·줄 계산·닉네임 검사 (웹과 서버가 함께 씀)
  js/net.js       # 서버 연결·재접속
  js/app.js       # 화면
  js/config.js    # 서버 주소 (배포 때 자동으로 채워짐)
worker/
  src/game.ts     # 방 규칙 (순수 로직)
  src/room.ts     # Durable Object: 연결·저장·차례 타이머
  src/index.ts    # 라우팅, CORS
  test/           # vitest
```

## 처음 한 번 설정

1. 저장소 **Settings → Pages → Build and deployment → Source**를 **GitHub Actions**로
2. **Settings → Secrets and variables → Actions**에 시크릿 추가 (야추와 같은 Cloudflare 계정·토큰을 써도 됨)
   - `CLOUDFLARE_API_TOKEN`: **Edit Cloudflare Workers** 템플릿 토큰 (ohsangplay.com 영역 Workers 경로 권한 포함)
   - `CLOUDFLARE_ACCOUNT_ID`
3. `main`에 푸시하거나 **Actions → CI & Deploy → Run workflow**

Worker 이름은 `bingo-api`, 경로는 `api.ohsangplay.com/bingo/*` 라서 야추(`/yahchoo`)·4S 챌린지와 겹치지 않습니다. 데이터베이스(D1)는 쓰지 않습니다.
배포할 때 이 저장소의 `https://<계정>.github.io` 주소는 자동으로 허용됩니다. 다른 웹 주소를 쓰면 `worker/wrangler.toml`의 `ALLOWED_ORIGINS`에 추가하세요.

### 도메인 (선택)

웹 주소는 `https://today-bingo.ohsangplay.com` (Cloudflare DNS `CNAME today-bingo → osp-bingo.github.io`, 저장소 Settings → Pages → Custom domain). 이 주소는 `ALLOWED_ORIGINS`에 들어 있습니다.

## 로컬 실행

```bash
cd worker && npm install
npm run dev        # 서버: http://127.0.0.1:8787
npm test

# 다른 터미널
cd web && python3 -m http.server 5173
# http://localhost:5173 (localhost에서는 자동으로 로컬 서버에 연결). 창을 여러 개 열어 같이 하기 확인
```

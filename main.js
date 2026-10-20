const { app, BrowserWindow, ipcMain, Menu, screen, shell } = require('electron');
const fs = require('fs');
const { execFile } = require('child_process');
const os = require('os');
const path = require('path');
const { Sessions } = require('./sessions');
const { Limits } = require('./limits');
const { startServer } = require('./server');
const { fetchUsage } = require('./usage-api');
const loginRefresh = require('./login-refresh');
const geom = require('./mini-geom');
const { findDesktopInfo } = require('./session-names');
const profileMod = require('./profile');
const { readNodeBin } = require('./nodebin');

// 프로필: 포트/데이터 폴더/설정 폴더/키체인 항목/앱 이름 (profile.js)
const profile = profileMod.get();
if (profile.userDataName) app.setPath('userData', path.join(app.getPath('appData'), profile.userDataName)); // 단일 실행 잠금을 계정별로 분리

const PORT = profile.port;
const DEBUG = !!process.env.CLAUDE_PET_DEBUG;
const DATA_DIR = profile.dataDir;
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const LIMITS_FILE = path.join(DATA_DIR, 'limits.json');
const DEBUG_LOG = path.join(DATA_DIR, 'events.log');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const USAGE_STATUS_FILE = path.join(DATA_DIR, 'usage-status.json'); // 마지막 사용량 조회 결과 (진단용, 토큰은 안 담음)

// 창 세로 구성: [위 170: 말풍선 자리] [가운데 170: 펫 + 사용량 막대] [아래 170: 위쪽 끝에서 말풍선이 내려오는 자리]
// 펫은 항상 가운데 칸에 고정돼 있고, 말풍선만 위/아래 칸을 오간다. 빈 칸은 투명해서 클릭이 통과한다.
const W = 260;
const TOP = 170;
const MID = 105;
const BOT = 170;
const H = TOP + MID + BOT;
const PET_TOP = TOP + 3; // 창 안에서 펫 머리가 있는 대략의 높이
const PET_L = 100; // 창 안에서 펫이 차지하는 가로 범위 (펫 폭 60, 창 가운데)
const PET_R = 160;

let win = null;
let lastStatusJson = '';
const fetchOnce = () => fetchUsage({ service: profile.credService, configDir: profile.configDir }); // 사용량 한 번 조회
const usageActiveMs = () => API_POLL_ACTIVE_MS; // 작업 중 조회 간격
const canRefreshLogin = () => true; // 만료되면 로그인 갱신을 시도할 수 있는 방식인지
const sessions = new Sessions(Date.now, { readDesktopInfo: (id) => findDesktopInfo(id, profile.appSupportRoot) });
const limits = new Limits(LIMITS_FILE);

// ---- 로그인 정보로 사용량 조회 (데스크톱 앱은 상태줄 신호가 없어서) ----
// 기본 켜짐. 우클릭 메뉴에서 끄거나 CLAUDE_PET_NO_API=1 로 끌 수 있다.
// 조회 간격: 작업 중이면 자주(거의 실시간), 쉬는 중이면 드물게. 사용량은 작업할 때만 변한다.
const API_POLL_ACTIVE_MS = 15 * 1000;
const API_POLL_IDLE_MS = 3 * 60 * 1000;
const API_MIN_GAP_MS = 5 * 1000; // 이벤트가 몰려도 이보다 자주는 조회하지 않는다
let apiEnabled = !process.env.CLAUDE_PET_NO_API && readJson(SETTINGS_FILE, {}).apiUsage !== false;
let apiBusy = false;
let apiRetryAt = 0;
let apiLastAt = 0;
let usageTimer = null;
// 로그인이 만료되면 `claude` 로 짧은 요청을 한 번 보내 스스로 갱신하게 한다 (우클릭 메뉴에서 끌 수 있다)
let autoRefresh = readJson(SETTINGS_FILE, {}).autoRefreshLogin === true; // 배포판은 기본 꺼짐: 내가 켜기 전에는 요청을 보내지 않는다
let lastRefreshAt = 0;
const REFRESH_COOLDOWN_MS = 30 * 60 * 1000;
limits.apiOn = apiEnabled;

async function pollUsage() {
  if (!apiEnabled || apiBusy || Date.now() < apiRetryAt || limits.statuslineFresh()) return;
  if (Date.now() - apiLastAt < API_MIN_GAP_MS) return;
  apiLastAt = Date.now();
  apiBusy = true;
  try {
    // 예상 못 한 오류나 응답 없음으로 "조회 중…"에 영원히 멈추지 않게, 오류로 잡고 30초 안에 끝낸다.
    const attempt = async () => {
      try {
        return await Promise.race([fetchOnce(), new Promise((resolve) => setTimeout(() => resolve({ error: 'timeout' }), 30000))]);
      } catch (e) {
        return { error: 'crash', message: String((e && e.message) || e).slice(0, 200) };
      }
    };
    let r = await attempt();
    let refreshed = null;
    if (r.error === 'expired' && canRefreshLogin() && autoRefresh && Date.now() - lastRefreshAt > REFRESH_COOLDOWN_MS) {
      lastRefreshAt = Date.now();
      limits.setApiError('refreshing');
      pushStatus();
      refreshed = await loginRefresh.refreshLogin(readNodeBin(), undefined, { dir: path.join(DATA_DIR, 'refresh'), configDir: profile.refreshConfigDir });
      if (refreshed) r = await attempt(); // 갱신됐으면 바로 다시 조회
    }
    writeJson(USAGE_STATUS_FILE, { at: new Date().toISOString(), ok: !r.error, error: r.error || null, status: r.status || null, message: r.message || null, loginRefresh: refreshed });
    if (r.error) {
      limits.setApiError(r.error);
      // 로그인 정보가 없거나 만료면 자주 물을 필요가 없다 (키체인 창이 반복해서 뜨는 것도 방지)
      // 너무 자주 물어서 거절당했으면(429) 잠깐만 쉬고, 로그인 문제면 오래 쉰다.
      const wait = r.status === 429 ? 60 * 1000 : r.error === 'nocred' || r.error === 'expired' ? 10 * 60 * 1000 : 5 * 60 * 1000;
      apiRetryAt = Date.now() + wait;
      debugLog('usage-error', { error: r.error, status: r.status });
    } else {
      limits.updateFromApi(r);
    }
    pushStatus();
  } finally {
    apiBusy = false;
  }
}

// 사용량 조회를 돌리는 반복: 한 번 조회하고, 지금 작업 중이면 15초 뒤, 아니면 3분 뒤에 다시 한다.
function loopUsage() {
  clearTimeout(usageTimer);
  pollUsage();
  const working = sessions.derive().active > 0;
  // 웹 세션 조회는 서버에 조금 더 부담이라 작업 중이어도 30초 간격으로 한다
  usageTimer = setTimeout(loopUsage, working ? usageActiveMs() : API_POLL_IDLE_MS);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(file, obj) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  } catch {
    /* ignore */
  }
}
function debugLog(kind, obj) {
  if (!DEBUG) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(DEBUG_LOG, JSON.stringify({ t: new Date().toISOString(), kind, ...obj }) + '\n');
  } catch {
    /* ignore */
  }
}

// 방해 금지: 켜면 Claude 이벤트를 무시하고 잠든 모습만 보여준다
let dnd = !!readJson(SETTINGS_FILE, {}).dnd;
sessions.setMuted(dnd);
const updateState = 'idle';

// 미니 모드: 화면 오른쪽 끝에 숨어 있다가 마우스를 올리면 살짝 튀어나온다
const mini = { on: !!readJson(SETTINGS_FILE, {}).mini, peek: false, side: ['left', 'right', 'top', 'bottom'].includes(readJson(SETTINGS_FILE, {}).miniSide) ? readJson(SETTINGS_FILE, {}).miniSide : 'right' };
function saveSetting(patch) {
  writeJson(SETTINGS_FILE, { ...readJson(SETTINGS_FILE, {}), ...patch });
}

// ---- 허용 요청 알림 ----
// 확인(허용)이 필요한 요청이 생기면: ① 말풍선이 눈에 띄는 알림 카드로 바뀌고 ② 숨김 모드면 튀어나오고
// ③ 30초가 넘도록 응답이 없으면 마우스 커서 옆을 따라다니는 작은 알림이 뜬다. 허용하면 모두 사라진다.
const FOLLOW_AFTER_MS = 30 * 1000;
const FOLLOWER_W = 240;
const FOLLOWER_H = 44;
let follower = null;
let followerTimer = null;
let followerText = '';
let forcedPeek = false;

function ensureFollower() {
  if (follower && !follower.isDestroyed()) return follower;
  follower = new BrowserWindow({
    width: FOLLOWER_W,
    height: FOLLOWER_H,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    show: false,
    enableLargerThanScreen: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  follower.setAlwaysOnTop(true, 'screen-saver'); // 전체 화면 앱 위에도 보이게
  follower.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  follower.setIgnoreMouseEvents(true); // 클릭은 그대로 아래 창으로 통과
  followerText = '';
  return follower;
}

function moveFollower() {
  if (!follower || follower.isDestroyed()) return;
  const c = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(c).workArea;
  // 펫이 여러 개일 때 알림이 겹치지 않게 프로필마다 위치를 달리한다. 화면 가장자리에서는 반대편으로 넘긴다.
  const dy = profile.followerOffset;
  let x = c.x + 18;
  let y = c.y + 22 + dy;
  if (x + FOLLOWER_W > area.x + area.width) x = c.x - 18 - FOLLOWER_W;
  if (y + FOLLOWER_H > area.y + area.height) y = c.y - 22 - FOLLOWER_H - dy;
  follower.setPosition(Math.round(x), Math.round(y), false);
}

function showFollower(text) {
  const w = ensureFollower();
  if (followerText !== text) {
    followerText = text;
    w.loadFile(path.join(__dirname, 'follower.html'), { query: { t: text } });
  }
  moveFollower();
  if (!w.isVisible()) w.showInactive();
  if (!followerTimer) followerTimer = setInterval(moveFollower, 16); // 마우스를 부드럽게 따라다닌다
}

function hideFollower() {
  if (followerTimer) {
    clearInterval(followerTimer);
    followerTimer = null;
  }
  if (follower && !follower.isDestroyed() && follower.isVisible()) follower.hide();
}

function updateAttention() {
  const st = sessions.derive();
  const waiting = st.state === 'waiting' && !dnd;
  // 숨김 모드: 확인이 필요하면 튀어나와서 알리고, 끝나면 다시 숨는다
  if (mini.on) {
    if (waiting && !forcedPeek) {
      forcedPeek = true;
      setPeek(true);
    } else if (!waiting && forcedPeek) {
      forcedPeek = false;
      setPeek(false);
    }
  } else forcedPeek = false;
  // 30초 넘게 응답이 없으면 마우스를 따라다니는 알림
  if (waiting && st.waitSince && Date.now() - st.waitSince >= FOLLOW_AFTER_MS) {
    const n = st.waitCount > 1 ? `${st.waitCount}건 ` : '';
    showFollower(`${profile.label ? profile.label + ' · ' : ''}${n}허용 필요 ✋`);
  } else hideFollower();
}


// ---- 상태 푸시 (펫 상태 + 한도 막대) ----
function currentStatus() {
  return { ...sessions.derive(), profile: profile.name, update: updateState, limits: limits.get(), mini: mini.on ? (mini.peek ? 'peek' : 'hidden') : 'off', miniSide: mini.side, dnd };
}

function pushStatus(force = false) {
  const s = currentStatus();
  const json = JSON.stringify(s);
  if (!force && json === lastStatusJson) return;
  lastStatusJson = json;
  if (win && !win.isDestroyed()) win.webContents.send('status', s);
}

// ---- 창 ----
// bottom = 펫이 있는 가운데 칸의 아래쪽 y (창의 아래쪽 y 가 아님)
function onScreen(x, bottom) {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return x + W / 2 >= a.x && x + W / 2 <= a.x + a.width && bottom - 20 >= a.y && bottom - 20 <= a.y + a.height;
  });
}

function defaultPos() {
  const a = screen.getPrimaryDisplay().workArea;
  // 펫이 여러 개일 때 프로필마다 조금씩 옆으로 놓는다
  const side = profile.defaultPosOffset;
  return { x: a.x + a.width - W - 24 - side, y: a.y + a.height - 24 - (TOP + MID) };
}

function savePos() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  writeJson(STATE_FILE, { x: b.x, bottom: b.y + TOP + MID });
}

function createWindow() {
  const saved = readJson(STATE_FILE, {});
  let { x, y } = defaultPos();
  if (mini.on && Number.isFinite(saved.bottom)) {
    // 미니 모드로 종료했다면 마지막 높이를 유지한 채 가장자리에 숨는다.
    const sx = Number.isFinite(saved.x) ? saved.x : x;
    const sy = saved.bottom - (TOP + MID);
    const displays = screen.getAllDisplays();
    const d = geom.nearestDisplay(displays, sx + W / 2, sy + TOP + MID / 2);
    // 예전 버전에서 저장한 "오른쪽 끝" 같은 설정이 지금은 이음새일 수 있다. 바깥쪽이 아니면 가까운 바깥쪽으로 옮기고, 없으면 미니 모드를 끈다.
    if (!geom.edgeFree(displays, d, mini.side)) {
      const alt = geom.pickSide(displays, d, sx + W / 2, sy + 200);
      if (alt) mini.side = alt;
      else mini.on = false;
    }
    if (mini.on) ({ x, y } = geom.target(d, mini.side, 'hidden', { x: sx, y: sy }));
    else {
      x = sx;
      y = sy;
    }
  } else if (Number.isFinite(saved.x) && Number.isFinite(saved.bottom) && onScreen(saved.x, saved.bottom)) {
    x = saved.x;
    y = saved.bottom - (TOP + MID);
  }

  win = new BrowserWindow({
    x,
    y,
    width: W,
    height: H,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    enableLargerThanScreen: true, // 맥이 창을 메뉴바 위로 못 올리게 막는 걸 푼다 (펫을 화면 맨 위까지 올리려고)
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    focusable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => win.showInactive());
  win.on('closed', () => {
    win = null;
  });
}

// ---- IPC ----
ipcMain.on('ready', () => pushStatus(true));

ipcMain.on('drag', (_e, dx, dy) => {
  if (!win || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
  lastDragAt = Date.now();
  const b = win.getBounds();
  const nx = b.x + Math.round(dx);
  let ny = b.y + Math.round(dy);
  // 펫 머리가 메뉴바(작업 영역) 위로는 넘어가지 않게 한다. 투명한 위쪽 칸은 화면 밖으로 나가도 괜찮다.
  const d = screen.getDisplayNearestPoint({ x: nx + W / 2, y: ny + TOP + MID / 2 });
  ny = Math.max(ny, d.workArea.y - PET_TOP);
  win.setBounds({ x: nx, y: ny, width: b.width, height: b.height });
});

// ---- 미니 모드 ----
let slideTimer = null;
let lastDragAt = 0;
let lastOverAt = 0;

// 창이 있는 모니터 (창 가운데 기준. 숨어서 화면 밖에 걸쳐 있어도 가장 가까운 모니터로 본다)
function displayOf(b) {
  return geom.nearestDisplay(screen.getAllDisplays(), b.x + W / 2, b.y + TOP + MID / 2);
}

// 창을 목표 위치({x, y})로 부드럽게 미끄러뜨린다
function slideTo(to) {
  if (!win) return;
  clearInterval(slideTimer);
  const from = win.getBounds();
  let i = 0;
  slideTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return clearInterval(slideTimer);
    i++;
    const e = 1 - Math.pow(1 - i / 8, 3);
    win.setBounds({ x: Math.round(from.x + (to.x - from.x) * e), y: Math.round(from.y + (to.y - from.y) * e), width: W, height: H });
    if (i >= 8) clearInterval(slideTimer);
  }, 16);
}

// 펫 가운데 좌표 (창 위치 기준)
const petCenter = (b) => ({ cx: b.x + W / 2, cy: b.y + geom.CENTER_Y });

function enterMini(side) {
  if (!win) return;
  const b = win.getBounds();
  const d = displayOf(b);
  // 다른 모니터와 붙어 있는 이음새로는 숨지 않는다 (옆 모니터에 펫이 비쳐 보이므로). 가장 가까운 바깥쪽 가장자리를 쓴다.
  if (!side) {
    const { cx, cy } = petCenter(b);
    side = geom.pickSide(screen.getAllDisplays(), d, cx, cy);
  }
  if (!side) return;
  mini.on = true;
  mini.peek = false;
  mini.side = side;
  saveSetting({ mini: true, miniSide: side });
  // 모니터 배치와 어느 쪽이 바깥쪽으로 판정됐는지 남겨 둔다 (숨는 위치가 이상할 때 확인용)
  const all = screen.getAllDisplays();
  writeJson(path.join(DATA_DIR, 'last-mini.json'), {
    side,
    display: d.id,
    displays: all.map((o) => ({ id: o.id, bounds: o.bounds, workArea: o.workArea, free: geom.SIDES.filter((s) => geom.edgeFree(all, o, s)) })),
  });
  slideTo(geom.target(d, side, 'hidden', b));
  savePos();
  pushStatus(true);
}

function exitMini(moveBack) {
  const side = mini.side;
  mini.on = false;
  mini.peek = false;
  saveSetting({ mini: false });
  if (moveBack && win) {
    const b = win.getBounds();
    slideTo(geom.target(displayOf(b), side, 'rest', b));
  }
  pushStatus(true);
}

function setPeek(v) {
  if (!win || !mini.on || mini.peek === v) return;
  mini.peek = v;
  const b = win.getBounds();
  slideTo(geom.target(displayOf(b), mini.side, v ? 'peek' : 'hidden', b));
  pushStatus(true);
}

ipcMain.on('drag-end', () => {
  lastDragAt = 0;
  if (!win) return;
  const b = win.getBounds();
  const { cx, cy } = petCenter(b);
  // 펫이 바깥쪽 가장자리에 닿으면 미니 모드로, 멀어지면 미니 모드 해제
  const side = geom.sideNear(screen.getAllDisplays(), displayOf(b), cx, cy);
  if (side) enterMini(side);
  else if (mini.on) exitMini(false);
  else savePos();
});

// 마우스 위치 추적: 시선(눈이 커서를 따라감), 잠든 펫 깨우기, 미니 모드 hover 에 쓴다.
let lastCursor = { x: -9999, y: -9999 };
function pollCursor() {
  if (!win || win.isDestroyed()) return;
  const c = screen.getCursorScreenPoint();
  const b = win.getBounds();
  if (mini.on && Date.now() - lastDragAt > 500) {
    const over = geom.overPet(displayOf(b), b, c);
    if (over) {
      lastOverAt = Date.now();
      setPeek(true);
    } else if (mini.peek && !forcedPeek && Date.now() - lastOverAt > 700) setPeek(false);
  }
  if (Math.abs(c.x - lastCursor.x) + Math.abs(c.y - lastCursor.y) < 3) return;
  lastCursor = c;
  win.webContents.send('cursor', { dx: Math.round(c.x - (b.x + W / 2)), dy: Math.round(c.y - (b.y + TOP + 30)) });
}

ipcMain.on('set-ignore', (_e, v) => {
  if (!win) return;
  if (v) win.setIgnoreMouseEvents(true, { forward: true });
  else win.setIgnoreMouseEvents(false);
});

// 말풍선을 누르면 그 세션을 Claude 앱에서 연다.
// claude://code/continue?session=<local_ID> 는 공식 문서에는 없는 링크지만 시험에서 동작했다.
// ID 가 없거나 형식이 다르면 앱만 앞으로 가져온다.
ipcMain.on('open-app', (_e, id) => {
  if (process.platform === 'win32') {
    // 윈도우: claude:// 는 Claude 데스크톱 앱이 등록한 링크라 기본 연결 프로그램에 맡긴다
    const url = typeof id === 'string' && /^local_[0-9a-f-]{36}$/.test(id) ? `claude://code/continue?session=${id}` : 'claude://';
    shell.openExternal(url).catch(() => {});
    return;
  }
  const open = (args, onFail) => execFile('/usr/bin/open', args, (err) => err && onFail && onFail());
  // 앱 이름을 직접 지정해서 링크를 그 앱에 넘긴다
  const fallback = () => open(['-a', profile.appName], () => open(['claude://']));
  if (typeof id === 'string' && /^local_[0-9a-f-]{36}$/.test(id)) {
    open(['-a', profile.appName, `claude://code/continue?session=${id}`], fallback);
  } else {
    fallback();
  }
});

ipcMain.on('menu', () => {
  if (!win) return;
  const items = [
    ...(profile.label ? [{ label: `${profile.label} 계정 펫`, enabled: false }, { type: 'separator' }] : []),
    {
      label: '위치 초기화',
      click: () => {
        const p = defaultPos();
        win.setBounds({ x: p.x, y: p.y, width: W, height: H });
        savePos();
      },
    },
  ];
  // 로그인 항목은 .app으로 설치했을 때만 의미가 있다 (npm start 개발 실행에서는 숨김)
  if (app.isPackaged && profile.primary) {
    items.push({
      label: '로그인 시 자동 실행',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (mi) => app.setLoginItemSettings({ openAtLogin: mi.checked }),
    });
  }
  items.push({
    label: '미니 모드 (가까운 화면 끝에 숨기)',
    type: 'checkbox',
    checked: mini.on,
    click: (mi) => (mi.checked ? enterMini() : exitMini(true)),
  });
  items.push({
    label: '방해 금지 (잠들기)',
    type: 'checkbox',
    checked: dnd,
    click: (mi) => {
      dnd = mi.checked;
      sessions.setMuted(dnd);
      saveSetting({ dnd });
      pushStatus(true);
    },
  });
  items.push({
    label: '로그인 만료 시 자동 갱신',
    type: 'checkbox',
    checked: autoRefresh,
    click: (mi) => {
      autoRefresh = mi.checked;
      saveSetting({ autoRefreshLogin: autoRefresh });
      lastRefreshAt = 0;
    },
  });
items.push({ label: `버전 ${app.getVersion()}`, enabled: false });
  items.push({
    label: '로그인 정보로 사용량 조회',
    type: 'checkbox',
    checked: apiEnabled,
    click: (mi) => {
      apiEnabled = mi.checked;
      limits.apiOn = apiEnabled;
      writeJson(SETTINGS_FILE, { ...readJson(SETTINGS_FILE, {}), apiUsage: apiEnabled });
      apiRetryAt = 0;
      pollUsage();
      pushStatus(true);
    },
  });
  items.push({ type: 'separator' }, { label: '종료', role: 'quit' });
  Menu.buildFromTemplate(items).popup({ window: win });
});

// ---- 앱 ----
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    if (process.platform === 'darwin' && app.dock) app.dock.hide();

    const server = startServer(PORT, {
      onEvent: (evt) => {
        debugLog('event', { evt });
        if (evt && loginRefresh.isRefreshCwd(evt.cwd)) return; // 로그인 갱신용 요청은 펫이 반응하지 않는다
        sessions.handle(evt);
        pushStatus();
        // 새 질문을 보내면 곧바로 조회를 빠른 주기로 바꾸고, 작업이 끝나면 최종 값을 한 번 더 가져온다.
        if (evt && evt.hook_event_name === 'UserPromptSubmit') loopUsage();
        if (evt && evt.hook_event_name === 'Stop') setTimeout(pollUsage, 1500);
        // Stop 직후엔 답변이 대화 기록에 아직 없을 수 있어서 잠시 뒤 다시 확인한다.
        if (evt && evt.hook_event_name === 'Stop') {
          for (const ms of [800, 2500]) setTimeout(() => sessions.refreshLate(evt.session_id || 'default') && pushStatus(), ms);
        }
      },
      onStatusline: (j) => {
        debugLog('statusline', { rate_limits: j && j.rate_limits });
        if (limits.update(j)) pushStatus();
      },
      getStatus: () => ({ ...currentStatus(), diag: sessions.diag }),
      onQuit: () => app.quit(),
    });
    server.on('error', (err) => {
      console.error(`[claude-pet] 포트 ${PORT} 서버 시작 실패:`, err.message);
    });

    createWindow();
    setInterval(() => pushStatus(), 3000); // 타임아웃/리셋 시각 반영
    setInterval(pollCursor, 50);
    setInterval(updateAttention, 1000);
    setTimeout(loopUsage, 2000);
  });

  app.on('window-all-closed', () => app.quit());
}

#!/usr/bin/env node
// Claude Code 설정(~/.claude/settings.json)에 펫 위젯용 훅 + 상태줄 브릿지를 추가/제거한다.
//   node install-hooks.js                  설치 (훅 + 상태줄)
//   node install-hooks.js --no-statusline  훅만 설치 (사용량 막대는 안 채워져요)
//   node install-hooks.js --uninstall      제거 (원래 상태줄도 복구)
//   node install-hooks.js --dry-run        변경 내용만 출력
//   node install-hooks.js --extra-hooks    추가 애니메이션 훅을 버전 확인 없이 설치 / --no-extra-hooks 로 제외
// 설치 전 settings.json을 백업하고, 여러 번 실행해도 중복되지 않는다.
const fs = require('fs');
const os = require('os');
const path = require('path');

const profileMod = require('./profile');
const profile = profileMod.get(profileMod.nameFrom(process.argv.slice(2), process.env));
const PORT = profile.port;
const HOOK_MARKER = '# claude-pet';
const HOOK_CMD =
  `curl -s -m 1 -X POST -H 'Content-Type: application/json' --data-binary @- ` +
  `http://127.0.0.1:${PORT}/event >/dev/null 2>&1 || true ${HOOK_MARKER}`;

const WIN = process.platform === 'win32';
// 훅/상태줄 명령은 셸(윈도우에서는 Git Bash)이 읽으니 경로는 슬래시(/)로 쓴다. 역슬래시는 셸에서 깨질 수 있다.
const sh = (p) => p.replace(/\\/g, '/');

// SessionStart 때 펫이 꺼져 있으면(연결 실패) 앱을 자동으로 켠다.
//  - /clear, 컴팩트로 다시 시작되는 경우는 제외 (펫을 일부러 끈 사람을 귀찮게 하지 않으려고)
//  - 앱이 안 깔려 있으면 조용히 실패한다 (npm start로 쓰는 경우)
//  - 켜는 동안 Claude Code 시작을 막지 않도록 백그라운드에서 처리한다
//  - 맥은 `open -a`, 윈도우는 설치 위치(build-app.js 가 정함)의 exe 를 PowerShell 로 켠다
const WIN_EXE = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Claude Pet', 'Claude Pet.exe');
const LAUNCH = WIN
  ? `[ -f "${sh(WIN_EXE)}" ] && powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath '${sh(WIN_EXE).replace(/'/g, "''")}'"`
  : `open -g ${profile.openFlags}-a "Claude Pet"${profile.launchArgs.length ? ' --args ' + profile.launchArgs.join(' ') : ''}`;
const POST = `curl -s -m 1 -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:${PORT}/event >/dev/null 2>&1`;
const SESSION_START_CMD =
  `P=$(cat); post() { printf '%s' "$P" | ${POST}; }; ` +
  `post || { printf '%s' "$P" | grep -Eq '"source" *: *"(clear|compact)"' || ` +
  `{ ( ${LAUNCH}; sleep 3; post ) >/dev/null 2>&1 & } ; }; true ${HOOK_MARKER}`;

// 애니메이션을 더 정확하게 하려는 추가 훅 (오류, 서브에이전트, 대화 정리).
// Claude Code 가 모르는 훅 이름이 설정에 있으면 설정 검증이 실패할 수 있어서,
// 버전을 확인할 수 있고 충분히 최신일 때만 넣는다. (--extra-hooks 로 강제, --no-extra-hooks 로 제외)
const EXTRA = [
  { name: 'PostToolUseFailure', matcher: '*' },
  { name: 'SubagentStart' },
  { name: 'SubagentStop' },
  { name: 'PreCompact' },
  { name: 'PermissionRequest', matcher: '*' }, // 허용 요청 화면이 뜨는 순간을 정확히 알려 준다 (아무것도 돌려주지 않으니 허용/거부에는 영향 없음)
];
const MIN_EXTRA_VERSION = [2, 1, 0];

function claudeVersion() {
  try {
    const out = require('child_process').execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 8000, shell: WIN, windowsHide: true });
    const m = out.match(/(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  } catch {
    return null;
  }
}
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

// 윈도우: Claude Code 는 훅을 Git Bash 또는 PowerShell 로 실행한다 (Git Bash 가 없으면 PowerShell).
// 두 셸 모두에서 같은 뜻인 `node "<파일>"` 형태만 쓰고, 실제 일은 hook.js 가 한다. (curl/리다이렉션 문법은 쓰지 않는다)
const WIN_HOOK = `node "${sh(path.join(profile.dataDir, 'hook.js'))}"`;
const winCmd = (arg) => `${WIN_HOOK}${arg ? ' ' + arg : ''} ${HOOK_MARKER}`;

const EVENTS = [
  { name: 'SessionStart', cmd: WIN ? winCmd('--launch') : process.platform === 'darwin' ? SESSION_START_CMD : null },
  { name: 'UserPromptSubmit' },
  { name: 'PreToolUse', matcher: '*' },
  { name: 'PostToolUse', matcher: '*' },
  { name: 'Notification' },
  { name: 'Stop' },
  { name: 'SessionEnd' },
];

const args = process.argv.slice(2);
const uninstall = args.includes('--uninstall');
const dryRun = args.includes('--dry-run');
const withStatusline = !args.includes('--no-statusline');
let extraNote = '';
let withExtra = false;
if (!uninstall && !args.includes('--no-extra-hooks')) {
  if (args.includes('--extra-hooks')) {
    withExtra = true;
  } else {
    const v = claudeVersion();
    withExtra = !!v && cmp(v, MIN_EXTRA_VERSION) >= 0;
    extraNote = withExtra
      ? `추가 애니메이션 훅도 설치했어요. (Claude Code ${v.join('.')})`
      : v
      ? `Claude Code ${v.join('.')} 에서는 추가 애니메이션 훅(오류/서브에이전트/정리)을 건너뛰었어요.`
      : '`claude` 버전을 확인하지 못해서 추가 애니메이션 훅(오류/서브에이전트/정리)은 건너뛰었어요. 오류/서브에이전트 표시는 일부만 동작해요.';
  }
}

const base = profile.configDir;
const file = path.join(base, 'settings.json');
const petDir = profile.dataDir;
const bridgeFile = path.join(petDir, 'statusline.js');
const hookFile = path.join(petDir, 'hook.js');
const hookJson = path.join(petDir, 'hook.json');
const STATUS_MARK = `${path.basename(petDir)}/statusline.js`; // 슬래시로 통일해서 비교한다 (윈도우 경로 대응)

let settings = {};
let existed = false;
if (fs.existsSync(file)) {
  existed = true;
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`설정 파일을 JSON으로 읽을 수 없어서 중단했어요: ${file}\n${err.message}`);
    process.exit(1);
  }
}
if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
  console.error(`설정 파일 형식이 예상과 달라서 중단했어요: ${file}`);
  process.exit(1);
}

const before = JSON.stringify(settings, null, 2);

// ---------- 훅 ----------
const isOurHook = (entry) =>
  entry &&
  Array.isArray(entry.hooks) &&
  entry.hooks.some((h) => h && typeof h.command === 'string' && h.command.includes(HOOK_MARKER));

settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
for (const ev of [...EVENTS, ...EXTRA]) {
  const list = Array.isArray(settings.hooks[ev.name]) ? settings.hooks[ev.name] : [];
  const kept = list.filter((entry) => !isOurHook(entry)); // 예전에 넣은 우리 훅은 항상 먼저 제거
  const isExtra = EXTRA.includes(ev);
  if (!uninstall && (!isExtra || withExtra)) {
    const entry = { hooks: [{ type: 'command', command: ev.cmd || (WIN ? winCmd() : HOOK_CMD) }] };
    if (ev.matcher) entry.matcher = ev.matcher;
    kept.push(entry);
  }
  if (kept.length) settings.hooks[ev.name] = kept;
  else delete settings.hooks[ev.name];
}
if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

// ---------- 상태줄 ----------
// statusLine은 설정에 하나만 둘 수 있다. 이미 쓰는 상태줄이 있으면 hook.json에 보관해 두고,
// 우리 브리지가 그 명령을 그대로 실행해서 기존 표시를 유지한다. 제거하면 원래대로 되돌린다.
const isOurStatus = (sl) =>
  sl && typeof sl === 'object' && typeof sl.command === 'string' && sh(sl.command).includes(STATUS_MARK);

let savedOrig = null;
try {
  savedOrig = JSON.parse(fs.readFileSync(hookJson, 'utf8')).orig || null;
} catch {
  /* 처음 설치 */
}

const fileOps = []; // settings.json 저장 직전에 실행할 파일 작업들
if (!uninstall && WIN) {
  // 윈도우 훅 실행기 (hook.js) 를 데이터 폴더에 둔다. 포트/앱 위치는 hook.json 에서 읽는다 (상태줄 설치 시 아래에서 다시 기록)
  fileOps.push(() => {
    fs.mkdirSync(petDir, { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'hook.js'), hookFile);
    if (!fs.existsSync(hookJson)) fs.writeFileSync(hookJson, JSON.stringify({ port: PORT, orig: null, exe: WIN_EXE }, null, 2));
  });
}
if (uninstall) {
  if (isOurStatus(settings.statusLine)) {
    if (savedOrig) settings.statusLine = savedOrig;
    else delete settings.statusLine;
  }
  fileOps.push(() => {
    fs.rmSync(bridgeFile, { force: true });
    fs.rmSync(hookFile, { force: true });
    fs.rmSync(hookJson, { force: true });
  });
} else if (withStatusline) {
  const cur = settings.statusLine;
  const orig = isOurStatus(cur) ? savedOrig : cur && typeof cur === 'object' ? cur : null;
  const next = {
    type: 'command',
    // 윈도우: 상태줄도 Git Bash/PowerShell 어느 쪽에서든 읽히게 `node "<파일>"` 로 쓴다 (따옴표 붙은 exe 경로로 시작하면 PowerShell 이 못 읽는다)
    command: WIN ? `node "${sh(bridgeFile)}"` : `"${sh(process.execPath)}" "${sh(bridgeFile)}"`,
  };
  if (orig && orig.padding != null) next.padding = orig.padding;
  if (orig && orig.refreshInterval != null) next.refreshInterval = orig.refreshInterval;
  settings.statusLine = next;

  fileOps.push(() => {
    fs.mkdirSync(petDir, { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'statusline.js'), bridgeFile);
    fs.writeFileSync(hookJson, JSON.stringify({ port: PORT, orig, ...(WIN ? { exe: WIN_EXE } : {}) }, null, 2));
  });
} else if (isOurStatus(settings.statusLine)) {
  // --no-statusline 인데 예전에 우리 상태줄을 넣어뒀다면 원래대로 되돌린다.
  if (savedOrig) settings.statusLine = savedOrig;
  else delete settings.statusLine;
}

const after = JSON.stringify(settings, null, 2);

if (before === after) {
  console.log(uninstall ? '제거할 펫 설정이 없어요.' : '이미 최신 상태로 설치돼 있어요.');
  // 브리지 스크립트는 최신 파일로 한 번 더 맞춰 둔다.
  if (!uninstall && !dryRun) fileOps.forEach((op) => op());
  process.exit(0);
}

if (dryRun) {
  console.log(after);
  process.exit(0);
}

fs.mkdirSync(base, { recursive: true });
if (existed) {
  const bak = `${file}.claude-pet.bak-${Date.now()}`;
  fs.copyFileSync(file, bak);
  console.log(`백업: ${bak}`);
}
fileOps.forEach((op) => op());
fs.writeFileSync(file, after + '\n');

if (uninstall) {
  console.log(`펫 훅과 상태줄 브리지를 제거했어요: ${file}`);
} else {
  console.log(`펫 훅을 설치했어요: ${file}`);
  if (withStatusline) {
    console.log('상태줄 브리지도 설치했어요. (실제 사용량 막대용, 기존 상태줄이 있었다면 그대로 유지돼요)');
  }
  if (extraNote) console.log(extraNote);
  console.log('이미 켜져 있는 Claude Code 세션은 새로 시작해야 적용돼요.');
}

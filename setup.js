#!/usr/bin/env node
// 한 번에 설치/업데이트/제거. 질문 없이 끝까지 진행한다.  (Claude 에게 설치를 맡길 때도 이 명령 하나면 된다)
//   node setup.js              설치 (이미 설치돼 있으면 최신 소스로 다시 만들어 교체 = 업데이트)
//   node setup.js --uninstall  제거 (훅 + 앱). --purge 를 같이 주면 ~/.claude-pet 설정/기록도 지운다
// 하는 일: npm install → 앱 만들어 설치 → Claude Code 연결(훅) → 펫 실행 → 실행 확인
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync, spawn } = require('child_process');

const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';
const args = process.argv.slice(2);
const profile = require('./profile').get();

const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const WIN_DIR = path.join(local, 'Programs', 'Claude Pet');
const WIN_LNK = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Claude Pet.lnk');
const MAC_APP = path.join(os.homedir(), 'Applications', 'Claude Pet.app');

const step = (n, total, msg) => console.log(`\n[${n}/${total}] ${msg}`);
const fail = (msg) => {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
};
const run = (cmd, a, opts = {}) => spawnSync(cmd, a, { cwd: __dirname, stdio: 'inherit', windowsHide: true, ...opts });
const node = (script, a = []) => run(process.execPath, [script, ...a]);
const quiet = (cmd, a) => spawnSync(cmd, a, { stdio: 'ignore', windowsHide: true });

function killPet() {
  if (WIN) quiet('taskkill', ['/IM', 'Claude Pet.exe', '/F']);
  else quiet('pkill', ['-f', 'Claude Pet']);
}

function launchPet() {
  if (WIN) {
    const exe = path.join(WIN_DIR, 'Claude Pet.exe');
    if (!fs.existsSync(exe)) return false;
    const child = spawn(exe, [], { detached: true, stdio: 'ignore' });
    child.on('error', () => {}); // 실행 실패는 아래 응답 확인에서 걸러진다
    child.unref();
    return true;
  }
  if (MAC) return quiet('open', ['-a', 'Claude Pet']).status === 0;
  return false;
}

// 펫이 켜지면 127.0.0.1:<포트>/status 에 응답한다
function waitForPet(seconds) {
  const deadline = Date.now() + seconds * 1000;
  const ping = () =>
    new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: profile.port, path: '/status', timeout: 1000 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(false));
    });
  return (async () => {
    while (Date.now() < deadline) {
      if (await ping()) return true;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  })();
}

async function install() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) fail(`Node.js 18 이상이 필요해요 (지금 ${process.version}). https://nodejs.org/ko 에서 LTS 버전을 설치한 뒤 다시 실행하세요.`);
  if (!WIN && !MAC) fail('윈도우와 맥에서만 쓸 수 있어요.');

  const TOTAL = 4;
  step(1, TOTAL, '필요한 파일 내려받는 중 (몇 분 걸려요)');
  if (run('npm', ['install', '--no-audit', '--no-fund'], { shell: WIN }).status !== 0) fail('npm install 에 실패했어요. 인터넷 연결을 확인하고 다시 실행해 주세요.');

  step(2, TOTAL, '앱 만들어서 설치하는 중');
  killPet(); // 켜져 있으면 파일을 바꿀 수 없다
  if (node('build-app.js').status !== 0) fail('앱을 만들지 못했어요. 위 메시지를 확인해 주세요.');

  step(3, TOTAL, 'Claude Code 와 연결하는 중');
  if (node('install-hooks.js').status !== 0) fail('Claude Code 설정(훅)을 바꾸지 못했어요. 위 메시지를 확인해 주세요.');

  step(4, TOTAL, '펫 실행');
  const launched = launchPet();
  const up = launched && (await waitForPet(25));

  console.log('\n──────── 결과 ────────');
  console.log(up ? '✅ 설치 완료: 펫이 켜졌어요.' : launched ? '⚠️ 설치는 끝났지만 펫 응답을 확인하지 못했어요. 화면에 펫이 보이는지 확인하고, 안 보이면 `npm run doctor` 를 실행해 보세요.' : '⚠️ 설치는 끝났지만 펫을 자동으로 켜지 못했어요. ' + (WIN ? '시작 메뉴에서 "Claude Pet" 을 실행하세요.' : '"Claude Pet" 을 실행하세요.'));
  console.log('• 이미 켜져 있던 Claude Code 세션은 새로 시작해야 펫이 반응해요.');
  console.log(`• 이 폴더(${__dirname})는 지우지 말고 두세요. 업데이트/점검에 써요.`);
  // 사용량 막대는 Claude Code(터미널)의 로그인 파일을 읽는다. Claude 데스크톱 앱의 로그인과는 따로라서, 터미널 로그인이 없으면 파일이 없다.
  const hasClaude = spawnSync('claude', ['--version'], { stdio: 'ignore', shell: WIN }).status === 0;
  if (!fs.existsSync(path.join(profile.configDir, '.credentials.json'))) {
    console.log('USAGE_LOGIN_NEEDED: 사용량 막대를 보려면 Claude Code 터미널 로그인이 한 번 필요해요. (데스크톱 앱 로그인과는 별개예요)');
    console.log(hasClaude ? '  → `claude auth login` 을 실행하고 브라우저에서 로그인하세요. 끝나면 펫이 알아서 사용량을 불러와요.' : WIN ? '  → `claude` 명령이 없어요. PowerShell 에서 `irm https://claude.ai/install.ps1 | iex` 로 설치한 뒤, 새 터미널에서 `claude auth login` 을 실행하세요.' : '  → `claude` 명령이 없어요. https://claude.ai/install.sh 로 설치한 뒤 `claude auth login` 을 실행하세요.');
  } else if (!hasClaude) {
    console.log('• 참고: `claude` 명령을 찾지 못했어요. 로그인 만료 시 자동 갱신이 동작하지 않을 수 있어요.');
  }
  process.exit(0);
}

function uninstall() {
  killPet();
  step(1, 2, 'Claude Code 설정(훅) 제거');
  node('install-hooks.js', ['--uninstall']);
  step(2, 2, '앱 제거');
  if (WIN) {
    fs.rmSync(WIN_DIR, { recursive: true, force: true });
    fs.rmSync(WIN_LNK, { force: true });
    for (const name of ['electron.app.Claude Pet', 'Claude Pet']) quiet('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', name, '/f']); // 로그인 시 자동 실행 등록
  } else {
    fs.rmSync(MAC_APP, { recursive: true, force: true });
  }
  if (args.includes('--purge')) {
    fs.rmSync(profile.dataDir, { recursive: true, force: true });
    console.log('설정과 기록도 지웠어요.');
  }
  console.log('\n✅ 제거했어요. 이 폴더는 직접 지우셔도 돼요.');
}

if (args.includes('--uninstall')) uninstall();
else install();

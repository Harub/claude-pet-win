#!/usr/bin/env node
// 터미널 없이 실행되는 앱을 만들어서 설치한다.
//   npm run build-app
//  - 맥:     "Claude Pet.app" 을 ~/Applications 에 설치. 이 맥의 CPU(arm64/x64)에 맞춰 빌드하고,
//            독(Dock)에 아이콘이 뜨지 않게 설정하고, 개인용 임시 서명(ad-hoc)을 해서 Apple Silicon에서도 실행되게 한다.
//  - 윈도우: "Claude Pet.exe" 를 %LOCALAPPDATA%\Programs\Claude Pet 에 설치하고 시작 메뉴에 바로가기를 만든다.
//   node build-app.js --no-install     만들어서 서명까지만 하고 설치는 하지 않는다 (자동 업데이트가 쓴다)
//   node build-app.js --install-only   이미 만들어 둔 것을 ~/Applications 에 설치만 한다 (자동 업데이트가 쓴다)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const NAME = 'Claude Pet';
const WIN = process.platform === 'win32';
const args = process.argv.slice(2);
const noInstall = args.includes('--no-install');
const installOnly = args.includes('--install-only');

// 자동 업데이트가 이 소스 폴더를 찾을 수 있게 위치와 node 위치를 기억해 둔다.
function rememberRepo() {
  try {
    const dir = path.join(os.homedir(), '.claude-pet');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'repo.json'), JSON.stringify({ repo: __dirname, nodeBin: path.dirname(process.execPath) }, null, 2));
  } catch {
    /* 기억 못 해도 빌드에는 영향 없음 */
  }
}

// 윈도우: 폴더째 복사해서 설치하고 시작 메뉴 바로가기를 만든다. (설치 위치는 install-hooks.js 의 자동 실행 훅도 알고 있다)
function installWin(builtDir) {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dest = path.join(local, 'Programs', NAME);
  const tmp = `${dest}.new`;
  try {
    execFileSync('taskkill', ['/IM', `${NAME}.exe`, '/F'], { stdio: 'ignore' }); // 켜져 있으면 파일을 바꿀 수 없어서 먼저 끈다
  } catch {
    /* 켜져 있지 않음 */
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.cpSync(builtDir, tmp, { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(tmp, dest);

  const exe = path.join(dest, `${NAME}.exe`);
  const lnk = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${NAME}.lnk`);
  try {
    // 경로는 환경변수로 넘겨서 따옴표/공백 문제가 없게 한다
    const ps = '$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:PET_LNK); $s.TargetPath=$env:PET_EXE; $s.WorkingDirectory=Split-Path $env:PET_EXE; $s.Save()';
    execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { env: { ...process.env, PET_LNK: lnk, PET_EXE: exe }, stdio: 'ignore' });
  } catch {
    console.log('시작 메뉴 바로가기는 만들지 못했어요. 대신 이 파일을 직접 실행하세요: ' + exe);
  }
  return dest;
}

// 새 앱을 옆에 먼저 복사한 뒤 바꿔치기해서, 복사가 실패해도 기존 앱이 사라지지 않게 한다.
function installApp(appPath) {
  const destDir = path.join(os.homedir(), 'Applications');
  const dest = path.join(destDir, `${NAME}.app`);
  const tmp = `${dest}.new`;
  fs.mkdirSync(destDir, { recursive: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  execFileSync('ditto', [appPath, tmp]); // 프레임워크 심볼릭 링크를 보존하며 복사
  try {
    execFileSync('xattr', ['-cr', tmp]); // 혹시 붙은 격리 속성 제거
  } catch {
    /* ignore */
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(tmp, dest);
  return dest;
}

// 이 앱을 만든 커밋을 앱 안에 적어 둔다. 자동 업데이트가 "최신인지" 비교하는 데 쓴다.
function writeBuildCommit() {
  try {
    const sha = execFileSync('git', ['-C', __dirname, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(__dirname, 'build-commit.txt'), sha + '\n');
  } catch {
    /* git 이 없거나 저장소가 아니면 건너뜀 */
  }
}

async function main() {
  rememberRepo();
  const out = path.join(__dirname, 'dist');
  if (installOnly) {
    const built = WIN ? path.join(out, `${NAME}-win32-${process.arch}`) : path.join(out, `${NAME}-darwin-${process.arch}`, `${NAME}.app`);
    if (!fs.existsSync(built)) {
      console.error(`만들어 둔 앱이 없어요: ${built}`);
      process.exit(1);
    }
    console.log(`설치했어요: ${WIN ? installWin(built) : installApp(built)}`);
    return;
  }

  // @electron/packager 는 버전에 따라 ESM(이름 있는 export)/CJS(default export)라서 import()로 둘 다 받는다.
  let packager;
  try {
    const ns = await import('@electron/packager');
    packager =
      ns.packager ||
      (typeof ns.default === 'function' ? ns.default : ns.default && ns.default.packager);
  } catch (err) {
    console.error('@electron/packager 를 불러오지 못했어요. 먼저 `npm install` 을 실행해주세요.\n' + err.message);
    process.exit(1);
  }
  if (typeof packager !== 'function') {
    console.error('@electron/packager 형식을 인식하지 못했어요. `npm install` 로 다시 설치해보세요.');
    process.exit(1);
  }

  writeBuildCommit();
  const paths = await packager({
    dir: __dirname,
    name: NAME,
    platform: WIN ? 'win32' : 'darwin',
    arch: process.arch,
    out,
    overwrite: true,
    prune: false, // 런타임 의존성이 하나도 없어서 node_modules는 통째로 뺀다 (아래 ignore)
    ...(WIN ? {} : { appBundleId: 'local.claudepet.app', extendInfo: { LSUIElement: true } }), // 맥: 독/앱 전환기에 안 보이는 백그라운드 위젯 앱
    ignore: [
      /^\/dist-template($|\/)/,
      /\.(command|bat)$/,
      /^\/dist($|\/)/,
      /^\/node_modules($|\/)/,
      /^\/package-lock\.json$/,
      /^\/README\.md$/,
      /^\/install-hooks\.js$/,
      /^\/doctor\.js$/,
      /^\/tools($|\/)/,
      /^\/build-app\.js$/,
      /^\/setup\.js$/,
      /^\/hook\.js$/,
    ],
  });

  if (WIN) {
    console.log(`빌드 완료: ${paths[0]}`);
    if (noInstall) return console.log('설치는 건너뛰었어요. (--no-install)');
    const dest = installWin(paths[0]);
    console.log(`\n설치했어요: ${dest}`);
    console.log('시작 메뉴에서 "Claude Pet" 으로 실행할 수 있어요. 이미 켜져 있던 펫은 종료하고 새로 켜졌어요.');
    return;
  }

  const appPath = path.join(paths[0], `${NAME}.app`);
  console.log(`빌드 완료: ${appPath}`);

  if (process.platform !== 'darwin') {
    console.log('맥이 아니라서 서명/설치는 건너뛰었어요. 맥에서 `npm run build-app` 을 실행하세요.');
    return;
  }

  // Apple Silicon은 서명이 깨진 앱을 실행하지 않는다. 패키징으로 내용이 바뀌었으니 다시 서명한다.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });

  if (noInstall) {
    console.log('설치는 건너뛰었어요. (--no-install)');
    return;
  }
  const dest = installApp(appPath);

  console.log(`\n설치했어요: ${dest}`);
  console.log('이제 터미널 없이 Finder/Spotlight에서 "Claude Pet" 으로 실행할 수 있어요.');
  console.log('새로 설치했다면 `npm run install-hooks` 를 다시 실행해서 자동 실행 훅을 적용하세요.');
  console.log('이미 펫이 켜져 있었다면 우클릭 → 종료 후 다시 실행해야 새 버전이 적용돼요.');
}

main().catch((err) => {
  console.error('빌드 실패:', err && err.message ? err.message : err);
  process.exit(1);
});

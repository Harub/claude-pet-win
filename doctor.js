#!/usr/bin/env node
// 펫이 왜 안 움직이는지 / 사용량이 왜 안 보이는지 점검한다.   npm run doctor
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { fetchUsage } = require('./usage-api');

const profileMod = require('./profile');
const profile = profileMod.get(profileMod.nameFrom(process.argv.slice(2), process.env)); // 프로필 (profile.js)
const PORT = profile.port;
const base = profile.configDir;
const petDir = profile.dataDir;

const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m, fix) => console.log(`  ❌ ${m}${fix ? `\n     → ${fix}` : ''}`);
const info = (m) => console.log(`  ℹ️  ${m}`);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function getStatus() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/status', timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

(async () => {
  console.log(`\n포트 ${PORT} · 설정 폴더 ${base}`);
  console.log('\n[1] Claude Code 설정');
  const settings = readJson(path.join(base, 'settings.json'));
  if (!settings) {
    bad(`${path.join(base, 'settings.json')} 을 읽지 못했어요`, '`npm run install-hooks` 를 실행하세요');
  } else {
    const hooks = settings.hooks || {};
    const names = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'];
    const missing = names.filter((n) => !JSON.stringify(hooks[n] || '').includes('# claude-pet'));
    if (missing.length) bad(`펫 훅이 빠져 있어요: ${missing.join(', ')}`, '`npm run install-hooks` 를 실행하세요');
    else ok('펫 훅 7개 설치됨');

    const sl = settings.statusLine;
    if (sl && typeof sl.command === 'string' && sl.command.includes(path.join(path.basename(petDir), 'statusline.js'))) {
      ok('상태줄 브리지 설치됨 (사용량 막대용)');
    } else {
      bad('상태줄 브리지가 설정에 없어요 → 사용량 막대가 비어 있게 돼요', '`npm run install-hooks` (--no-statusline 없이) 를 실행하세요');
    }
  }

  // 프로젝트별 설정이 사용자 설정의 statusLine 을 덮어쓰면 브리지가 호출되지 않는다.
  for (const f of [path.join(process.cwd(), '.claude', 'settings.json'), path.join(process.cwd(), '.claude', 'settings.local.json')]) {
    const j = readJson(f);
    if (j && j.statusLine) {
      bad(`${f} 에 statusLine 이 따로 있어서 브리지가 무시돼요`, '그 프로젝트 설정의 statusLine 을 지우거나, 그 명령 앞에 브리지를 연결하세요');
    }
  }

  console.log('\n[2] 브리지 파일');
  if (fs.existsSync(path.join(petDir, 'statusline.js'))) ok(`${petDir}/statusline.js 있음`);
  else bad(`${petDir}/statusline.js 가 없어요`, `\`npm run ${profile.installScript}\` 를 실행하세요`);
  if (process.platform === 'win32') {
    if (fs.existsSync(path.join(petDir, 'hook.js'))) ok(`${petDir}/hook.js 있음`);
    else bad(`${petDir}/hook.js 가 없어요`, '`npm run install-hooks` 를 실행하세요');
    try {
      info(`node: ${execFileSync('node', ['-v'], { encoding: 'utf8', timeout: 5000, shell: true, windowsHide: true }).trim()} (훅이 \`node\` 명령을 써요. 새 터미널/세션에서 안 잡히면 Node.js 를 다시 설치하세요)`);
    } catch {
      bad('`node` 명령을 찾지 못해요 (훅이 이 명령으로 실행돼요)', 'Node.js 를 설치하고 Claude Code 를 다시 시작하세요');
    }
  }

  console.log('\n[3] 펫 앱');
  const st = await getStatus();
  if (!st) {
    bad(`127.0.0.1:${PORT} 에서 응답이 없어요 (펫이 꺼져 있거나 포트가 달라요)`, (process.platform === 'win32' ? '시작 메뉴에서 Claude Pet 을 실행하거나 `npm start`' : 'Spotlight 에서 Claude Pet 을 실행하거나 `npm start`'));
  } else {
    ok(`펫 실행 중 · 상태 ${st.state}${st.project ? ` · ${st.project}` : ''}`);
    const l = st.limits || {};
    if (l.fiveHour || l.sevenDay) {
      ok(`사용량 수신 중 · 세션 ${l.fiveHour ? Math.round(l.fiveHour.pct) + '%' : '–'} · 주 ${l.sevenDay ? Math.round(l.sevenDay.pct) + '%' : '–'}`);
    } else if (!l.seen) {
      bad('이번 실행 중 상태줄 신호를 한 번도 못 받았어요', 'Claude Code 를 새 세션으로 시작하고 메시지를 하나 보내보세요. Claude 데스크톱 앱(Code 탭)은 상태줄을 실행하지 않아서 신호가 오지 않아요. 터미널의 `claude` 에서만 사용량이 들어와요');
    } else if (!l.hasRl) {
      bad('상태줄 신호는 오는데 rate_limits 가 없어요', 'claude.ai Pro/Max 로그인 상태인지, Claude Code 가 최신 버전인지 확인하세요 (API 키 사용 시 한도 정보가 없어요)');
    } else {
      info('수신은 됐지만 두 창 모두 이미 리셋된 값이에요. 다음 응답 후 갱신돼요.');
    }
  }

  // 마지막 작업 끝(Stop)에서 받은 정보: 답변 첫 줄/세션 이름을 못 읽을 때 원인을 알 수 있다. (대화 내용은 담지 않음)
  const stop = st && st.diag && st.diag.stop;
  if (stop) {
    info(`마지막 Stop 이벤트 항목: ${stop.keys.join(', ')}`);
    if (stop.lastMessage || (stop.transcriptPath && stop.readable)) ok(`답변 읽기 가능 · 답변 첫 줄 ${stop.answerFound ? '찾음' : '못 찾음'} · 세션 이름 ${stop.nameFound ? '찾음' : '못 찾음'}`);
    else if (!stop.transcriptPath) bad('Stop 이벤트에 대화 기록 경로가 없어요', '이 결과를 알려주세요');
    else bad('대화 기록 파일이 허용된 위치(홈 폴더) 밖에 있어요', '이 결과를 알려주세요');
  } else if (st) {
    info('아직 작업이 끝난 세션이 없어요. 새 세션에서 메시지를 하나 보내고 다시 실행하세요.');
  }

  const saved = readJson(path.join(petDir, 'limits.json'));
  if (saved && saved.updatedAt) info(`마지막 저장된 사용량: ${new Date(saved.updatedAt).toLocaleString()}`);

  console.log('\n[4] 로그인 정보로 사용량 조회 (데스크톱 앱용)');
  // 키체인에 어떤 Claude Code 로그인 항목이 있는지 이름만 보여준다 (토큰은 읽지 않는다)
  if (process.platform !== 'darwin') {
    const credFile = path.join(base, '.credentials.json');
    if (fs.existsSync(credFile)) info(`Claude Code 로그인 파일 있음: ${credFile}`);
    else info(`Claude Code 로그인 파일이 없어요: ${credFile} (터미널에서 \`claude\` 로 로그인하면 생겨요)`);
  } else
  try {
    const out = execFileSync('/usr/bin/security', ['dump-keychain'], { encoding: 'utf8', timeout: 20000, maxBuffer: 50 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    const names = [...new Set((out.match(/"svce"<blob>="Claude Code-credentials[^"]*"/g) || []).map((m) => m.replace(/^"svce"<blob>="|"$/g, '')))];
    info(`키체인의 Claude Code 로그인 항목: ${names.join(', ') || '없음'}`);
    info(`이 프로필이 읽는 항목: ${profile.credService}${names.includes(profile.credService) ? ' (있음)' : ' (없음)'}`);
  } catch {
    /* 키체인 목록을 못 읽어도 계속 */
  }
  const r = await fetchUsage({ service: profile.credService, configDir: profile.configDir });
  if (!r.error) {
    const f = (w) => (w ? Math.round(w.used_percentage) + '%' : '–');
    ok(`조회 성공 · 세션 ${f(r.five_hour)} · 주 ${f(r.seven_day)}`);
  } else {
    const WHY = {
      nocred: ['Claude 로그인 정보를 못 찾았어요', 'Claude Code 에 로그인돼 있는지 확인하세요.' + (process.platform === 'darwin' ? ' 키체인 접근 허용 창이 뜨면 "허용"을 누르세요' : '')],
      expired: ['로그인 토큰이 만료됐어요', 'Claude Code 를 한 번 실행해 메시지를 보내면 자동으로 갱신돼요'],
      auth: ['인증이 거부됐어요', 'Claude Code 에서 로그아웃 후 다시 로그인해보세요'],
      http: ['서버가 오류를 돌려줬어요' + (r.status ? ` (HTTP ${r.status})` : ''), '비공식 조회 방식이라 바뀌었을 수 있어요. 이 결과를 알려주세요'],
      net: ['서버에 연결하지 못했어요', '인터넷 연결을 확인하세요'],
      shape: ['응답 형식이 예상과 달라요', '비공식 조회 방식이 바뀌었을 수 있어요. 이 결과를 알려주세요'],
    }[r.error] || [r.error];
    bad(WHY[0], WHY[1]);
  }

  // 펫 앱이 마지막으로 조회한 결과 (앱이 직접 기록한다)
  const us = readJson(path.join(petDir, 'usage-status.json'));
  if (us) info(`펫 앱의 마지막 조회: ${us.at} · ${us.ok ? '성공' : `실패(${us.error}${us.status ? ' ' + us.status : ''}${us.message ? ' ' + us.message : ''})`}`);
  else info('펫 앱이 조회한 기록이 아직 없어요 (펫이 켜져 있는지, 최신 버전인지 확인하세요)');

  console.log('\n[5] Claude Code 버전');
  try {
    info(execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 5000, shell: process.platform === 'win32', windowsHide: true }).trim());
  } catch {
    info('`claude --version` 을 실행하지 못했어요 (PATH 확인)');
  }
  console.log('');
})();

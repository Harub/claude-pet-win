// 로그인(OAuth) 토큰이 만료됐을 때 Claude Code 가 스스로 갱신하게 만든다.
//  - 토큰을 직접 갱신하지 않는다. (갱신 주소/앱 식별값은 공식 문서에 없고, Claude Code 의 로그인 정보를 덮어써야 해서 위험하다)
//  - 대신 `claude -p` 로 아주 짧은 요청을 한 번 보낸다. Claude Code 가 요청 전에 만료된 토큰을 알아서 새로 받아서 저장한다.
//  - 가장 작은 모델(haiku), 한 번만, 전용 폴더에서 실행한다. 사용량은 몇 토큰이고 만료될 때(대략 8시간마다)만 쓴다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const DIR = path.join(os.homedir(), '.claude-pet', 'refresh');
const REFRESH_DIRS = [DIR];
const ARGS = ['-p', 'ok', '--model', 'haiku', '--max-turns', '1'];

// 이 폴더에서 일어난 Claude Code 이벤트는 펫이 무시한다 (갱신용 요청이 펫을 움직이게 하지 않으려고)
function isRefreshCwd(cwd) {
  if (typeof cwd !== 'string') return false;
  const c = path.resolve(cwd) + path.sep;
  return REFRESH_DIRS.some((d) => c.startsWith(d + path.sep));
}

// 갱신을 시도한다. 성공(요청이 정상 종료)하면 true.
// opts.dir: 갱신 요청을 실행할 전용 폴더, opts.configDir: 설정 폴더가 따로일 때 그 폴더로 갱신하게 한다
function refreshLogin(nodeBin, run = execFile, opts = {}) {
  return new Promise((resolve) => {
    const dir = opts.dir || DIR;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      return resolve(false);
    }
    const win = process.platform === 'win32';
    const env = { ...process.env };
    // 맥: 앱으로 켜면 PATH 가 짧아서 claude 를 못 찾으니 흔한 위치를 덧붙인다. (윈도우는 사용자 PATH 를 그대로 쓴다)
    if (!win) env.PATH = [nodeBin, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(':');
    if (opts.configDir) env.CLAUDE_CONFIG_DIR = opts.configDir;
    // 윈도우의 claude 는 claude.cmd 일 수 있어서 셸을 거쳐 실행한다 (인자에 공백/특수문자 없음)
    run('claude', ARGS, { cwd: dir, env, timeout: 90 * 1000, maxBuffer: 1024 * 1024, shell: win, windowsHide: true }, (err) => resolve(!err));
  });
}

module.exports = { refreshLogin, isRefreshCwd, DIR, ARGS };

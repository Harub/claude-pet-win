// 프로필: 펫이 쓰는 포트/데이터 폴더/설정 폴더/키체인 항목/앱 이름을 한곳에서 정한다.
//  - 포트:       훅이 보내는 이벤트를 받는 주소 (기본 3199)
//  - 데이터 폴더: 위치/설정/사용량 기록 (~/.claude-pet)
//  - 설정 폴더:   Claude Code 가 쓰는 폴더 (~/.claude). 훅은 여기 settings.json 에 설치된다.
//  - 로그인 정보: 키체인에서 읽는 항목 이름
//  - 앱 이름/데이터: 클릭하면 열 Claude 앱, 세션 정보를 찾을 앱 데이터 폴더
const os = require('os');
const path = require('path');

const { defaultRoot } = require('./session-names');

const HOME = os.homedir();

function nameFrom(argv = process.argv, env = process.env) {
  return 'default';
}


function get(name = nameFrom(), env = process.env) {
  return {
    name: 'default',
    label: '',
    color: 'coral',
    primary: true,
    port: Number(env.CLAUDE_PET_PORT) || 3199,
    dataDir: path.join(HOME, '.claude-pet'),
    configDir: env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'),
    credService: 'Claude Code-credentials',
    credFallbackToDefault: true,
    usageSource: 'keychain',
    appName: 'Claude',
    appSupportRoot: defaultRoot() || path.join(HOME, 'Library', 'Application Support', 'Claude'),
    userDataName: null,
    launchArgs: [],
    installScript: 'install-hooks',
    openFlags: '',
    followerOffset: 0,
    defaultPosOffset: 0,
    refreshConfigDir: null,
  };
}

module.exports = { get, nameFrom };

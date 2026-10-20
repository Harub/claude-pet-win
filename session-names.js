// Claude 데스크톱 앱(Code 탭)이 따로 저장해 두는 세션 이름을 찾는다.
// 파일 모양을 확실히 알 수 없어서, 앱 폴더의 .json 중 세션 ID가 들어 있는 파일의 title 을 읽는다.
// 못 찾으면 null 이고, 그래도 펫은 문제없이 동작한다. (읽기만 하고 아무것도 쓰지 않는다)
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_FILES = 600;
const MAX_DEPTH = 5;
const MAX_SIZE = 512 * 1024;

// Claude 데스크톱 앱의 데이터 폴더 (맥: Library/Application Support/Claude, 윈도우: %APPDATA%\Claude)
function defaultRoot() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Claude');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude');
  return null;
}

function* walk(dir, depth = 0) {
  if (depth > MAX_DEPTH) return;
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of names) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) {
      if (/^(Cache|Code Cache|GPUCache|node_modules|IndexedDB|Local Storage|Session Storage|Service Worker|blob_storage)$/.test(d.name)) continue;
      yield* walk(p, depth + 1);
    } else if (d.name.endsWith('.json')) yield p;
  }
}

const clip40 = (t) => {
  const s = String(t).replace(/\s+/g, ' ').trim();
  return s.length > 40 ? s.slice(0, 39) + '…' : s;
};

// 내가 고른 폴더 중 첫 번째의 이름 (userSelectedFolders: 문자열 또는 {path} 의 배열)
function pickFolder(j) {
  const list = Array.isArray(j.userSelectedFolders) ? j.userSelectedFolders : [];
  for (const f of list) {
    const p = typeof f === 'string' ? f : f && typeof f.path === 'string' ? f.path : '';
    const name = p.split(/[\\/]/).filter(Boolean).pop();
    if (name) return name;
  }
  return null;
}

// 데스크톱 앱이 저장한 세션 정보: { title, folder } (없으면 null)
function findDesktopInfo(sessionId, root = defaultRoot()) {
  if (!root || !sessionId) return null;
  let n = 0;
  for (const file of walk(root)) {
    if (++n > MAX_FILES) break;
    try {
      if (fs.statSync(file).size > MAX_SIZE) continue;
      const raw = fs.readFileSync(file, 'utf8');
      if (!raw.includes(sessionId)) continue; // 값 전체를 파싱하기 전에 빠르게 걸러낸다
      const j = JSON.parse(raw);
      if (j && [j.cliSessionId, j.sessionId, j.session_id].includes(sessionId)) {
        const title = typeof j.title === 'string' && j.title.trim() ? clip40(j.title) : null;
        const folder = pickFolder(j);
        // 앱 안에서 세션을 여는 링크(claude://code/continue?session=...)에 쓰는 ID. Code 탭 세션만 해당한다.
        const appId = file.includes(`${path.sep}claude-code-sessions${path.sep}`) && /^local_[0-9a-f-]{36}$/.test(j.sessionId) ? j.sessionId : null;
        if (title || folder || appId) return { title, folder, appId };
      }
    } catch {
      /* 읽을 수 없는 파일은 건너뜀 */
    }
  }
  return null;
}

const findDesktopTitle = (sessionId, root) => {
  const i = findDesktopInfo(sessionId, root);
  return i && i.title;
};

module.exports = { defaultRoot, findDesktopInfo, findDesktopTitle };

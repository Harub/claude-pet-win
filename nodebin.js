// build-app 이 기억해 둔 node 위치 (~/.claude-pet/repo.json 의 nodeBin).
// 앱은 Electron 으로 실행되어 PATH 에 node 가 없으므로, `claude`(로그인 갱신용)를 찾을 때 이 폴더를 PATH 에 넣는다.
const fs = require('fs');
const os = require('os');
const path = require('path');

function readNodeBin() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude-pet', 'repo.json'), 'utf8'));
    return typeof j.nodeBin === 'string' ? j.nodeBin : null;
  } catch {
    return null;
  }
}

module.exports = { readNodeBin };

#!/usr/bin/env node
// Claude Code 상태줄 브릿지. install-hooks.js가 ~/.claude-pet/statusline.js 로 복사해 둔다.
//  1) 상태줄 JSON(stdin)을 펫 서버로 보낸다 (rate_limits 때문에)
//  2) 원래 쓰던 상태줄 명령이 있으면 그대로 실행해서 그 출력을 보여준다
//  3) 원래 상태줄이 없으면 한 줄짜리 간단한 표시만 출력한다
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = __dirname; // 이 파일은 데이터 폴더(~/.claude-pet)로 복사되어 쓰이므로, 설정도 같은 폴더에서 읽는다
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(path.join(dir, 'hook.json'), 'utf8'));
} catch {
  /* 설정이 없으면 기본값 */
}
const PORT = Number(cfg.port) || 3199;

// 원래 상태줄 명령 실행. 맥/리눅스는 sh, 윈도우는 Claude Code 가 쓰는 Git Bash 를 찾아서 쓴다(없으면 기본 셸).
function runOriginal(cmd) {
  const opts = { input: raw, encoding: 'utf8', timeout: 5000, windowsHide: true };
  if (process.platform !== 'win32') return spawnSync('/bin/sh', ['-c', cmd], opts);
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const bash = [process.env.CLAUDE_CODE_GIT_BASH_PATH, path.join(pf, 'Git', 'bin', 'bash.exe'), path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe')].find((p) => p && fs.existsSync(p));
  return bash ? spawnSync(bash, ['-c', cmd], opts) : spawnSync(cmd, { ...opts, shell: true });
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', async () => {
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    /* JSON이 아니면 전달만 하고 넘어간다 */
  }

  await new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: '/statusline', method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 800 },
      (res) => {
        res.resume();
        res.on('end', resolve);
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });
    req.on('error', resolve); // 펫이 꺼져 있어도 조용히 넘어간다
    req.end(raw);
  });

  const orig = cfg.orig && typeof cfg.orig.command === 'string' ? cfg.orig.command : null;
  if (orig) {
    const r = runOriginal(orig);
    process.stdout.write(r.stdout || '');
    return;
  }

  const rl = (data && data.rate_limits) || {};
  const parts = [];
  if (rl.five_hour && Number.isFinite(rl.five_hour.used_percentage)) parts.push(`세션 ${Math.round(rl.five_hour.used_percentage)}%`);
  if (rl.seven_day && Number.isFinite(rl.seven_day.used_percentage)) parts.push(`주 ${Math.round(rl.seven_day.used_percentage)}%`);
  process.stdout.write('🐾' + (parts.length ? ' ' + parts.join(' · ') : '') + '\n');
});

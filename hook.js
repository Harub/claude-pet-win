#!/usr/bin/env node
// 윈도우용 훅 실행기. Claude Code 가 훅마다 `node "<이 파일>"` 로 실행하고, 훅 JSON(stdin)을 펫 서버로 전달한다.
//  - curl/bash 문법에 기대지 않아서 Git Bash 든 PowerShell 이든 똑같이 동작한다.
//  - 어떤 경우에도 조용히 끝낸다 (펫이 꺼져 있어도 Claude Code 에 영향 없음).
//  - `--launch` (SessionStart): 펫이 꺼져 있으면 앱을 켠 뒤 다시 보낸다. 단 /clear, 컴팩트로 다시 시작되는 경우는 제외.
//    켜는 동안 Claude Code 시작을 막지 않도록 별도 프로세스(--late)로 넘긴다.
// 이 파일은 데이터 폴더(~/.claude-pet)로 복사되어 쓰인다. 포트와 앱 위치는 같은 폴더의 hook.json 에서 읽는다.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'hook.json'), 'utf8'));
} catch {
  /* 설정이 없으면 기본값 */
}
const PORT = Number(cfg.port) || 3199;
const mode = process.argv[2] || '';

function post(body) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: '/event', method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 1000 },
      (res) => {
        res.resume();
        res.on('end', () => resolve(true));
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end(body);
  });
}

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (raw += c));
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', () => resolve(raw));
  });
}

function launchPet() {
  const exe = typeof cfg.exe === 'string' ? cfg.exe : '';
  if (!exe || !fs.existsSync(exe)) return false;
  const child = spawn(exe, [], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return true;
}

(async () => {
  const raw = await readStdin();
  if (mode === '--late') {
    // 펫을 켠 뒤 잠시 기다렸다가 SessionStart 이벤트를 다시 보낸다
    if (launchPet()) {
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (await post(raw)) break;
      }
    }
    return;
  }
  const ok = await post(raw);
  if (ok || mode !== '--launch') return;
  if (/"source"\s*:\s*"(clear|compact)"/.test(raw)) return;
  const child = spawn(process.execPath, [__filename, '--late'], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  child.stdin.end(raw);
  child.unref();
})()
  .catch(() => {})
  .finally(() => setTimeout(() => process.exit(0), 50)); // 남은 연결이 있어도 바로 끝낸다

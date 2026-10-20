// Claude Code 로그인 정보로 사용량(5시간/7일 한도)을 직접 조회한다.
// 데스크톱 앱(Code 탭)은 상태줄을 실행하지 않아서 상태줄 방식으로는 사용량이 오지 않기 때문이다.
//  - 토큰은 맥 키체인("Claude Code-credentials") 또는 ~/.claude/.credentials.json (윈도우/리눅스) 에서 읽기만 한다.
//  - 토큰은 api.anthropic.com 으로만 보내고, 저장/로그/갱신은 하지 않는다. (만료되면 Claude Code 가 갱신할 때까지 기다린다)
//  - 공식 문서에 없는 엔드포인트라서 언제든 바뀌거나 막힐 수 있다. 실패하면 조용히 힌트만 보여준다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');

const SERVICE = 'Claude Code-credentials';

function parseCredentials(raw) {
  try {
    const j = JSON.parse(String(raw).trim());
    const o = (j && j.claudeAiOauth) || j || {};
    if (typeof o.accessToken !== 'string' || !o.accessToken) return null;
    return { token: o.accessToken, expiresAt: Number(o.expiresAt) || 0 };
  } catch {
    return null;
  }
}

// opts.service: 키체인 항목 이름 (계정별로 다르다), opts.configDir: 파일 방식일 때 찾을 설정 폴더
function readCredentials(opts = {}) {
  const service = opts.service || SERVICE;
  return new Promise((resolve) => {
    const fromFile = () => {
      try {
        const base = opts.configDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
        resolve(parseCredentials(fs.readFileSync(path.join(base, '.credentials.json'), 'utf8')));
      } catch {
        resolve(null);
      }
    };
    if (process.platform !== 'darwin') return fromFile();
    execFile('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], { timeout: 20000 }, (err, out) => {
      const c = err ? null : parseCredentials(out);
      if (c) resolve(c);
      else fromFile();
    });
  });
}

function request(token) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        host: 'api.anthropic.com',
        path: '/api/oauth/usage',
        method: 'GET',
        timeout: 8000,
        headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-pet' },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          if (body.length < 64 * 1024) body += c;
        });
        res.on('end', () => {
          if (res.statusCode === 401 || res.statusCode === 403) return resolve({ error: 'auth', status: res.statusCode });
          if (res.statusCode !== 200) return resolve({ error: 'http', status: res.statusCode });
          try {
            resolve({ data: JSON.parse(body) });
          } catch {
            resolve({ error: 'http', status: res.statusCode });
          }
        });
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ error: 'net' }));
    req.end();
  });
}

// { five_hour: {utilization, resets_at(ISO)}, seven_day: {...} } -> limits.js 가 받는 모양(resets_at 은 epoch 초)
function parseUsage(data) {
  const conv = (w) => {
    if (!w || typeof w !== 'object') return null;
    const pct = Number(w.utilization);
    if (!Number.isFinite(pct)) return null;
    const t = Date.parse(w.resets_at);
    return { used_percentage: pct, resets_at: Number.isFinite(t) ? t / 1000 : 0 };
  };
  if (!data || typeof data !== 'object') return null;
  const five = conv(data.five_hour);
  const seven = conv(data.seven_day);
  return five || seven ? { five_hour: five, seven_day: seven } : null;
}

// 키체인을 매번 읽지 않도록 로그인 정보를 잠깐 기억해 둔다. (작업 중에는 15초마다 조회하므로)
const cache = new Map(); // 키체인 항목 이름 -> { cred, at } (계정마다 따로)
const CACHE_MS = 5 * 60 * 1000;

// 반환: { five_hour, seven_day } 또는 { error: 'nocred' | 'expired' | 'auth' | 'http' | 'net' | 'shape', status? }
async function fetchUsage(deps = {}) {
  const read = deps.readCredentials || ((o) => readCredentials(o));
  const req = deps.request || request;
  const key = deps.service || SERVICE;
  const hit = cache.get(key);
  let cred = !deps.readCredentials && hit && Date.now() - hit.at < CACHE_MS ? hit.cred : null;
  if (cred && cred.expiresAt && cred.expiresAt < Date.now()) cred = null;
  if (!cred) {
    cred = await read({ service: deps.service, configDir: deps.configDir });
    if (!cred) return { error: 'nocred' };
    if (cred.expiresAt && cred.expiresAt < Date.now()) return { error: 'expired' };
    if (!deps.readCredentials) cache.set(key, { cred, at: Date.now() });
  }
  const r = await req(cred.token);
  if (r.error) {
    if (r.error === 'auth') cache.delete(key); // 토큰이 바뀌었을 수 있으니 다음엔 다시 읽는다
    return r;
  }
  return parseUsage(r.data) || { error: 'shape' };
}

module.exports = { fetchUsage, parseUsage, parseCredentials, readCredentials };

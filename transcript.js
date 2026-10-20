// Claude Code 대화 기록(transcript, .jsonl)에서 말풍선에 쓸 정보를 뽑는다.
//  - lastAssistantText: Claude가 이번 턴에 마지막으로 한 말 (작업 중 요약 / 완료 시 답변 첫 줄)
//  - sessionTitle:      세션 이름 (/rename 으로 정한 이름이나 자동으로 붙은 제목)
// 훅 이벤트에는 작업 내용이 거의 없어서(도구 이름 정도), 이 기록이 "무슨 일을 하는지"를 가장 잘 알려준다.
const fs = require('fs');
const os = require('os');
const path = require('path');

const TAIL_BYTES = 256 * 1024;
const HEAD_BYTES = 64 * 1024;
const NOTE_MAX = 64;
const ANSWER_MAX = 90;

// 로컬 포트로 받은 이벤트의 경로를 그대로 읽지 않도록, 내 홈 폴더 안의 .jsonl 만 읽는다.
// (터미널 claude 는 ~/.claude, 데스크톱 앱은 다른 폴더에 기록을 둘 수 있어서 홈 전체를 허용한다.)
function isReadable(file) {
  if (typeof file !== 'string' || !file.endsWith('.jsonl')) return false;
  const fold = process.platform === 'win32' ? (p) => p.toLowerCase() : (p) => p; // 윈도우는 대소문자(C:/c:)를 구분하지 않는다
  const roots = [os.homedir(), process.env.CLAUDE_CONFIG_DIR].filter(Boolean).map((r) => fold(path.resolve(r) + path.sep));
  const f = fold(path.resolve(file));
  return roots.some((r) => f.startsWith(r));
}

// 파일의 앞(head)이나 뒤(tail) 일부만 읽어서 줄 배열로 돌려준다.
function readChunk(file, where) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, where === 'head' ? HEAD_BYTES : TAIL_BYTES);
    const start = where === 'head' ? 0 : size - len;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString('utf8');
    if (where === 'tail' && size > len) {
      const nl = text.indexOf('\n'); // 중간에서 잘린 첫 줄은 버린다
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    if (where === 'head' && size > len) {
      const nl = text.lastIndexOf('\n');
      text = nl >= 0 ? text.slice(0, nl) : '';
    }
    return text.split('\n');
  } finally {
    fs.closeSync(fd);
  }
}

function parseLines(lines) {
  const out = [];
  for (const l of lines) {
    if (!l) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      /* 잘린 줄 등은 건너뜀 */
    }
  }
  return out;
}

// 사용자가 직접 보낸 프롬프트인가? (도구 결과도 type:'user' 로 기록되므로 구분한다)
function isPrompt(entry) {
  const c = entry.message && entry.message.content;
  if (typeof c === 'string') return true;
  return Array.isArray(c) && !c.some((b) => b && b.type === 'tool_result');
}

const clipTo = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
// 마크다운 기호를 걷어낸 한 줄
const plain = (l) => l.replace(/^[\s#>*\-•\d.)]+/, '').replace(/[*`_]/g, '').replace(/\s+/g, ' ').trim();
const hasWord = (l) => /[\p{L}\p{N}]/u.test(l);

// 작업 중 요약용: 첫 문장 정도
function summarize(text) {
  const line = String(text).split('\n').map(plain).find(hasWord);
  if (!line) return null;
  const sentence = line.match(/^(.{12,}?[.!?。])(\s|$)/u);
  return clipTo(sentence ? sentence[1] : line, NOTE_MAX);
}

// 완료 표시용: 답변의 첫 줄 (문장 중간에서 끊지 않고 줄 단위)
function firstLine(text) {
  const raw = String(text).split('\n');
  // "## 결과" 같은 제목 줄보다 그 아래 본문 첫 줄이 더 많은 걸 알려준다.
  const body = raw.filter((l) => !/^\s*#/.test(l)).map(plain).find(hasWord);
  const line = body || raw.map(plain).find(hasWord);
  return line ? clipTo(line, ANSWER_MAX) : null;
}

// 마지막 사용자 프롬프트 이후에 Claude가 쓴 가장 최근 텍스트 원문. 없으면 null.
function lastAssistantText(file) {
  if (!isReadable(file)) return null;
  let entries;
  try {
    entries = parseLines(readChunk(file, 'tail'));
  } catch {
    return null;
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || e.isSidechain) continue; // 서브에이전트 내부 대화는 제외
    if (e.type === 'user' && isPrompt(e)) return null; // 이번 턴에는 아직 한 말이 없다
    if (e.type !== 'assistant') continue;
    const c = e.message && e.message.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '';
    if (text && text.trim()) return text;
  }
  return null;
}

// 세션 이름: /rename 한 이름(custom-title)이 자동 제목(ai-title)보다 우선. 기록의 앞/뒤에서 찾는다.
// 대화 기록 옆의 <세션번호>/custom-title.json 에 따로 저장된 이름 (문자열이거나 {customTitle|title|name})
function titleFromSideFile(file) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(file.replace(/\.jsonl$/, ''), 'custom-title.json'), 'utf8'));
    const t = typeof j === 'string' ? j : j && (j.customTitle || j.title || j.name);
    return typeof t === 'string' && t.trim() ? clipTo(t.replace(/\s+/g, ' ').trim(), 40) : null;
  } catch {
    return null;
  }
}

function sessionTitle(file) {
  if (!isReadable(file)) return null;
  const side = titleFromSideFile(file);
  if (side) return side;
  let entries = [];
  try {
    entries = parseLines(readChunk(file, 'head')).concat(parseLines(readChunk(file, 'tail')));
  } catch {
    return null;
  }
  let custom = null;
  let auto = null;
  for (const e of entries) {
    if (!e) continue;
    if (e.type === 'custom-title') custom = e.customTitle || e.title || custom;
    else if (e.type === 'ai-title') auto = e.aiTitle || e.title || auto;
  }
  const t = custom || auto;
  return typeof t === 'string' && t.trim() ? clipTo(t.replace(/\s+/g, ' ').trim(), 40) : null;
}

// 사용자가 Esc 로 중단했는지: 기록의 마지막 대화 항목이 "[Request interrupted by user...]" 이면 true.
// (중단하면 Stop 훅이 오지 않아서, 이걸 보지 않으면 펫이 계속 "작업 중"으로 남는다.)
const interruptCache = new Map(); // file -> { key, result }
function isInterrupted(file) {
  if (!isReadable(file)) return false;
  let key;
  try {
    const st = fs.statSync(file);
    key = `${st.mtimeMs}:${st.size}`;
  } catch {
    return false;
  }
  const hit = interruptCache.get(file);
  if (hit && hit.key === key) return hit.result;
  let result = false;
  try {
    const entries = parseLines(readChunk(file, 'tail'));
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (!e || e.isSidechain || (e.type !== 'user' && e.type !== 'assistant')) continue;
      if (e.type === 'user') {
        const c = e.message && e.message.content;
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && b.text) || '').join(' ') : '';
        result = /\[Request interrupted by user/i.test(text);
      }
      break;
    }
  } catch {
    result = false;
  }
  if (interruptCache.size > 50) interruptCache.clear();
  interruptCache.set(file, { key, result });
  return result;
}

const lastAssistantNote = (file) => {
  const t = lastAssistantText(file);
  return t ? summarize(t) : null;
};

module.exports = { isInterrupted, isReadable, lastAssistantText, lastAssistantNote, sessionTitle, summarize, firstLine };

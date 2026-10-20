// Claude Code 훅 이벤트 -> 펫 상태 + "지금 뭘 하는지" 정보
// 상태: idle | sleep | thinking | working | waiting | done
const path = require('path');
const { lastAssistantText, sessionTitle, summarize, firstLine, isReadable, isInterrupted } = require('./transcript');
const { findDesktopInfo } = require('./session-names');

const PRIORITY = { waiting: 4, working: 3, thinking: 2, done: 1, idle: 0 };
// 이벤트가 끊겨도 영원히 "작업 중"에 머물지 않도록 하는 타임아웃(ms)
// 오래 걸리는 작업(긴 명령, 긴 생각, 서브에이전트)은 중간에 신호가 없어서 넉넉하게 잡는다.
// 중단(Esc)처럼 끝났다는 신호가 없는 경우는 아래 derive 에서 대화 기록으로 따로 알아챈다.
const TIMEOUT = { thinking: 10 * 60 * 1000, working: 30 * 60 * 1000, done: 20000, waiting: 1800000 };
const INTERRUPT_CHECK_AFTER = 15000; // 마지막 신호 후 이만큼 지나면 중단됐는지 확인
const SLEEP_AFTER = 5 * 60 * 1000;
const DROP_AFTER = 6 * 3600 * 1000;

const clip = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
// 앱/IDE가 프롬프트 앞에 붙이는 시스템 문구(<system-reminder> 등)는 제목에서 뺀다.
const INJECTED = /<(system-reminder|ide_[a-z_]+|command-[a-z-]+|local-command-[a-z-]+)>[\s\S]*?<\/\1>/g;
const stripInjected = (s) => String(s).replace(INJECTED, ' ').replace(/<system-reminder>[\s\S]*$/, ' ');
const base = (p) => (typeof p === 'string' && p ? path.basename(p) : '');

// 도구 호출을 사람이 읽을 한 줄로 바꾼다. 예) "수정 · index.html", "명령 · npm test"
function describeTool(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const join = (verb, target) => (target ? `${verb} · ${target}` : verb);
  switch (name) {
    case 'Read':
      return join('읽기', base(i.file_path));
    case 'Edit':
    case 'MultiEdit':
      return join('수정', base(i.file_path));
    case 'Write':
      return join('작성', base(i.file_path));
    case 'NotebookEdit':
      return join('노트북 수정', base(i.notebook_path));
    case 'Bash':
      return join('명령', clip(i.description || i.command, 34));
    case 'Grep':
      return join('검색', clip(i.pattern, 30));
    case 'Glob':
      return join('파일 찾기', clip(i.pattern, 30));
    case 'WebFetch': {
      let host = '';
      try {
        host = new URL(i.url).hostname;
      } catch {
        /* ignore */
      }
      return join('웹 열기', host);
    }
    case 'WebSearch':
      return join('웹 검색', clip(i.query, 30));
    case 'Task':
    case 'Agent':
      return join('서브에이전트', clip(i.description, 28));
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return '할 일 정리';
    default:
      if (typeof name === 'string' && name.startsWith('mcp__')) {
        return clip(name.replace(/^mcp__/, '').replace(/__/g, ' · '), 34);
      }
      return name ? String(name) : '';
  }
}

// Claude Code 알림 문구를 짧은 한국어로 바꾼다. 모르는 문구는 그대로 줄여서 보여준다.
function localizeNotice(msg) {
  const m = String(msg).match(/needs your permission to use (\S+)/i);
  if (m) return `${m[1]} 권한 요청`;
  if (/waiting for your input/i.test(msg)) return '입력을 기다리는 중';
  return clip(msg, 60);
}

// 파일을 만들고 고치는 도구는 "건설" 애니메이션으로 보여준다.
const BUILD_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const SUB_TOOLS = new Set(['Task', 'Agent']);
const SUB_TTL = 15 * 60 * 1000; // 끝났다는 신호를 놓쳐도 영원히 "서브에이전트 중"에 머물지 않게
const ERROR_SHOW = 4000;
const COMPACT_SHOW = 90000;

// 도구 결과가 오류인지 (필드 이름이 버전마다 달라서 후보를 모두 본다)
function isErrorResponse(r) {
  if (!r || typeof r !== 'object') return false;
  return r.is_error === true || r.isError === true || r.success === false || (typeof r.error === 'string' && r.error.length > 0);
}

// 지금 돌고 있는 서브에이전트 수. 두 가지 신호(SubagentStart/Stop, Task 도구 호출) 중 많은 쪽을 쓴다.
function activeSubs(s, t) {
  let n = 0;
  for (const m of [s.subsA, s.subsB]) {
    for (const [k, ts] of m) if (t - ts > SUB_TTL) m.delete(k);
    n = Math.max(n, m.size);
  }
  return n;
}

function animOf(s, st, t) {
  if (st === 'waiting' || st === 'done' || st === 'idle') return st;
  if (s.compactAt && t - s.compactAt < COMPACT_SHOW) return 'sweeping';
  const n = activeSubs(s, t);
  if (n >= 2) return 'juggling';
  if (n === 1) return 'groove';
  if (s.errorAt && t - s.errorAt < ERROR_SHOW) return 'error';
  if (st === 'working') return BUILD_TOOLS.has(s.tool) ? 'building' : 'working';
  return 'thinking';
}

function resetTransient(s) {
  s.subsA.clear();
  s.subsB.clear();
  s.errorAt = 0;
  s.compactAt = 0;
}

// id 가 있으면 그것을, 없으면 가장 오래된 것을 지운다.
function dropOne(m, id) {
  if (id != null && m.delete(String(id))) return;
  const first = m.keys().next();
  if (!first.done) m.delete(first.value);
}

function newSession(t) {
  return {
    state: 'idle',
    tool: null,
    activity: null,
    msg: null,
    cwd: null,
    root: null, // 세션을 시작한 프로젝트 폴더 (작업 중 cd 해도 바뀌지 않는다)
    title: null, // 마지막으로 보낸 프롬프트 요약
    note: null, // Claude가 이번 턴에 마지막으로 한 말을 요약한 한 문장 (작업 중 표시용)
    answer: null, // 끝난 뒤 보여줄 답변의 첫 줄
    name: null, // 세션 이름 (/rename 이름, 자동 제목, 데스크톱 앱 제목)
    nameAt: 0, // 이름을 마지막으로 찾아본 시각 (못 찾았을 때 너무 자주 뒤지지 않도록)
    folder: null, // 데스크톱 앱에서 내가 고른 폴더 이름 (가상 작업 폴더 대신 프로젝트 이름으로 쓴다)
    infoAt: 0, // 앱 저장 정보를 마지막으로 뒤진 시각
    appId: null, // 데스크톱 앱 안에서 이 세션을 여는 ID (local_…)
    waitAt: 0, // "확인 필요" 상태가 시작된 시각 (30초 넘게 응답이 없으면 마우스를 따라다니는 알림에 쓴다)
    turnAt: 0, // 이번 작업(질문 한 번)을 시작한 시각. 오래 걸리는 작업을 간략하게 보여주는 데 쓴다
    transcript: null,
    subsA: new Map(), // Task/Agent 도구 호출 중인 것들 (tool_use_id -> 시작 시각)
    subsB: new Map(), // SubagentStart 로 시작한 것들 (agent_id -> 시작 시각)
    errorAt: 0, // 마지막으로 도구가 실패한 시각
    compactAt: 0, // 대화 정리(compact)를 시작한 시각
    todos: [], // [{id, text, active, status}]
    taskSeq: 0,
    ts: t,
  };
}

// 할 일 목록 갱신: 예전 TodoWrite와 새 TaskCreate/TaskUpdate 둘 다 처리한다.
// (필드 이름이 버전마다 달라질 수 있어서 후보 이름을 모두 받아준다.)
function trackTodos(s, e) {
  const input = e.tool_input && typeof e.tool_input === 'object' ? e.tool_input : {};
  const name = e.tool_name;

  if (name === 'TodoWrite' && Array.isArray(input.todos)) {
    s.todos = input.todos.map((t, idx) => ({
      id: String(idx),
      text: clip(t.content || t.subject || t.title, 60),
      active: clip(t.activeForm, 60),
      status: t.status || 'pending',
    }));
    return;
  }

  if (name === 'TaskCreate') {
    let id = null;
    try {
      const m = JSON.stringify(e.tool_response == null ? '' : e.tool_response).match(/#(\d+)/);
      if (m) id = m[1];
    } catch {
      /* ignore */
    }
    if (!id) id = String(++s.taskSeq);
    s.taskSeq = Math.max(s.taskSeq, Number(id) || 0);
    s.todos.push({
      id,
      text: clip(input.subject || input.title, 60),
      active: clip(input.activeForm, 60),
      status: 'pending',
    });
    return;
  }

  if (name === 'TaskUpdate') {
    const id = String(input.taskId != null ? input.taskId : input.task_id != null ? input.task_id : '');
    const t = s.todos.find((x) => x.id === id);
    if (!t) return;
    if (input.status === 'deleted') {
      s.todos = s.todos.filter((x) => x !== t);
      return;
    }
    if (input.status) t.status = input.status;
    if (input.subject || input.title) t.text = clip(input.subject || input.title, 60);
    if (input.activeForm) t.active = clip(input.activeForm, 60);
  }
}

function progressOf(s) {
  const total = s.todos.length;
  if (!total) return null;
  const done = s.todos.filter((t) => t.status === 'completed').length;
  const cur = s.todos.find((t) => t.status === 'in_progress');
  return { done, total, current: cur ? cur.active || cur.text : null };
}

class Sessions {
  constructor(now = Date.now, deps = {}) {
    this.now = now;
    this.readText = deps.readText || lastAssistantText;
    this.readTitle = deps.readTitle || sessionTitle;
    this.isInterrupted = deps.isInterrupted || isInterrupted;
    this.readDesktopInfo = deps.readDesktopInfo || findDesktopInfo;
    this.diag = {}; // 점검용: 마지막 Stop 이벤트에서 무엇을 받았는지 (내용은 담지 않는다)
    this.map = new Map();
    this.lastActivity = now();
    this.muted = false; // 방해 금지: 모든 이벤트를 무시하고 잠든 모습만 보여준다
  }

  setMuted(v) {
    this.muted = !!v;
    if (!this.muted) this.lastActivity = this.now();
  }

  handle(e) {
    if (!e || typeof e !== 'object') return;
    if (this.muted) return;
    const id = String(e.session_id || 'default');
    const ev = e.hook_event_name;
    const t = this.now();

    if (ev === 'SessionEnd') {
      this.map.delete(id);
      return;
    }

    const s = this.map.get(id) || newSession(t);
    if (typeof e.cwd === 'string') {
      s.cwd = e.cwd;
      if (!s.root || ev === 'SessionStart') s.root = e.cwd;
    }
    if (typeof e.transcript_path === 'string') s.transcript = e.transcript_path;
    const refreshNote = () => {
      const text = this.readText(s.transcript);
      const n = text && summarize(text);
      if (n) s.note = n;
      this.refreshName(s, id);
    };

    switch (ev) {
      case 'SessionStart':
        resetTransient(s);
        s.state = 'idle';
        s.tool = s.activity = s.note = s.answer = null;
        s.todos = [];
        s.taskSeq = 0;
        break;
      case 'UserPromptSubmit': {
        resetTransient(s);
        s.turnAt = t;
        s.state = 'thinking';
        s.tool = s.activity = s.note = s.answer = null; // 지난 턴에 한 말은 지운다
        // 지난 턴의 할 일이 전부 끝났으면 새 턴에서 비운다.
        const p = progressOf(s);
        if (p && p.done === p.total) {
          s.todos = [];
          s.taskSeq = 0;
        }
        const raw = e.prompt != null ? e.prompt : e.prompt_text;
        const text = typeof raw === 'string' ? stripInjected(raw) : '';
        if (text.trim()) s.title = clip(text, 40);
        break;
      }
      case 'PreToolUse':
        s.state = 'working';
        s.compactAt = 0;
        s.tool = typeof e.tool_name === 'string' ? e.tool_name : null;
        if (SUB_TOOLS.has(e.tool_name)) s.subsA.set(String(e.tool_use_id || `${t}-${s.subsA.size}`), t);
        s.activity = describeTool(e.tool_name, e.tool_input) || null;
        refreshNote();
        break;
      case 'PostToolUse':
        s.state = 'thinking';
        s.compactAt = 0;
        if (SUB_TOOLS.has(e.tool_name)) dropOne(s.subsA, e.tool_use_id);
        if (isErrorResponse(e.tool_response)) s.errorAt = t;
        trackTodos(s, e);
        refreshNote();
        break;
      case 'PostToolUseFailure':
        s.state = 'thinking';
        s.compactAt = 0;
        if (SUB_TOOLS.has(e.tool_name)) dropOne(s.subsA, e.tool_use_id);
        if (!e.is_interrupt) s.errorAt = t; // 내가 직접 끊은 건 오류가 아니다
        break;
      case 'SubagentStart':
        s.subsB.set(String(e.agent_id || e.subagent_id || `${t}-${s.subsB.size}`), t);
        if (s.state === 'idle' || s.state === 'done') s.state = 'working';
        break;
      case 'SubagentStop':
        dropOne(s.subsB, e.agent_id || e.subagent_id);
        break;
      case 'PreCompact':
        s.state = 'thinking';
        s.compactAt = t;
        break;
      case 'PermissionRequest': {
        // 허용 요청 화면이 뜨는 순간. 훅은 아무것도 돌려주지 않으니 허용/거부는 평소처럼 Claude 앱에서 한다.
        s.state = 'waiting';
        const what = describeTool(e.tool_name, e.tool_input);
        s.msg = what ? `허용 필요 · ${what}` : '허용이 필요해요';
        break;
      }
      case 'Notification':
        if (e.notification_type === 'idle_prompt') {
          s.state = 'idle';
        } else {
          s.state = 'waiting';
          s.msg = typeof e.message === 'string' ? localizeNotice(e.message) : null;
        }
        break;
      case 'Stop':
        resetTransient(s);
        s.state = 'done';
        s.tool = s.activity = null;
        // 답변 첫 줄: 훅이 마지막 메시지를 직접 주면 그걸 쓰고, 아니면 대화 기록에서 읽는다.
        s.answer = firstLine(typeof e.last_assistant_message === 'string' ? e.last_assistant_message : '') || s.answer;
        refreshNote();
        if (!s.answer) {
          const text = this.readText(s.transcript);
          s.answer = (text && firstLine(text)) || null;
        }
        this.diag.stop = {
          keys: Object.keys(e).sort(),
          transcriptPath: typeof e.transcript_path === 'string',
          readable: isReadable(e.transcript_path),
          lastMessage: typeof e.last_assistant_message === 'string',
          answerFound: !!s.answer,
          nameFound: !!s.name,
        };
        break;
      default:
        return; // 모르는 이벤트는 무시
    }

    // 작업 시작 시각: 일하는 상태가 되면 기록하고, 쉬거나 끝나면 지운다. (펫을 중간에 켰어도 이때부터 센다)
    if (s.state === 'thinking' || s.state === 'working') {
      if (!s.turnAt) s.turnAt = t;
    } else if (s.state !== 'waiting') {
      s.turnAt = 0;
    }
    // 확인 필요 시작 시각: 처음 waiting 이 된 때만 기록하고, 다른 상태가 되면 지운다
    if (s.state === 'waiting') {
      if (!s.waitAt) s.waitAt = t;
    } else {
      s.waitAt = 0;
    }
    s.ts = t;
    this.map.set(id, s);
    this.lastActivity = t;
  }

  // 세션 이름 찾기: 대화 기록의 제목 → 데스크톱 앱이 저장한 제목. 못 찾으면 30초 뒤에 다시 시도한다.
  refreshName(s, id) {
    const t = this.now();
    if (s.name && t - s.nameAt < 5 * 60 * 1000) return;
    if (!s.name && t - s.nameAt < 30000) return;
    s.nameAt = t;
    const fromTranscript = this.readTitle(s.transcript);
    // 앱 저장 폴더를 뒤지는 건 무거워서 5분에 한 번만 찾는다. (터미널 세션은 계속 못 찾으니 특히)
    let info = null;
    if ((!fromTranscript || !s.folder || !s.appId) && (s.infoAt === 0 || t - s.infoAt > 5 * 60 * 1000)) {
      s.infoAt = t;
      info = this.readDesktopInfo(id);
    }
    s.name = fromTranscript || (info && info.title) || s.name;
    if (info && info.folder) s.folder = info.folder;
    if (info && info.appId) s.appId = info.appId;
  }

  // Stop 직후에는 대화 기록에 마지막 답변이 아직 안 써졌을 수 있어서, 잠시 뒤 다시 읽어본다.
  // 바뀐 게 있으면 true.
  refreshLate(id) {
    const s = this.map.get(String(id));
    if (!s || s.state !== 'done') return false;
    const text = this.readText(s.transcript);
    const a = text && firstLine(text);
    if (!a || a === s.answer) return false;
    s.answer = a;
    return true;
  }

  derive() {
    const t = this.now();
    const list = [];

    for (const [id, s] of this.map) {
      if (t - s.ts > DROP_AFTER) {
        this.map.delete(id);
        continue;
      }
      let st = s.state;
      if ((st === 'thinking' || st === 'working') && s.transcript && t - s.ts > INTERRUPT_CHECK_AFTER && this.isInterrupted(s.transcript)) {
        // Esc 로 중단함: Stop 훅이 오지 않으니 직접 쉬는 중으로 돌린다.
        s.state = st = 'idle';
        s.tool = s.activity = null;
        s.turnAt = 0;
        resetTransient(s);
      }
      const to = TIMEOUT[st];
      if (to && t - s.ts > to) st = 'idle';
      list.push({ s, st });
    }

    const rank = (a, b) => PRIORITY[b.st] - PRIORITY[a.st] || b.s.ts - a.s.ts;
    list.sort(rank);
    const best = list[0] || null;
    const isActive = (x) => x.st === 'working' || x.st === 'thinking' || x.st === 'waiting';

    let state = best ? best.st : 'idle';
    if (state === 'idle' && t - this.lastActivity > SLEEP_AFTER) state = 'sleep';

    const waiting = list.filter((x) => x.st === 'waiting');
    const s = best && best.s;
    if (this.muted) {
      return { state: 'sleep', anim: 'sleep', dnd: true, project: null, name: null, title: null, note: null, answer: null, activity: null, msg: null, progress: null, sessions: 0, active: 0, others: [], subagents: 0, waitSince: 0, waitCount: 0 };
    }
    const labelOf = (x) => x.name || projectOf(x);
    // 프로젝트 이름: 앱에서 고른 폴더 > 작업 폴더 이름. 가상 작업 폴더(/sessions/…)나 임시 폴더(scratch-날짜-…)는 의미가 없어서 뺀다.
    const projectOf = (x) => {
      if (x.folder) return x.folder;
      const dir = x.root || x.cwd;
      if (!dir || dir.startsWith('/sessions/')) return null;
      const b = path.basename(dir);
      return /^scratch-\d{4}-\d{2}-\d{2}-\w+$/.test(b) ? null : b;
    };
    // 동시에 돌아가는 다른 세션들: 어느 프로젝트에서 뭘 하는지 한 줄씩
    const others = list
      .slice(1)
      .filter(isActive)
      .slice(0, 3)
      .map((x) => ({
        state: x.st,
        project: labelOf(x.s),
        appId: x.s.appId || null,
        text: (x.st === 'waiting' ? x.s.msg : x.s.activity) || x.s.note || x.s.title || null,
      }));

    return {
      state,
      waitSince: waiting.length ? Math.min(...waiting.map((x) => x.s.waitAt || t)) : 0, // 가장 오래 기다린 확인 요청의 시작 시각
      waitCount: waiting.length,
      since: best && (best.st === 'thinking' || best.st === 'working') ? best.s.turnAt || 0 : 0,
      anim: best ? (state === 'sleep' ? 'sleep' : animOf(best.s, best.st, t)) : state,
      subagents: best ? activeSubs(best.s, t) : 0,
      project: s ? projectOf(s) : null,
      name: (s && s.name) || null,
      appId: (s && s.appId) || null,
      answer: (s && s.answer) || null,
      title: (s && s.title) || null,
      note: (s && s.note) || null,
      activity: s && (state === 'working' || state === 'waiting') ? s.activity : null,
      msg: s && state === 'waiting' ? s.msg : null,
      progress: s ? progressOf(s) : null,
      sessions: this.map.size,
      active: list.filter(isActive).length,
      others,
    };
  }
}

module.exports = { Sessions, describeTool };

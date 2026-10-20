// Claude Code 상태줄(statusLine) JSON의 rate_limits를 보관한다.
//   rate_limits.five_hour / seven_day = { used_percentage, resets_at(epoch 초) }
// claude.ai Pro/Max 구독자에게만, 세션의 첫 API 응답 이후에 들어온다.
const fs = require('fs');
const path = require('path');

function pick(w) {
  if (!w || typeof w !== 'object') return null;
  const pct = Number(w.used_percentage);
  const resetsAt = Number(w.resets_at);
  if (!Number.isFinite(pct)) return null;
  return { pct: Math.max(0, Math.min(100, pct)), resetsAt: Number.isFinite(resetsAt) ? resetsAt : 0 };
}

class Limits {
  constructor(file, now = Date.now) {
    this.file = file;
    this.now = now;
    this.data = { fiveHour: null, sevenDay: null, updatedAt: 0 };
    // 진단용: 이번 실행 중 상태줄 신호를 받은 적 있는지, 그 안에 rate_limits가 있었는지
    this.seen = false;
    this.hasRl = false;
    this.rlAt = 0; // 상태줄에서 rate_limits 를 마지막으로 받은 시각(ms)
    this.apiOn = false; // 로그인 정보 조회 사용 여부
    this.apiErr = null; // 마지막 조회 실패 이유
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data = {
        fiveHour: pick({ used_percentage: j.fiveHour && j.fiveHour.pct, resets_at: j.fiveHour && j.fiveHour.resetsAt }),
        sevenDay: pick({ used_percentage: j.sevenDay && j.sevenDay.pct, resets_at: j.sevenDay && j.sevenDay.resetsAt }),
        updatedAt: Number(j.updatedAt) || 0,
      };
    } catch {
      /* 처음이거나 깨진 파일: 비어 있는 상태로 시작 */
    }
  }

  // 상태줄 입력 JSON 전체를 받는다. rate_limits가 없으면 무시한다.
  update(statusJson) {
    const rl = statusJson && statusJson.rate_limits;
    const had = !!rl && typeof rl === 'object';
    const changed = !this.seen || this.hasRl !== had;
    this.seen = true;
    this.hasRl = had;
    if (!had) return changed;
    // rate_limits가 있는데 한쪽 창만 없으면, 그 창은 이미 리셋돼서 빠진 것이다.
    this.rlAt = this.now();
    this.data = {
      fiveHour: pick(rl.five_hour),
      sevenDay: pick(rl.seven_day),
      updatedAt: this.now(),
    };
    this.persist();
    return true;
  }

  persist() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data));
    } catch {
      /* 저장 실패는 무시 */
    }
  }

  // 상태줄 값이 최근(15분 이내)에 왔으면 그쪽이 더 정확하니 조회를 건너뛴다.
  statuslineFresh() {
    return this.hasRl && this.now() - this.rlAt < 15 * 60 * 1000;
  }

  // 로그인 정보 조회 결과 ({five_hour, seven_day}: usage-api.js 의 parseUsage 모양)
  updateFromApi(r) {
    this.apiErr = null;
    this.data = { fiveHour: pick(r.five_hour), sevenDay: pick(r.seven_day), updatedAt: this.now() };
    this.persist();
  }

  setApiError(code) {
    this.apiErr = code;
  }

  // 값이 비어 있을 때 화면에 띄울 짧은 이유
  hint() {
    const API = { nocred: '로그인 정보 없음', expired: '로그인 만료 · Claude 실행 필요', auth: '인증 실패', http: '조회 실패', net: '조회 실패', shape: '조회 실패', timeout: '조회 시간 초과', crash: '조회 오류', refreshing: '로그인 갱신 중…' };
    if (this.apiOn && this.apiErr) return API[this.apiErr] || '조회 실패';
    if (this.seen && !this.hasRl) return '한도 정보 없음';
    return this.apiOn ? '조회 중…' : '상태줄 신호 없음';
  }

  // 리셋 시각이 지난 창은 오래된 값이므로 null로 돌려준다.
  get() {
    const t = this.now();
    const live = (w) => (w && (!w.resetsAt || w.resetsAt * 1000 > t) ? { pct: w.pct, resetsAt: w.resetsAt } : null);
    return {
      fiveHour: live(this.data.fiveHour),
      sevenDay: live(this.data.sevenDay),
      seen: this.seen,
      hasRl: this.hasRl,
      hint: this.hint(),
      err: this.apiErr, // 마지막 조회 실패 이유
    };
  }
}

module.exports = { Limits };

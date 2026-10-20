// 미니 모드(화면 가장자리에 숨기)의 위치 계산. 모니터가 여러 개일 때 "바깥쪽" 가장자리에만 숨는다.
// 다른 모니터와 붙어 있는 이음새로 밀어내면 펫이 옆 모니터에 비쳐 보이기 때문이다.
// 가장자리는 위/아래/왼쪽/오른쪽 네 곳이고, 가장 가까운 곳에 숨는다.
// 화면 목록을 받아 계산만 하는 순수 함수라서 Electron 없이 시험할 수 있다.
const W = 260; // 창 폭
const PET_L = 100; // 창 안에서 펫이 차지하는 범위
const PET_R = 160;
const PET_T = 173;
const PET_B = 228;
const BLOCK_B = 271; // 펫 + 사용량 막대 묶음의 아래쪽
const SHOW = 25; // 숨었을 때 보이는 펫 폭
const MARGIN = 6; // 튀어나왔을 때 가장자리와의 간격
const SIDES = ['left', 'right', 'top', 'bottom'];
const CENTER_Y = 200; // 창 안에서 펫 가운데 높이

// 점에서 가장 가까운 모니터 (점이 모니터 밖에 있어도 가장 가까운 쪽)
function nearestDisplay(displays, x, y) {
  let best = null;
  let bestD = Infinity;
  for (const d of displays) {
    const b = d.bounds;
    const dx = Math.max(b.x - x, 0, x - (b.x + b.width));
    const dy = Math.max(b.y - y, 0, y - (b.y + b.height));
    const dist = dx * dx + dy * dy;
    if (dist < bestD) {
      bestD = dist;
      best = d;
    }
  }
  return best;
}

// side 쪽에 붙어 있는 다른 모니터가 없으면 바깥쪽 가장자리다.
function edgeFree(displays, d, side) {
  const b = d.bounds;
  return !displays.some((o) => {
    if (o.id === d.id) return false;
    const ob = o.bounds;
    const overlapY = ob.y < b.y + b.height && ob.y + ob.height > b.y;
    const overlapX = ob.x < b.x + b.width && ob.x + ob.width > b.x;
    if (side === 'left') return Math.abs(ob.x + ob.width - b.x) <= 2 && overlapY;
    if (side === 'right') return Math.abs(ob.x - (b.x + b.width)) <= 2 && overlapY;
    if (side === 'top') return Math.abs(ob.y + ob.height - b.y) <= 2 && overlapX;
    return Math.abs(ob.y - (b.y + b.height)) <= 2 && overlapX; // bottom
  });
}

// 펫 가운데 (cx, cy) 에서 각 가장자리까지의 거리
function distances(d, cx, cy) {
  const wa = d.workArea;
  return { left: cx - wa.x, right: wa.x + wa.width - cx, top: cy - wa.y, bottom: wa.y + wa.height - cy };
}

// 가장 가까운 바깥쪽 가장자리 (거리 제한 없음, 메뉴에서 켤 때). 없으면 null.
function pickSide(displays, d, cx, cy) {
  const dist = distances(d, cx, cy);
  const c = SIDES.filter((s) => edgeFree(displays, d, s)).sort((a, b) => dist[a] - dist[b]);
  return c.length ? c[0] : null;
}

// 드래그를 놓은 위치가 바깥쪽 가장자리에 충분히 가까우면 그 side, 아니면 null.
// 위/아래는 펫이 가장자리에 닿았을 때만(40/80px), 좌우는 70px. (위쪽에 그냥 놓아두고 싶을 때가 있어서 좁게 잡는다)
const NEAR = { left: 70, right: 70, top: 40, bottom: 80 };
function sideNear(displays, d, cx, cy) {
  const dist = distances(d, cx, cy);
  const c = SIDES.filter((s) => edgeFree(displays, d, s) && dist[s] < NEAR[s]).sort((a, b) => dist[a] - dist[b]);
  return c.length ? c[0] : null;
}

// 창의 목표 위치. mode: hidden(숨음) | peek(튀어나옴) | rest(미니 모드를 끌 때 돌아갈 곳). b 는 지금 창 위치.
function target(d, side, mode, b) {
  const wa = d.workArea;
  const right = wa.x + wa.width;
  const bottom = wa.y + wa.height;
  let x = b.x;
  let y = b.y;
  if (side === 'left') x = { hidden: wa.x + SHOW - PET_R, peek: wa.x + MARGIN - PET_L, rest: wa.x + 24 }[mode];
  else if (side === 'right') x = { hidden: right - (PET_L + SHOW), peek: right - PET_R - MARGIN, rest: right - W - 24 }[mode];
  else if (side === 'top') y = { hidden: wa.y + SHOW - PET_B, peek: wa.y + MARGIN - PET_T, rest: wa.y + 48 - PET_T }[mode];
  else y = { hidden: bottom - SHOW - PET_T, peek: bottom - MARGIN - BLOCK_B, rest: bottom - 24 - BLOCK_B }[mode];
  return { x, y };
}

// 마우스가 펫(보이는 부분) 위에 있는지: 펫 사각형을 10px 넓히고, 모니터 작업 영역 안에 있을 때만
function overPet(d, b, c) {
  const wa = d.workArea;
  const inScreen = c.x >= wa.x && c.x <= wa.x + wa.width && c.y >= wa.y && c.y <= wa.y + wa.height;
  return inScreen && c.x >= b.x + PET_L - 10 && c.x <= b.x + PET_R + 10 && c.y >= b.y + PET_T - 10 && c.y <= b.y + PET_B + 10;
}

module.exports = { nearestDisplay, edgeFree, pickSide, sideNear, target, overPet, CENTER_Y, SIDES };

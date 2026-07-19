// meter.js — 병산 요금 엔진 (DOM/브라우저 API를 모르는 순수 로직)
// 모든 계산은 timestamp(ms) 차이 기반. setInterval 카운팅 금지.

export const GPS_STALE_MS = 10000;   // 10초간 fix 없으면 시간 모드 강제
export const ACCURACY_MAX_M = 50;    // 이보다 부정확한 fix 폐기
export const SPEED_MAX_KMH = 150;    // 속도 스파이크 폐기
export const MULTIPLIER_CAP = 3.0;   // 할증 배율 곱 상한
const MOVE_MIN_FLOOR_M = 15;         // 앵커에서 이만큼 벗어나야 이동으로 집계
const STALL_SPEED_MS = 8000;         // 앵커 근처에 이 시간 이상 머물면 속도 0으로 감쇠
const STALL_REANCHOR_MS = 45000;     // 장기 정지 시 앵커 재설정 (드리프트 누적 상한)
const EMA_ALPHA = 0.4;

// 병산 임계속도: distUnitM / timeUnitSec 가 두 요율이 같아지는 속도
export function thresholdKmh(meterCfg) {
  return (meterCfg.distUnitM / meterCfg.timeUnitSec) * 3.6;
}

export function haversine(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// ── 운행 생명주기 ──────────────────────────────────────────────

export function createRide(settings, now) {
  return {
    schemaVersion: 1,
    status: 'running',
    startedAt: now,
    endedAt: null,
    chargedMsEquiv: 0,   // 할증 반영된 환산 충전 시간(ms) — 보상 계산의 유일한 근거
    totalDistM: 0,       // 표시용 실제 이동거리
    distChargedM: 0,     // 거리 모드로 적립된 거리 (영수증 내역용)
    timeChargedMs: 0,    // 시간 모드로 적립된 시간 (영수증 내역용)
    lastChargeT: now,    // 과금 커서 — 이중과금 방지의 핵심
    lastFix: null,       // {lat, lng, t, accuracy}
    currentSpeedKmh: 0,  // EMA 스무딩된 속도
    spikeCount: 0,       // 연속 스파이크 거부 횟수 (3회면 텔레포트로 보고 재앵커)
    chargeMode: 'time',  // 'time' | 'dist' (표시용)
    manualOn: {},        // 수동 할증 on/off {id: bool}
    surchargeLog: [],    // [{id, name, multiplier, from, to|null}]
    fareSnapshot: JSON.parse(JSON.stringify(settings)), // 시작 시점 설정 동결
  };
}

// 1초마다 호출 (백그라운드에서 밀려도 dt로 정확히 보정됨)
export function tick(state, now) {
  if (state.status !== 'running') return;
  const dt = now - state.lastChargeT;
  if (dt <= 0) return;

  const gpsStale = !state.lastFix || now - state.lastFix.t > GPS_STALE_MS;
  if (gpsStale) state.currentSpeedKmh = 0;

  const { multiplier, active } = evaluateSurcharges(state, now);
  updateSurchargeLog(state, active, now);

  if (gpsStale || state.currentSpeedKmh < thresholdKmh(state.fareSnapshot.meter)) {
    // 시간 모드: 정차·저속·GPS 없음 구간은 시간으로 과금
    state.timeChargedMs += dt;
    state.chargedMsEquiv += dt * multiplier;
    state.chargeMode = 'time';
  } else {
    // 거리 모드: 시간은 과금하지 않음 (거리가 applyFix에서 과금됨)
    state.chargeMode = 'dist';
  }
  state.lastChargeT = now;
}

// GPS fix 도착 시 호출. 반환값 {accepted, reason}는 디버그 패널용.
// lastFix는 "앵커"(마지막 집계 지점) — 앵커에서 충분히 벗어날 때까지 이동을 누적 관찰한다.
// 매 fix마다 앵커를 갱신하면 1초당 이동량이 필터 기준보다 작은 저·중속 주행이 전부 정지로
// 판정되므로(30km/h = 8.3m/s), 집계된 이동 시점에만 앵커를 옮긴다.
export function applyFix(state, fix) {
  if (state.status !== 'running') return { accepted: false, reason: 'not-running' };
  if (fix.accuracy > ACCURACY_MAX_M) return { accepted: false, reason: `accuracy ${Math.round(fix.accuracy)}m` };
  if (!state.lastFix) {
    state.lastFix = fix;
    return { accepted: true, reason: 'baseline' };
  }
  const dtFix = fix.t - state.lastFix.t;
  if (dtFix <= 0) return { accepted: false, reason: 'time-regress' };

  const d = haversine(state.lastFix, fix);
  const vKmh = (d / (dtFix / 1000)) * 3.6;
  if (vKmh > SPEED_MAX_KMH) {
    // 연속 3회 스파이크면 실제 위치가 순간이동한 것(콜드스타트·장기 백그라운드 복귀).
    // 거리 미집계로 재앵커해서 자가 회복 — 안 하면 이후 모든 fix가 영원히 거부된다.
    state.spikeCount = (state.spikeCount || 0) + 1;
    if (state.spikeCount >= 3) {
      state.lastFix = fix;
      state.spikeCount = 0;
      state.currentSpeedKmh = 0;
      return { accepted: true, reason: 'teleport re-anchor' };
    }
    return { accepted: false, reason: `spike ${Math.round(vKmh)}km/h` };
  }
  state.spikeCount = 0;

  if (d < Math.max(fix.accuracy * 1.5, MOVE_MIN_FLOOR_M)) {
    // 앵커 오차 반경 내 — 아직 이동으로 볼 수 없음. 앵커 유지한 채 관찰만.
    if (dtFix > STALL_SPEED_MS) state.currentSpeedKmh = ema(state.currentSpeedKmh, 0);
    if (dtFix > STALL_REANCHOR_MS) state.lastFix = fix; // 진짜 정지 — 드리프트 누적 차단
    return { accepted: true, reason: `stationary d=${Math.round(d)}m` };
  }

  state.totalDistM += d;
  state.currentSpeedKmh = ema(state.currentSpeedKmh, vKmh);

  // 거리 과금은 연속적인 GPS 신호일 때만 — 긴 공백(dtFix > stale) 구간은 이미
  // tick이 시간요금으로 정산했으므로 거리로 또 과금하면 이중과금이 된다.
  if (dtFix <= GPS_STALE_MS && state.currentSpeedKmh >= thresholdKmh(state.fareSnapshot.meter)) {
    const { multiplier, active } = evaluateSurcharges(state, fix.t);
    updateSurchargeLog(state, active, fix.t);
    const { timeUnitSec, distUnitM } = state.fareSnapshot.meter;
    state.distChargedM += d;
    state.chargedMsEquiv += (d / distUnitM) * timeUnitSec * 1000 * multiplier;
    // 이 구간의 시간이 다시 과금되지 않도록 커서 전진
    state.lastChargeT = Math.max(state.lastChargeT, fix.t);
    state.lastFix = fix;
    return { accepted: true, reason: `dist +${Math.round(d)}m` };
  }
  state.lastFix = fix;
  return { accepted: true, reason: `move +${Math.round(d)}m (저속)` };
}

export function finishRide(state, now) {
  tick(state, now); // 마지막 구간 정산
  updateSurchargeLog(state, [], now); // 열린 할증 구간 닫기
  state.status = 'finished';
  state.endedAt = now;
  return buildRecord(state);
}

// ── 할증 ──────────────────────────────────────────────────────

export function evaluateSurcharges(state, t) {
  let multiplier = 1;
  const active = [];
  for (const s of state.fareSnapshot.surcharges || []) {
    if (!s.enabled) continue;
    let on = false;
    if (s.mode === 'manual') on = !!state.manualOn[s.id];
    else if (s.mode === 'auto-night') on = inTimeWindow(t, s.config?.from || '22:00', s.config?.to || '04:00');
    else if (s.mode === 'auto-weekend') on = [0, 6].includes(new Date(t).getDay());
    else if (s.mode === 'auto-date') on = (s.config?.dates || []).includes(mmdd(t));
    if (on) {
      multiplier *= s.multiplier;
      active.push(s);
    }
  }
  return { multiplier: Math.min(multiplier, MULTIPLIER_CAP), active };
}

function updateSurchargeLog(state, active, t) {
  const open = state.surchargeLog.filter((e) => e.to === null);
  const activeIds = new Set(active.map((s) => s.id));
  for (const e of open) if (!activeIds.has(e.id)) e.to = t;
  const openIds = new Set(open.filter((e) => e.to === null).map((e) => e.id));
  for (const s of active) {
    if (!openIds.has(s.id)) {
      state.surchargeLog.push({ id: s.id, name: s.name, multiplier: s.multiplier, from: t, to: null });
    }
  }
}

function inTimeWindow(t, from, to) {
  const d = new Date(t);
  const cur = d.getHours() * 60 + d.getMinutes();
  const [fh, fm] = from.split(':').map(Number);
  const [th, tm] = to.split(':').map(Number);
  const f = fh * 60 + fm;
  const e = th * 60 + tm;
  return f <= e ? cur >= f && cur < e : cur >= f || cur < e; // 자정 넘는 창 지원
}

function mmdd(t) {
  const d = new Date(t);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── 보상 파생 계산 (누적하지 않고 항상 chargedMsEquiv에서 계산) ──

export function computeRewards(state) {
  const snap = state.fareSnapshot;
  const map = new Map();
  for (const item of snap.fareTable.items) {
    map.set(item.id, { id: item.id, name: item.name, emoji: item.emoji, qty: 0 });
  }
  for (const b of snap.fareTable.baseRewards || []) {
    const r = map.get(b.itemId);
    if (r) r.qty += b.qty; // 기본요금: 탑승 즉시 적립
  }
  for (const item of snap.fareTable.items) {
    const unitMs = item.perMinutes * 60000;
    if (unitMs <= 0) continue;
    map.get(item.id).qty += Math.floor(state.chargedMsEquiv / unitMs) * item.qtyPerUnit;
  }
  return [...map.values()];
}

// 다음 보상까지 진행률 — 가장 임박한 항목 반환 {item, progress 0..1, remainMs}
export function nextReward(state) {
  let best = null;
  for (const item of state.fareSnapshot.fareTable.items) {
    const unitMs = item.perMinutes * 60000;
    if (unitMs <= 0) continue;
    const frac = (state.chargedMsEquiv % unitMs) / unitMs;
    const remainMs = unitMs - (state.chargedMsEquiv % unitMs);
    if (!best || remainMs < best.remainMs) best = { item, progress: frac, remainMs };
  }
  return best;
}

// ── 영수증 레코드 ─────────────────────────────────────────────

export function buildRecord(state) {
  return {
    id: `r_${state.startedAt}`,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    elapsedMs: state.endedAt - state.startedAt,
    totalDistM: state.totalDistM,
    timeChargedMs: state.timeChargedMs,
    distChargedM: state.distChargedM,
    chargedMsEquiv: state.chargedMsEquiv,
    rewards: computeRewards(state).filter((r) => r.qty > 0),
    surchargeLog: state.surchargeLog,
    coupleNames: state.fareSnapshot.coupleNames || [],
  };
}

function ema(prev, next) {
  return prev * (1 - EMA_ALPHA) + next * EMA_ALPHA;
}

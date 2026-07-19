// app.js — 엔트리: 배선, 화면 전환, 운행 생명주기, 복구
import * as meter from './meter.js';
import * as gps from './gps.js';
import * as store from './storage.js';
import * as wakelock from './wakelock.js';
import * as ui from './ui.js';

const HOLD_MS = 800;          // 운행 종료 길게 누르기
const SAVE_EVERY_MS = 5000;   // activeRide 저장 주기
const RECOVERY_GAP_MS = 10 * 60 * 1000;

let settings = store.loadSettings();
let ride = null;              // 진행 중 meterState (없으면 idle)
let tickTimer = null;
let lastSaveT = 0;
let suppressClickUntil = 0;
const issues = new Map();     // 배너 메시지 {key: msg}
const debugLog = [];
const DEBUG = new URLSearchParams(location.search).get('debug') === '1';

// ── 배너/상태 ──

function setIssue(key, msg) {
  if (msg) issues.set(key, msg);
  else issues.delete(key);
  ui.showBanner([...issues.values()].join('\n'));
}

function dlog(msg) {
  if (!DEBUG) return;
  debugLog.unshift(`${new Date().toLocaleTimeString()} ${msg}`);
  debugLog.length = Math.min(debugLog.length, 14);
  const panel = document.getElementById('debug-panel');
  panel.classList.remove('hidden');
  const s = ride;
  panel.textContent =
    (s ? `mode=${s.chargeMode} v=${s.currentSpeedKmh.toFixed(1)}km/h equiv=${Math.round(s.chargedMsEquiv / 1000)}s ` +
         `timeC=${Math.round(s.timeChargedMs / 1000)}s distC=${Math.round(s.distChargedM)}m total=${Math.round(s.totalDistM)}m\n`
       : 'idle\n') + debugLog.join('\n');
}

// ── 운행 생명주기 ──

function startRide() {
  settings = store.loadSettings();
  ride = meter.createRide(settings, Date.now());
  store.saveActiveRide(ride);
  beginRunning();
}

function beginRunning() {
  gps.start(onFix, onGpsStatus);
  wakelock.request(onWakeStatus);
  if (!gps.isSupported() && !gps.isMock()) onGpsStatus('unavailable');
  tickTimer = setInterval(loop, 1000);
  ui.renderMeterRunning(ride, Date.now());
  ui.renderManualChips(ride, toggleManual);
  ui.setRideHint('운행 중에는 화면을 켜두는 게 정확해요');
  ui.showScreen('meter');
  loop();
}

function loop() {
  if (!ride || ride.status !== 'running') return;
  const now = Date.now();
  meter.tick(ride, now);
  ui.renderMeterRunning(ride, now);
  if (now - lastSaveT > SAVE_EVERY_MS) {
    store.saveActiveRide(ride);
    lastSaveT = now;
  }
}

function endRide(at) {
  if (!ride) return;
  const record = meter.finishRide(ride, at ?? Date.now());
  store.addHistory(record);
  store.clearActiveRide();
  stopRunning();
  ui.renderReceipt(record);
  setupShareButton(record);
  ui.showScreen('receipt');
}

function stopRunning() {
  ride = null;
  clearInterval(tickTimer);
  tickTimer = null;
  gps.stop();
  wakelock.release();
  setIssue('gps', null);
  setIssue('wake', null);
  ui.setDot('dot-gps', 'off');
  ui.setDot('dot-wake', 'off');
  ui.renderMeterIdle(settings);
}

function toggleManual(id) {
  if (!ride) return;
  meter.tick(ride, Date.now()); // 이전 구간을 기존 배율로 정산한 뒤 전환
  ride.manualOn[id] = !ride.manualOn[id];
  ui.renderManualChips(ride, toggleManual);
  loop();
}

// ── GPS / WakeLock 콜백 ──

function onFix(fix) {
  if (!ride) return;
  const result = meter.applyFix(ride, fix);
  dlog(`fix acc=${Math.round(fix.accuracy)}m → ${result.accepted ? 'OK' : 'DROP'} (${result.reason})`);
}

function onGpsStatus(status) {
  if (status === 'active') {
    ui.setDot('dot-gps', 'on');
    setIssue('gps', null);
  } else if (status === 'denied') {
    ui.setDot('dot-gps', 'err');
    setIssue('gps', '📡 위치 권한이 거부됐어요 — 시간 모드로만 적립돼요 (거리 없이도 잘 작동해요!)');
  } else if (status === 'unavailable') {
    ui.setDot('dot-gps', 'err');
    setIssue('gps', '📡 GPS를 사용할 수 없어요 — 시간 모드로 운행해요');
  } else {
    ui.setDot('dot-gps', 'off');
  }
}

function onWakeStatus(state) {
  if (state === 'on') {
    ui.setDot('dot-wake', 'on');
    setIssue('wake', null);
  } else if (state === 'unsupported') {
    ui.setDot('dot-wake', 'err');
    setIssue('wake', "☀️ 이 브라우저는 화면 꺼짐 방지를 지원하지 않아요. 휴대폰 설정에서 화면 자동 잠금을 '안 함'으로 바꿔주세요");
  } else {
    ui.setDot('dot-wake', 'off');
  }
}

// ── 탑승 버튼: 클릭=시작, 길게 누르기=종료 ──

function bindRideButton() {
  const btn = document.getElementById('btn-ride');
  let holdTimer = null;
  let holdStart = 0;
  let raf = null;

  const fill = () => btn.querySelector('.hold-fill');

  const cancelHold = () => {
    clearTimeout(holdTimer);
    holdTimer = null;
    cancelAnimationFrame(raf);
    const f = fill();
    if (f) f.style.width = '0%';
  };

  btn.addEventListener('pointerdown', () => {
    if (!ride) return;
    holdStart = Date.now();
    const animate = () => {
      const f = fill();
      if (f) f.style.width = `${Math.min(100, ((Date.now() - holdStart) / HOLD_MS) * 100)}%`;
      raf = requestAnimationFrame(animate);
    };
    animate();
    holdTimer = setTimeout(() => {
      cancelHold();
      suppressClickUntil = Date.now() + 500;
      endRide();
    }, HOLD_MS);
  });
  btn.addEventListener('pointerup', cancelHold);
  btn.addEventListener('pointerleave', cancelHold);
  btn.addEventListener('pointercancel', cancelHold);

  btn.addEventListener('click', () => {
    if (Date.now() < suppressClickUntil) return;
    if (ride) {
      ui.setRideHint('종료하려면 버튼을 꾹~ 길게 눌러주세요 (0.8초)');
      return;
    }
    startRide();
  });
}

// ── 복구 ──

function checkRecovery() {
  const saved = store.loadActiveRide();
  if (!saved) return;
  const gap = Date.now() - saved.lastChargeT;
  const gapText = ui.fmtDuration(Math.max(60000, gap));
  const startText = `${ui.fmtDate(saved.startedAt)} ${ui.fmtClock(saved.startedAt)}`;

  const resume = (excludeGap) => {
    ride = saved;
    if (excludeGap) ride.lastChargeT = Date.now();
    beginRunning();
  };
  const endAtThen = () => {
    ride = saved;
    endRide(saved.lastChargeT);
  };

  if (gap < RECOVERY_GAP_MS) {
    ui.showModal('🚕 운행 중이던 미터가 있어요', `${startText}에 출발한 운행이에요. 이어서 갈까요?`, [
      { label: '이어가기', primary: true, onClick: () => resume(false) },
      { label: '그때 종료 처리하고 영수증 보기', onClick: endAtThen },
    ]);
  } else {
    ui.showModal('🚕 운행 중이던 미터가 있어요', `${startText} 출발, 마지막 기록 후 ${gapText} 비어 있어요. 어떻게 할까요?`, [
      { label: `공백 ${gapText} 포함해서 이어가기 💸`, onClick: () => resume(false) },
      { label: '공백 빼고 이어가기', primary: true, onClick: () => resume(true) },
      { label: '그때 종료 처리하고 영수증 보기', onClick: endAtThen },
    ]);
  }
}

// ── 공유 ──

function setupShareButton(record) {
  const btn = document.getElementById('btn-share');
  if (!navigator.share) {
    btn.classList.add('hidden');
    return;
  }
  btn.classList.remove('hidden');
  btn.onclick = () => {
    navigator.share({ text: ui.receiptShareText(record) }).catch(() => {});
  };
}

// ── 탭/화면 ──

function bindTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const name = tab.dataset.tab;
      if (name === 'history') {
        ui.renderHistory(store.loadHistory(), (rec) => {
          ui.renderReceipt(rec);
          setupShareButton(rec);
          ui.showScreen('receipt');
        });
      } else if (name === 'settings') {
        settings = store.loadSettings();
        ui.renderSettingsForm(settings, !!ride, {
          onSave: (s) => {
            store.saveSettings(s);
            settings = s;
            if (!ride) ui.renderMeterIdle(settings);
          },
        });
      }
      ui.showScreen(name);
    });
  });

  document.getElementById('btn-receipt-close').addEventListener('click', () => {
    ui.renderMeterIdle(settings);
    ui.showScreen('meter');
  });
}

// ── 가시성/종료 대비 저장 ──

document.addEventListener('visibilitychange', () => {
  if (!ride) return;
  if (document.visibilityState === 'visible') {
    loop(); // 복귀 즉시 밀린 시간 정산 + 화면 갱신
  } else {
    store.saveActiveRide(ride);
  }
});
window.addEventListener('pagehide', () => {
  if (ride) store.saveActiveRide(ride);
});

// ── 디버그 API (콘솔 검증용) ──

window.lt = {
  state: () => ride,
  settings: () => settings,
  // 시간여행: 과거로 ms만큼 이동시켜 경과 시간을 시뮬레이션
  timeTravel(ms) {
    if (!ride) return 'no active ride';
    ride.startedAt -= ms;
    ride.lastChargeT -= ms;
    if (ride.lastFix) ride.lastFix.t -= ms;
    for (const e of ride.surchargeLog) {
      e.from -= ms;
      if (e.to !== null) e.to -= ms;
    }
    loop();
    return meter.computeRewards(ride);
  },
  rewards: () => (ride ? meter.computeRewards(ride) : null),
};

// ── 초기화 ──

function init() {
  ui.renderMeterIdle(settings);
  bindRideButton();
  bindTabs();
  checkRecovery();
  if (!store.isPersistent()) {
    setIssue('storage', '💾 이 브라우저 모드에서는 저장이 안 돼요(시크릿 모드?) — 앱을 닫으면 기록이 사라져요');
  }
  if (DEBUG) {
    dlog(`boot: geo=${gps.isSupported()} wake=${wakelock.isSupported()} mock=${gps.isMock()}`);
  }
}

init();

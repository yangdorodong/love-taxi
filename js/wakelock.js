// wakelock.js — Screen Wake Lock (화면 꺼짐 방지) + 미지원 fallback 안내

let sentinel = null;
let wanted = false;
let statusCb = null; // (state: 'on'|'off'|'unsupported') => void

export function isSupported() {
  return 'wakeLock' in navigator;
}

export async function request(onStatus) {
  statusCb = onStatus || statusCb;
  wanted = true;
  if (!isSupported()) {
    statusCb?.('unsupported');
    return false;
  }
  try {
    sentinel = await navigator.wakeLock.request('screen');
    sentinel.addEventListener('release', () => {
      sentinel = null;
      statusCb?.('off');
    });
    statusCb?.('on');
    return true;
  } catch {
    statusCb?.('off'); // 배터리 세이버 모드 등에서 거부될 수 있음
    return false;
  }
}

export async function release() {
  wanted = false;
  if (sentinel) {
    try { await sentinel.release(); } catch { /* already released */ }
    sentinel = null;
  }
  statusCb?.('off');
}

// 탭 복귀 시 자동 재획득 (백그라운드 진입 시 OS가 lock을 해제함)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wanted && !sentinel) {
    request();
  }
});

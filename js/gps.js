// gps.js — watchPosition 래퍼 + 개발용 목 GPS (?mockgps=1)
// fix 정규화: {lat, lng, t, accuracy}. 필터링은 meter.applyFix가 담당.

let watchId = null;
let mockTimer = null;

export function isMock() {
  return new URLSearchParams(location.search).get('mockgps') === '1';
}

export function isSupported() {
  return 'geolocation' in navigator;
}

// onFix(fix), onStatus('active'|'denied'|'unavailable'|'off')
export function start(onFix, onStatus) {
  stop();
  if (isMock()) {
    startMock(onFix, onStatus);
    return;
  }
  if (!isSupported()) {
    onStatus('unavailable');
    return;
  }
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      onStatus('active');
      onFix({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        t: pos.timestamp || Date.now(),
        accuracy: pos.coords.accuracy ?? 999,
      });
    },
    (err) => {
      // 1: PERMISSION_DENIED, 2: POSITION_UNAVAILABLE, 3: TIMEOUT
      onStatus(err.code === 1 ? 'denied' : 'unavailable');
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
  );
}

export function stop() {
  if (watchId !== null && isSupported()) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  if (mockTimer !== null) {
    clearInterval(mockTimer);
    mockTimer = null;
  }
}

// ── 목 GPS: 정지 30초 → 30km/h 직진 60초 → 정지 30초 반복 ──────
// ?mockgps=1&speed=30 으로 속도 변경 가능

function startMock(onFix, onStatus) {
  const speedKmh = Number(new URLSearchParams(location.search).get('speed')) || 30;
  const mps = (speedKmh * 1000) / 3600;
  const base = { lat: 37.5665, lng: 126.978 }; // 서울시청
  const mPerDegLat = 111320;
  let northM = 0;
  let phaseStart = Date.now();
  let moving = false;
  let lastT = Date.now();

  onStatus('active');
  mockTimer = setInterval(() => {
    const now = Date.now();
    const phaseElapsed = now - phaseStart;
    if (!moving && phaseElapsed > 30000) { moving = true; phaseStart = now; }
    else if (moving && phaseElapsed > 60000) { moving = false; phaseStart = now; }

    // 백그라운드 스로틀로 tick이 밀려도 한 번에 2초치까지만 전진 (텔레포트 방지)
    if (moving) northM += mps * Math.min(2, (now - lastT) / 1000);
    lastT = now;

    const jitter = () => (Math.random() - 0.5) * 3; // ±1.5m 노이즈
    onFix({
      lat: base.lat + (northM + jitter()) / mPerDegLat,
      lng: base.lng + jitter() / (mPerDegLat * Math.cos((base.lat * Math.PI) / 180)),
      t: now,
      accuracy: 8 + Math.random() * 7,
    });
  }, 1000);
}

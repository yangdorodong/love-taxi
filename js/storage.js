// storage.js — localStorage 3키 스키마. 쓰기 실패 시 in-memory 강등.

const PREFIX = 'lovetaxi:v1:';
const KEYS = {
  settings: PREFIX + 'settings',
  activeRide: PREFIX + 'activeRide',
  history: PREFIX + 'history',
};
const HISTORY_MAX = 50;

const memory = {}; // localStorage 사용 불가 시 fallback
let degraded = false;

export function isPersistent() {
  return !degraded;
}

export function defaultSettings() {
  return {
    schemaVersion: 1,
    coupleNames: ['', ''],
    meter: { timeUnitSec: 30, distUnitM: 131 }, // 병산 단위 (임계속도 15.7km/h)
    fareTable: {
      baseRewards: [{ itemId: 'kiss', qty: 1 }],
      items: [
        { id: 'kiss', name: '뽀뽀', emoji: '💋', perMinutes: 10, qtyPerUnit: 1 },
        { id: 'massage', name: '안마 5분', emoji: '💆', perMinutes: 60, qtyPerUnit: 1 },
        { id: 'wish', name: '소원권', emoji: '🎫', perMinutes: 180, qtyPerUnit: 1 },
      ],
    },
    surcharges: [
      { id: 'night', name: '심야할증', multiplier: 1.2, mode: 'auto-night', enabled: true, config: { from: '22:00', to: '04:00' } },
      { id: 'weekend', name: '주말할증', multiplier: 1.1, mode: 'auto-weekend', enabled: true, config: {} },
      { id: 'anniv', name: '기념일할증', multiplier: 2.0, mode: 'auto-date', enabled: false, config: { dates: [] } },
      { id: 'mood', name: '기분할증', multiplier: 1.5, mode: 'manual', enabled: true, config: {} },
    ],
  };
}

function read(key) {
  try {
    const raw = degraded ? memory[key] : localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return memory[key] ? JSON.parse(memory[key]) : null;
  }
}

function write(key, value) {
  const raw = JSON.stringify(value);
  memory[key] = raw;
  if (degraded) return;
  try {
    localStorage.setItem(key, raw);
  } catch {
    degraded = true; // Safari 시크릿 모드 등 — 이후 in-memory로만 동작
  }
}

function remove(key) {
  delete memory[key];
  try {
    localStorage.removeItem(key);
  } catch { /* degraded */ }
}

// ── settings ──

export function loadSettings() {
  const saved = read(KEYS.settings);
  if (!saved) return defaultSettings();
  // 얕은 병합: 새 버전에서 추가된 필드가 있어도 기본값으로 채워짐
  const def = defaultSettings();
  return {
    ...def,
    ...saved,
    meter: { ...def.meter, ...(saved.meter || {}) },
    fareTable: saved.fareTable || def.fareTable,
    surcharges: saved.surcharges || def.surcharges,
  };
}

export function saveSettings(settings) {
  write(KEYS.settings, settings);
}

// ── activeRide ──

export function loadActiveRide() {
  const ride = read(KEYS.activeRide);
  return ride && ride.status === 'running' ? ride : null;
}

export function saveActiveRide(state) {
  write(KEYS.activeRide, state);
}

export function clearActiveRide() {
  remove(KEYS.activeRide);
}

// ── history ──

export function loadHistory() {
  return read(KEYS.history) || [];
}

export function addHistory(record) {
  const list = loadHistory();
  list.unshift(record);
  write(KEYS.history, list.slice(0, HISTORY_MAX));
}

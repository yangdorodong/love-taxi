// ui.js — 렌더링 전담 (상태를 받아 DOM을 갱신, 로직 없음)

import { computeRewards, nextReward, evaluateSurcharges, thresholdKmh } from './meter.js';

const $ = (id) => document.getElementById(id);

// ── 포맷 유틸 ──

export function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
}

export function fmtKm(m) {
  return (m / 1000).toFixed(2);
}

export function fmtClock(t) {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function fmtDate(t) {
  const d = new Date(t);
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')} (${days[d.getDay()]})`;
}

export function fmtDuration(ms) {
  const min = Math.floor(ms / 60000);
  const h = Math.floor(min / 60);
  if (h > 0) return `${h}시간 ${min % 60}분`;
  if (min > 0) return `${min}분`;
  return `${Math.max(0, Math.floor(ms / 1000))}초`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── 미터 화면 ──

export function renderMeterIdle(settings) {
  const items = settings.fareTable.items;
  $('reward-display').innerHTML = items
    .map((it) => `<div class="reward-item"><span class="emoji">${esc(it.emoji)}</span><span class="qty">0</span><span class="name">${esc(it.name)}</span></div>`)
    .join('');
  $('elapsed').textContent = '00:00:00';
  $('distance').innerHTML = '0.00<small>km</small>';
  $('mode-indicator').textContent = '💤 대기 중';
  $('mode-indicator').classList.remove('dist');
  $('speed').textContent = '';
  const base = (settings.fareTable.baseRewards || [])
    .map((b) => {
      const it = items.find((i) => i.id === b.itemId);
      return it ? `${it.emoji}×${b.qty}` : null;
    })
    .filter(Boolean)
    .join(' ');
  const first = items[0];
  $('progress-label').textContent =
    `기본요금 ${base || '없음'}${first ? ` · ${first.perMinutes}분당 ${first.emoji}×${first.qtyPerUnit}` : ''}`;
  $('progress-fill').style.width = '0%';
  $('manual-surcharges').innerHTML = '';
  $('surcharge-lamps').innerHTML = '';
  const btn = $('btn-ride');
  btn.classList.remove('running');
  btn.innerHTML = '<span class="hold-fill"></span><span class="btn-label">🚕 탑승!</span>';
  $('ride-hint').textContent = '';
}

export function renderMeterRunning(state, now) {
  const rewards = computeRewards(state);
  $('reward-display').innerHTML = rewards
    .map((r) => `<div class="reward-item"><span class="emoji">${esc(r.emoji)}</span><span class="qty">${r.qty}</span><span class="name">${esc(r.name)}</span></div>`)
    .join('');
  $('elapsed').textContent = fmtElapsed(now - state.startedAt);
  $('distance').innerHTML = `${fmtKm(state.totalDistM)}<small>km</small>`;

  const mode = $('mode-indicator');
  if (state.chargeMode === 'dist') {
    mode.textContent = '🛣 거리 모드';
    mode.classList.add('dist');
  } else {
    mode.textContent = '⏱ 시간 모드';
    mode.classList.remove('dist');
  }
  $('speed').textContent = `${Math.round(state.currentSpeedKmh)} km/h`;

  const next = nextReward(state);
  if (next) {
    $('progress-label').textContent =
      `다음 ${next.item.emoji} ${next.item.name}까지 ${fmtDuration(Math.max(60000, next.remainMs))} 남음`;
    $('progress-fill').style.width = `${Math.round(next.progress * 100)}%`;
  }

  const { active } = evaluateSurcharges(state, now);
  $('surcharge-lamps').innerHTML = active
    .map((s) => `<span class="lamp">${esc(s.name)} ×${s.multiplier}</span>`)
    .join('');

  const btn = $('btn-ride');
  if (!btn.classList.contains('running')) {
    btn.classList.add('running');
    btn.innerHTML = '<span class="hold-fill"></span><span class="btn-label">🛑 길게 눌러 운행 종료</span>';
  }
}

export function renderManualChips(state, onToggle) {
  const manuals = (state.fareSnapshot.surcharges || []).filter((s) => s.enabled && s.mode === 'manual');
  const wrap = $('manual-surcharges');
  wrap.innerHTML = '';
  for (const s of manuals) {
    const chip = document.createElement('button');
    chip.className = 'chip' + (state.manualOn[s.id] ? ' on' : '');
    chip.textContent = `${s.name} ×${s.multiplier}`;
    chip.addEventListener('click', () => onToggle(s.id));
    wrap.appendChild(chip);
  }
}

export function setDot(id, cls) {
  const el = $(id);
  el.classList.remove('on', 'off', 'err');
  el.classList.add(cls);
}

export function showBanner(msg) {
  const b = $('banner');
  if (!msg) {
    b.classList.add('hidden');
  } else {
    b.textContent = msg;
    b.classList.remove('hidden');
  }
}

export function setRideHint(msg) {
  $('ride-hint').textContent = msg || '';
}

// ── 영수증 ──

export function renderReceipt(record) {
  const names = (record.coupleNames || []).filter(Boolean);
  const rewards = record.rewards.length
    ? record.rewards.map((r) => `<div class="r-reward"><span>${esc(r.emoji)} ${esc(r.name)}</span><span>× ${r.qty}</span></div>`).join('')
    : '<div class="r-row"><span class="k">적립된 보상이 없어요</span></div>';
  const surLog = mergeSurchargeLog(record.surchargeLog);
  const surcharges = surLog.length
    ? surLog.map((e) => `<div class="r-row"><span class="k">${esc(e.name)} ×${e.multiplier}</span><span class="v">${fmtClock(e.from)}~${fmtClock(e.to)}</span></div>`).join('')
    : '';

  $('receipt-card').innerHTML = `
    <div class="r-title">🚕 LOVE TAXI</div>
    <div class="r-sub">달콤한 운행 영수증${names.length === 2 ? ` · ${esc(names[0])} ♥ ${esc(names[1])}` : ''}</div>
    <hr class="r-divider">
    <div class="r-row"><span class="k">탑승</span><span class="v">${fmtDate(record.startedAt)} ${fmtClock(record.startedAt)}</span></div>
    <div class="r-row"><span class="k">하차</span><span class="v">${fmtClock(record.endedAt)}</span></div>
    <div class="r-row"><span class="k">운행</span><span class="v">${fmtDuration(record.elapsedMs)} · ${fmtKm(record.totalDistM)}km</span></div>
    <hr class="r-divider">
    <div class="r-section">운행 내역</div>
    <div class="r-row"><span class="k">시간요금 구간</span><span class="v">${fmtDuration(record.timeChargedMs)}</span></div>
    <div class="r-row"><span class="k">거리요금 구간</span><span class="v">${fmtKm(record.distChargedM)}km</span></div>
    ${surcharges ? `<div class="r-section" style="margin-top:8px">할증</div>${surcharges}` : ''}
    <hr class="r-divider">
    <div class="r-section">적립 보상</div>
    ${rewards}
    <hr class="r-divider">
    <div class="r-total">오늘의 요금, 사랑으로 결제됐어요 💗</div>
    <div class="r-footer">lovetaxi · 부가세 없음 · 환불 불가</div>
  `;
}

// 같은 할증이 여러 구간이면 첫/끝 구간을 합쳐 간단히 표시
function mergeSurchargeLog(log) {
  const byId = new Map();
  for (const e of log || []) {
    const cur = byId.get(e.id);
    if (!cur) byId.set(e.id, { ...e });
    else {
      cur.from = Math.min(cur.from, e.from);
      cur.to = Math.max(cur.to, e.to ?? e.from);
    }
  }
  return [...byId.values()];
}

export function receiptShareText(record) {
  const rewards = record.rewards.map((r) => `${r.emoji}×${r.qty}`).join(' ');
  return `🚕 LOVE TAXI 영수증\n${fmtDate(record.startedAt)} ${fmtClock(record.startedAt)}~${fmtClock(record.endedAt)}\n운행 ${fmtDuration(record.elapsedMs)} · ${fmtKm(record.totalDistM)}km\n적립: ${rewards || '없음'} 💗`;
}

// ── 기록 ──

export function renderHistory(list, onOpen) {
  const ul = $('history-list');
  if (!list.length) {
    ul.innerHTML = '<li class="history-empty">아직 기록이 없어요.<br>첫 운행을 시작해 보세요 🚕</li>';
    return;
  }
  ul.innerHTML = '';
  for (const rec of list) {
    const li = document.createElement('li');
    li.className = 'history-item';
    const rewards = rec.rewards.map((r) => `${r.emoji}×${r.qty}`).join('  ');
    li.innerHTML = `
      <div class="h-date">${fmtDate(rec.startedAt)}</div>
      <div class="h-meta">${fmtClock(rec.startedAt)}~${fmtClock(rec.endedAt)} · ${fmtDuration(rec.elapsedMs)} · ${fmtKm(rec.totalDistM)}km</div>
      <div class="h-rewards">${rewards || '—'}</div>`;
    li.addEventListener('click', () => onOpen(rec));
    ul.appendChild(li);
  }
}

// ── 설정 폼 ──

export function renderSettingsForm(settings, rideActive, handlers) {
  const root = $('settings-form');
  const s = settings;
  const modeLabel = { 'auto-night': '자동(심야)', 'auto-weekend': '자동(주말)', 'auto-date': '자동(날짜)', manual: '수동 토글' };

  root.innerHTML = `
    ${rideActive ? '<p class="save-note" style="margin-bottom:12px">🚕 운행 중이에요 — 변경사항은 다음 운행부터 적용돼요</p>' : ''}
    <div class="settings-group">
      <div class="g-title">👩‍❤️‍👨 커플 이름 (영수증에 표시)</div>
      <div style="display:flex; gap:8px">
        <input type="text" class="in-name" id="set-name-0" placeholder="이름 1" value="${esc(s.coupleNames?.[0] || '')}" maxlength="10">
        <input type="text" class="in-name" id="set-name-1" placeholder="이름 2" value="${esc(s.coupleNames?.[1] || '')}" maxlength="10">
      </div>
    </div>

    <div class="settings-group">
      <div class="g-title">💋 요금표</div>
      <div class="g-desc">"N분당 M개" 방식으로 쓸여요. 기본요금은 탑승하자마자 적립돼요. 이동 중(15.7km/h 이상)엔 거리 기준으로 같은 속도로 쓸여요.</div>
      <div id="fare-items"></div>
      <button type="button" class="btn-add" id="btn-add-item">+ 항목 추가</button>
    </div>

    <div class="settings-group">
      <div class="g-title">🌙 할증</div>
      <div id="surcharge-items"></div>
    </div>

    <details class="advanced">
      <summary>고급 설정 (병산 단위)</summary>
      <div class="settings-group">
        <div class="g-desc">택시 병산제 단위예요. 시간 단위(초)와 거리 단위(m)가 같은 가치를 가져요. 기본값: 30초 = 131m (임계속도 ${thresholdKmh(s.meter).toFixed(1)}km/h)</div>
        <div style="display:flex; gap:8px; align-items:center">
          <input type="number" class="in-num" id="set-timeunit" value="${s.meter.timeUnitSec}" min="5" max="600">
          <span class="unit-label">초 =</span>
          <input type="number" class="in-num" id="set-distunit" value="${s.meter.distUnitM}" min="10" max="5000">
          <span class="unit-label">m</span>
        </div>
      </div>
    </details>

    <button type="button" class="btn-save" id="btn-save-settings">저장</button>
    <p class="save-note" id="save-note"></p>
  `;

  const itemsWrap = root.querySelector('#fare-items');
  const renderItems = () => {
    itemsWrap.innerHTML = '';
    s.fareTable.items.forEach((it, i) => {
      const base = (s.fareTable.baseRewards || []).find((b) => b.itemId === it.id);
      const row = document.createElement('div');
      row.className = 'fare-item';
      row.innerHTML = `
        <input type="text" class="in-emoji" data-f="emoji" value="${esc(it.emoji)}" maxlength="4">
        <input type="text" class="in-name" data-f="name" value="${esc(it.name)}" maxlength="12" placeholder="이름">
        <span class="unit-label"></span>
        <button type="button" class="btn-del" title="삭제">✕</button>
        <div class="surcharge-detail" style="padding-left:4px">
          <input type="number" class="in-num" data-f="perMinutes" value="${it.perMinutes}" min="1" max="1440">
          <span class="unit-label">분당</span>
          <input type="number" class="in-num" data-f="qtyPerUnit" value="${it.qtyPerUnit}" min="1" max="99">
          <span class="unit-label">개 · 기본</span>
          <input type="number" class="in-num" data-f="baseQty" value="${base ? base.qty : 0}" min="0" max="99">
          <span class="unit-label">개</span>
        </div>`;
      row.querySelectorAll('input').forEach((inp) => {
        inp.addEventListener('change', () => {
          const f = inp.dataset.f;
          if (f === 'baseQty') {
            const qty = Number(inp.value) || 0;
            s.fareTable.baseRewards = (s.fareTable.baseRewards || []).filter((b) => b.itemId !== it.id);
            if (qty > 0) s.fareTable.baseRewards.push({ itemId: it.id, qty });
          } else if (f === 'perMinutes' || f === 'qtyPerUnit') {
            it[f] = Math.max(1, Number(inp.value) || 1);
          } else {
            it[f] = inp.value;
          }
        });
      });
      row.querySelector('.btn-del').addEventListener('click', () => {
        if (s.fareTable.items.length <= 1) return;
        s.fareTable.items.splice(i, 1);
        s.fareTable.baseRewards = (s.fareTable.baseRewards || []).filter((b) => b.itemId !== it.id);
        renderItems();
      });
      itemsWrap.appendChild(row);
    });
  };
  renderItems();

  root.querySelector('#btn-add-item').addEventListener('click', () => {
    s.fareTable.items.push({ id: `item_${Date.now()}`, name: '', emoji: '💝', perMinutes: 30, qtyPerUnit: 1 });
    renderItems();
  });

  const surWrap = root.querySelector('#surcharge-items');
  s.surcharges.forEach((sur) => {
    const row = document.createElement('div');
    row.className = 'surcharge-item';
    let detail = '';
    if (sur.mode === 'auto-night') {
      detail = `<input type="time" data-f="from" value="${esc(sur.config?.from || '22:00')}"><span class="unit-label">~</span><input type="time" data-f="to" value="${esc(sur.config?.to || '04:00')}">`;
    } else if (sur.mode === 'auto-date') {
      detail = `<input type="text" class="in-name" data-f="dates" value="${esc((sur.config?.dates || []).join(', '))}" placeholder="MM-DD, MM-DD"><span class="unit-label">기념일</span>`;
    }
    row.innerHTML = `
      <label class="switch"><input type="checkbox" data-f="enabled" ${sur.enabled ? 'checked' : ''}></label>
      <span class="surcharge-name">${esc(sur.name)} <span class="unit-label">(${modeLabel[sur.mode] || sur.mode})</span></span>
      <span class="unit-label">×</span>
      <input type="number" class="in-mult" data-f="multiplier" value="${sur.multiplier}" min="1" max="3" step="0.1">
      ${detail ? `<div class="surcharge-detail">${detail}</div>` : ''}`;
    row.querySelectorAll('input').forEach((inp) => {
      inp.addEventListener('change', () => {
        const f = inp.dataset.f;
        if (f === 'enabled') sur.enabled = inp.checked;
        else if (f === 'multiplier') sur.multiplier = Math.min(3, Math.max(1, Number(inp.value) || 1));
        else if (f === 'dates') sur.config = { ...sur.config, dates: inp.value.split(',').map((x) => x.trim()).filter((x) => /^\d{2}-\d{2}$/.test(x)) };
        else sur.config = { ...sur.config, [f]: inp.value };
      });
    });
    surWrap.appendChild(row);
  });

  root.querySelector('#btn-save-settings').addEventListener('click', () => {
    s.coupleNames = [root.querySelector('#set-name-0').value.trim(), root.querySelector('#set-name-1').value.trim()];
    s.meter.timeUnitSec = Math.max(5, Number(root.querySelector('#set-timeunit').value) || 30);
    s.meter.distUnitM = Math.max(10, Number(root.querySelector('#set-distunit').value) || 131);
    s.fareTable.items = s.fareTable.items.filter((it) => it.name.trim() !== '');
    handlers.onSave(s);
    root.querySelector('#save-note').textContent = '저장했어요 ✓';
    setTimeout(() => { const n = root.querySelector('#save-note'); if (n) n.textContent = ''; }, 2000);
  });
}

// ── 모달 ──

export function showModal(title, body, actions) {
  const rootEl = $('modal-root');
  rootEl.innerHTML = `
    <div class="modal">
      <div class="m-title">${title}</div>
      <div class="m-body">${body}</div>
      <div class="m-actions"></div>
    </div>`;
  const wrap = rootEl.querySelector('.m-actions');
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.textContent = a.label;
    if (a.primary) btn.classList.add('primary');
    btn.addEventListener('click', () => {
      rootEl.classList.add('hidden');
      a.onClick();
    });
    wrap.appendChild(btn);
  }
  rootEl.classList.remove('hidden');
}

// ── 화면 전환 ──

export function showScreen(name) {
  document.querySelectorAll('.screen').forEach((el) => el.classList.remove('active'));
  $(`screen-${name}`).classList.add('active');
  document.querySelectorAll('.tab').forEach((el) => {
    el.classList.toggle('active', el.dataset.tab === name);
  });
}

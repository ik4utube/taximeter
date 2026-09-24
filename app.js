'use strict';

/* =========================================================
 * 서울 중형택시 요금 (2023.2.1 시행, 서울시 공고)
 * ========================================================= */
const FARE = {
  base: 4800,        // 기본요금 (원)
  baseDist: 1600,    // 기본거리 (m)
  unit: 100,         // 단위요금 (원)
  unitDist: 131,     // 거리 단위 (m)
  unitTime: 30,      // 시간 단위 (초)
  slowKmh: 15.72,    // 이 속도 이하면 시간요금
};

const $ = (s) => document.querySelector(s);
const STORE = 'taximeter.v1';

function nightPct(d) {
  const h = d.getHours();
  if (h === 23 || h < 2) return 40;
  if (h === 22 || h === 2 || h === 3) return 20;
  return 0;
}
const pctNow = () => nightPct(new Date()) + (S.outCity ? 20 : 0);
const round100 = (x) => Math.round(x / 100) * 100;
const baseFareAt = (p) => round100(FARE.base * (1 + p / 100));
const unitFareAt = (p) => Math.round(FARE.unit * (1 + p / 100));

/* ---------- state ---------- */
function freshRide() {
  return {
    status: 'idle', start: 0, end: 0,
    fare: 0, baseFare: 0, distFare: 0, timeFare: 0,
    units: 0, equiv: 0, dist: 0, slowSec: 0, maxPct: 0,
    call: 0, plate: '',
  };
}
function load() {
  try { return JSON.parse(localStorage.getItem(STORE)); } catch { return null; }
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify(S)); } catch { /* private mode */ }
}
const S = Object.assign(
  { ...freshRide(), outCity: false, demo: false, sound: true, awake: false },
  load() || {},
);

let speed = 0;            // m/s, smoothed
let pending = 0;          // m moved since last tick
let lastTick = Date.now();

/* ---------- fare engine ---------- */
function tick() {
  const now = Date.now();
  const dt = (now - lastTick) / 1000;
  lastTick = now;
  if (dt <= 0) return;

  if (S.demo) demoStep(dt);
  else if (now - lastFixAt > 4000) speed *= Math.pow(0.6, dt);
  if (speed < 0.05) speed = 0;

  const d = pending;
  pending = 0;

  if (S.status === 'riding') {
    S.dist += d;
    // 긴 공백(화면 잠김 등) 뒤에는 평균속도로 판정
    const kmh = (dt > 5 ? d / dt : speed) * 3.6;
    let src;
    if (kmh > FARE.slowKmh) { S.equiv += d; src = 'dist'; }
    else { S.equiv += (dt * FARE.unitDist) / FARE.unitTime; S.slowSec += dt; src = 'time'; }

    const p = pctNow();
    S.maxPct = Math.max(S.maxPct, p);
    const uf = unitFareAt(p);
    let added = 0;
    while (S.equiv - FARE.baseDist >= (S.units + 1) * FARE.unitDist) {
      S.units++;
      S.fare += uf;
      if (src === 'dist') S.distFare += uf; else S.timeFare += uf;
      added++;
    }
    if (added) { beep(1850, 55); bumpFare(); }
    save();
  }
  render();
}

/* ---------- GPS ---------- */
let watchId = null;
let anchor = null;
let lastFixAt = 0;

function haversine(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function startGeo() {
  if (watchId !== null || S.demo) return;
  if (!('geolocation' in navigator)) { setGps('미지원'); return; }
  setGps('수신중…');
  watchId = navigator.geolocation.watchPosition(onFix, onGeoError, {
    enableHighAccuracy: true, maximumAge: 0, timeout: 20000,
  });
}
function stopGeo() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  anchor = null;
  if (!S.demo) setGps('대기');
}
function onFix(pos) {
  const c = pos.coords;
  setGps(`±${Math.round(c.accuracy)}m`);
  if (c.accuracy > 50) return; // 너무 부정확한 위치는 버림

  const fix = { lat: c.latitude, lon: c.longitude, t: pos.timestamp };
  lastFixAt = Date.now();
  if (!anchor) { anchor = fix; return; }

  const d = haversine(anchor, fix);
  const dt = Math.max(0.001, (fix.t - anchor.t) / 1000);
  if (d / dt > 70) { anchor = fix; return; } // 250km/h 이상 순간이동 = GPS 튐

  let v = c.speed != null && c.speed >= 0 ? c.speed : null;
  // 제자리 떨림이 쌓이지 않도록 정확도 기준 이상 움직였을 때만 누적
  if (d >= Math.max(4, c.accuracy * 0.5)) {
    pending += d;
    if (v === null) v = d / dt;
    anchor = fix;
  } else if (v === null) {
    v = 0;
  }
  speed = speed * 0.5 + v * 0.5;
}
function onGeoError(e) {
  if (e.code === 1) { setGps('권한 없음'); toast('설정에서 위치 권한을 허용해 주세요'); }
  else setGps('신호 약함');
}
function setGps(t) { $('#gps').textContent = t; }

/* ---------- 모의주행 (복합) ---------- */
let demoTarget = 0, demoNext = 0;
function demoStep(dt) {
  const now = Date.now();
  if (now > demoNext) {
    const pick = [0, 0, 8, 12, 30, 45, 60, 80];
    demoTarget = pick[Math.floor(Math.random() * pick.length)];
    demoNext = now + (4 + Math.random() * 7) * 1000;
  }
  speed += (demoTarget / 3.6 - speed) * Math.min(1, dt * 0.7);
  pending += speed * dt;
}

/* ---------- actions ---------- */
function randomPlate() {
  const n = (a, b) => a + Math.floor(Math.random() * (b - a));
  return `서울 ${n(10, 99)}${'아바사자'[n(0, 4)]} ${n(1000, 9999)}`;
}

function startRide() {
  if (S.status === 'riding') return;
  if (S.status === 'paid') Object.assign(S, freshRide());
  const p = pctNow();
  Object.assign(S, {
    status: 'riding', start: Date.now(),
    baseFare: baseFareAt(p), fare: baseFareAt(p), maxPct: p,
    plate: randomPlate(),
  });
  lastTick = Date.now();
  startGeo();
  wake();
  save();
  toast(S.demo ? '모의주행 출발!' : '출발합니다. 안전운전!');
  render();
}

function pay() {
  if (S.status !== 'riding') { toast('주행 중이 아닙니다'); return; }
  tick();
  S.status = 'paid';
  S.end = Date.now();
  stopGeo();
  releaseWake();
  save();
  render();
  beep(1200, 90); setTimeout(() => beep(1600, 120), 120);
  showReceipt();
}

function goIdle() {
  if (S.status === 'riding' && !confirm('주행을 취소하고 빈차로 돌릴까요?')) return;
  Object.assign(S, freshRide());
  stopGeo();
  releaseWake();
  callBuf = null;
  save();
  render();
}

/* 호출요금 입력 */
let callBuf = null;
function toggleCallEntry() {
  if (callBuf === null) { callBuf = ''; toast('호출요금 입력 후 호출을 다시 누르세요'); }
  else { S.call = parseInt(callBuf || '0', 10); callBuf = null; save(); }
  render();
}
function pressNum(n) {
  if (callBuf === null) { toast('호출 버튼을 먼저 누르세요'); return; }
  callBuf = (callBuf + n).replace(/^0+(?=\d)/, '').slice(0, 5);
  render();
}

const actions = {
  idle: goIdle,
  start: startRide,
  pay,
  surcharge() { S.outCity = !S.outCity; toast(S.outCity ? '시계외 할증 +20%' : '시계외 할증 해제'); save(); render(); },
  demo() {
    S.demo = !S.demo;
    if (S.demo) { stopGeo(); setGps('모의'); toast('복합: 모의주행 모드'); }
    else { speed = 0; setGps('대기'); if (S.status === 'riding') startGeo(); toast('실제 GPS 모드'); }
    save(); render();
  },
  sound() { S.sound = !S.sound; save(); render(); toast(S.sound ? '소리 켬' : '소리 끔'); },
  callfee: toggleCallEntry,
  callok() { if (callBuf !== null) toggleCallEntry(); },
  cancel() { if (callBuf !== null) callBuf = ''; else { S.call = 0; save(); } render(); },
  info() { $('#infoDlg').showModal(); },
  awake() { S.awake = !S.awake; save(); S.awake ? wake() : releaseWake(); render(); toast(S.awake ? '화면 꺼짐 방지 켬' : '화면 꺼짐 방지 끔'); },
  print() { if (S.status === 'paid') showReceipt(); else toast('지불 후 영수증을 뽑을 수 있어요'); },
};

document.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.act) { beep(2400, 25); actions[b.dataset.act](); }
  else if (b.dataset.num) { beep(2600, 25); pressNum(b.dataset.num); }
});

/* ---------- wake lock ---------- */
let wakeLock = null;
async function wake() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* 지원 안 함 */ }
}
function releaseWake() {
  if (S.awake) return;
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (S.status === 'riding' || S.awake)) wake();
});

/* ---------- sound ---------- */
let audio;
function beep(freq, ms) {
  if (!S.sound) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime;
    o.type = 'square';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.05, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + ms / 1000 + 0.02);
  } catch { /* no audio */ }
}

/* ---------- render ---------- */
const fmtTime = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [s / 3600, (s % 3600) / 60, s % 60].map((v) => String(Math.floor(v)).padStart(2, '0')).join(':');
};
const won = (n) => n.toLocaleString('ko-KR');
const total = () => S.fare + S.call;

function render() {
  const p = pctNow();
  const shownFare = S.status === 'idle' ? baseFareAt(p) : total();
  $('#fare').textContent = String(shownFare);
  $('#speed').textContent = (speed * 3.6).toFixed(1);
  $('#dist').textContent = (S.dist / 1000).toFixed(2);
  $('#pct').textContent = p;
  $('#call').textContent = callBuf !== null ? (callBuf || '0') : String(S.call);
  $('.call').classList.toggle('editing', callBuf !== null);

  $('#badge').textContent = { idle: '빈차', riding: p ? '할증' : '주행', paid: '지불' }[S.status];
  $('#led').classList.toggle('on', S.status === 'riding');

  const end = S.status === 'paid' ? S.end : Date.now();
  $('#elapsed').textContent = S.status === 'idle' ? '00:00:00' : fmtTime(end - S.start);

  $('#bIdle').classList.toggle('on', S.status === 'idle');
  $('#bStart').classList.toggle('on', S.status === 'riding');
  $('#bSur').classList.toggle('on', S.outCity);
  $('#bDemo').classList.toggle('on', S.demo);
  $('#bPay').classList.toggle('on', S.status === 'paid');
  $('#bSound').classList.toggle('on', S.sound);
  $('#bAwake').classList.toggle('on', S.awake);
  $('#bCall').classList.toggle('on', callBuf !== null);
}

function bumpFare() {
  const el = $('#fareBox');
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

/* =========================================================
 * 달리는 말 — 실제 습보(gallop) 보폭을 8단계 키프레임으로 보간
 * 각도: 0 = 수직, + = 뒤쪽(말은 왼쪽을 봄). [윗다리, 아랫다리] 절대각
 * ========================================================= */
const HORSE = {
  body:
    'M52 34C62 37 76 37 88 34C96 31 104 32 108 38C112 44 111 54 106 60' +
    'C103 64 98 66 95 66C86 68 72 70 62 68C55 67 50 66 47 63C42 58 41 48 44 42C46 38 49 35 52 34Z',
  neck:
    'M46 50C41 41 36 33 31 28C28 29 25 31 22 33L14 36C10 37 8 34 9 31L19 19' +
    'C21 16 24 14 27 14L29 7.5L32.5 14C40 19 49 27 58 36L55 50Z',
  neckPivot: [52, 44],
  front: { hip: [50, 61.5], L: [16, 15], w: [8, 3.8, 3.2, 2.6] },
  rear: { hip: [100, 56.5], L: [18, 19], w: [12, 4, 3.3, 2.7] },
  ground: 96,
};

const GALLOP_KEYS = {
  front: [[-0.45, -0.45], [-0.12, -0.12], [0.25, 0.3], [0.42, 1.1],
          [0.15, 1.85], [-0.35, 1.5], [-0.7, 0.3], [-0.65, -0.4]],
  rear:  [[-0.25, -0.35], [0, -0.1], [0.3, 0.2], [0.55, 0.55],
          [0.55, -0.1], [0.25, -0.8], [-0.1, -0.9], [-0.3, -0.6]],
};
const REST = { front: [0.02, 0.02], rear: [0.25, 0] };
// 다리별 위상 차. 습보: 뒷다리 두 개 → 앞다리 두 개 → 공중 부양 / 평보: 4박자
const GAIT = {
  gallop: { nearRear: 0, farRear: 0.09, farFront: 0.24, nearFront: 0.33 },
  walk: { nearRear: 0, nearFront: 0.25, farRear: 0.5, farFront: 0.75 },
};

/** 순환 Catmull-Rom 보간 */
function sampleKeys(keys, t) {
  const n = keys.length;
  const x = (((t % 1) + 1) % 1) * n, i = Math.floor(x), f = x - i;
  const p = (k) => keys[(i + k + n) % n];
  return [0, 1].map((j) => {
    const a = p(-1)[j], b = p(0)[j], c = p(1)[j], d = p(2)[j];
    return b + 0.5 * f * (c - a + f * (2 * a - 5 * b + 4 * c - d + f * (3 * (b - c) + d - a)));
  });
}

const n1 = (v) => v.toFixed(1);
function segPath(x0, y0, x1, y1, w0, w1) {
  const l = Math.hypot(x1 - x0, y1 - y0) || 1;
  const nx = -(y1 - y0) / l, ny = (x1 - x0) / l;
  return `M${n1(x0 + nx * w0 / 2)} ${n1(y0 + ny * w0 / 2)}L${n1(x1 + nx * w1 / 2)} ${n1(y1 + ny * w1 / 2)}` +
    `L${n1(x1 - nx * w1 / 2)} ${n1(y1 - ny * w1 / 2)}L${n1(x0 - nx * w0 / 2)} ${n1(y0 - ny * w0 / 2)}Z`;
}
function dotPath(x, y, r) {
  return `M${n1(x - r)} ${n1(y)}a${r} ${r} 0 1 0 ${n1(2 * r)} 0a${r} ${r} 0 1 0 ${n1(-2 * r)} 0Z`;
}
/** 허벅지(굵음) → 정강이(가늚) → 발굽을 채워진 도형 하나로 */
function legShape(spec, a1, a2) {
  const [hx, hy] = spec.hip, [L1, L2] = spec.L, [w0, w1, w2, w3] = spec.w;
  const kx = hx + L1 * Math.sin(a1), ky = hy + L1 * Math.cos(a1);
  const fx = kx + L2 * Math.sin(a2), fy = ky + L2 * Math.cos(a2);
  const a3 = a2 - 0.35;
  const tx = fx + 3.6 * Math.sin(a3), ty = fy + 3.6 * Math.cos(a3);
  return {
    d: segPath(hx, hy, kx, ky, w0, w1) + dotPath(kx, ky, w1 / 2 + 0.4) +
       segPath(kx, ky, fx, fy, w2, w3) + dotPath(fx, fy, w3 / 2 + 0.3) +
       segPath(fx, fy, tx, ty, w3 + 0.4, 4.6),
    low: Math.max(ty, fy),
  };
}

/** t: 보폭 위상(0~1 반복), amp: 동작 크기(0 = 서 있음), gallop: 습보 비중(0 = 평보) */
function horsePose(t, amp, gallop) {
  const TAU = Math.PI * 2;
  const leg = (kind, name) => {
    const gk = sampleKeys(GALLOP_KEYS[kind], t - GAIT.gallop[name]);
    const wk = sampleKeys(GALLOP_KEYS[kind], t - GAIT.walk[name]);
    const r = REST[kind];
    return [0, 1].map((j) => {
      const walk = r[j] + 0.42 * (wk[j] - r[j]);
      const mix = walk + (gk[j] - walk) * gallop;
      return r[j] + (mix - r[j]) * amp;
    });
  };
  const legs = {};
  for (const [name, kind] of [['farRear', 'rear'], ['farFront', 'front'], ['nearRear', 'rear'], ['nearFront', 'front']]) {
    const [a1, a2] = leg(kind, name);
    legs[name] = legShape(HORSE[kind], a1, a2);
  }
  // 발굽이 땅을 뚫지 않도록 몸을 들어 올리고, 습보의 공중 부양 구간엔 살짝 뜀
  const lowest = Math.max(...Object.values(legs).map((l) => l.low));
  const u = (((t - 0.62) % 1) + 1) % 1;
  const flight = u < 0.4 ? gallop * amp * 2.2 * Math.sin(Math.PI * u / 0.4) : 0;
  const dy = Math.min(0, HORSE.ground - lowest) - flight;
  const pitch = amp * (gallop * 2.4 * Math.sin(TAU * (t - 0.3)) + (1 - gallop) * 0.8 * Math.sin(TAU * 2 * t));
  const neck = amp * (gallop * 7 * Math.sin(TAU * (t - 0.1)) + (1 - gallop) * 3 * Math.sin(TAU * 2 * (t + 0.1)));
  const lift = amp * (0.35 + 0.65 * gallop);
  const wave = Math.sin(TAU * t * 2) * lift;
  const tail = `M106 38Q${n1(116 + 8 * lift)} ${n1(46 - 10 * lift + wave * 2)} ${n1(111 + 22 * lift)} ${n1(72 - 26 * lift + wave * 4)}`;
  const m = 4 * lift, mw = Math.sin(TAU * t * 2 + 1) * 1.5 * lift;
  const mane = [[33, 15], [39, 19], [45, 24], [51, 30]]
    .map(([x, y], i) => `M${x} ${y}Q${n1(x + 4 + m)} ${n1(y + 1 + mw)} ${n1(x + 7 + m * 1.4)} ${n1(y - 1 + mw * (1 + i * 0.2))}`)
    .join('');
  return { legs, dy, pitch, neck, tail, mane };
}

const Horse = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = $('#horse');
  const el = (tag, attrs, parent = svg) => {
    const node = document.createElementNS(NS, tag);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    parent.appendChild(node);
    return node;
  };
  const AMB = '#f5c33b', FAR = '#a3801f', LCD = '#3a3c39';

  const road = el('path', { d: 'M-10 97.5H150', fill: 'none', stroke: AMB, 'stroke-width': 1.4, 'stroke-dasharray': '8 8', opacity: 0.4 });
  const dustG = el('g', { fill: AMB });
  const body = el('g', {});
  const farRear = el('path', { fill: FAR }, body);
  const farFront = el('path', { fill: FAR }, body);
  const tail = el('path', { fill: 'none', stroke: AMB, 'stroke-width': 4.5, 'stroke-linecap': 'round' }, body);
  el('path', { d: HORSE.body, fill: AMB }, body);
  const neckG = el('g', {}, body);
  const mane = el('path', { fill: 'none', stroke: AMB, 'stroke-width': 2.4, 'stroke-linecap': 'round' }, neckG);
  el('path', { d: HORSE.neck, fill: AMB }, neckG);
  el('circle', { cx: 22.5, cy: 22, r: 1.5, fill: LCD }, neckG);
  el('circle', { cx: 11.5, cy: 32, r: 0.9, fill: LCD }, neckG);
  const nearRear = el('path', { fill: AMB }, body);
  const nearFront = el('path', { fill: AMB }, body);

  let t = 0, amp = 0, gallop = 0, roadOff = 0, last = performance.now();
  const dust = [];

  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const kmh = speed * 3.6;

    // 속도 → 동작 크기, 걸음새(평보↔습보), 보폭 빈도
    const moving = kmh >= 0.5;
    amp += ((moving ? Math.min(1, 0.55 + kmh / 30) : 0) - amp) * Math.min(1, dt * 4);
    const gTarget = Math.min(1, Math.max(0, (kmh - 12) / 13));
    gallop += (gTarget - gallop) * Math.min(1, dt * 2.5);
    const freq = moving ? 0.75 + 1.05 * gallop + Math.min(kmh, 110) * 0.006 : 0;
    t += freq * dt;
    if (!moving) t += (Math.round(t) - t) * Math.min(1, dt * 3);

    const p = horsePose(t, amp, gallop);
    farRear.setAttribute('d', p.legs.farRear.d);
    farFront.setAttribute('d', p.legs.farFront.d);
    nearRear.setAttribute('d', p.legs.nearRear.d);
    nearFront.setAttribute('d', p.legs.nearFront.d);
    tail.setAttribute('d', p.tail);
    mane.setAttribute('d', p.mane);
    neckG.setAttribute('transform', `rotate(${p.neck.toFixed(2)} ${HORSE.neckPivot.join(' ')})`);
    body.setAttribute('transform', `translate(0 ${p.dy.toFixed(2)}) rotate(${p.pitch.toFixed(2)} 78 52)`);

    roadOff = (roadOff + kmh * dt * 1.6) % 16;
    road.setAttribute('stroke-dashoffset', (-roadOff).toFixed(1));

    // 흙먼지
    if (kmh > 20 && Math.random() < dt * kmh / 7) {
      dust.push({ x: 96 + Math.random() * 14, y: 95, r: 1, life: 1 });
    }
    while (dustG.childNodes.length < dust.length) el('circle', {}, dustG);
    for (let i = dust.length - 1; i >= 0; i--) {
      const d = dust[i];
      d.x += (10 + kmh * 0.6) * dt; d.y -= 7 * dt; d.r += 3.5 * dt; d.life -= dt * 1.3;
      if (d.life <= 0) { dust.splice(i, 1); dustG.removeChild(dustG.lastChild); }
    }
    dust.forEach((d, i) => {
      const c = dustG.childNodes[i];
      c.setAttribute('cx', d.x.toFixed(1)); c.setAttribute('cy', d.y.toFixed(1));
      c.setAttribute('r', d.r.toFixed(1)); c.setAttribute('opacity', (d.life * 0.35).toFixed(2));
    });

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();

/* =========================================================
 * 영수증 (이미지)
 * ========================================================= */
let receiptBlob = null;

const fmtDate = (ms) => {
  const d = new Date(ms), z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${z(d.getMonth() + 1)}.${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
};

async function drawReceipt() {
  const MONO = '"Nanum Gothic Coding", monospace';
  await Promise.all([
    document.fonts.load(`16px ${MONO}`),
    document.fonts.load(`bold 16px ${MONO}`),
    document.fonts.load('30px "Do Hyeon"'),
    document.fonts.load('30px "DSEG7"'),
  ]).catch(() => {});

  const W = 360, M = 18, PW = W - M * 2, SC = 3;
  const rows = [
    ['title'],
    ['center', '필요없는 운수(주)'],
    ['center', `${S.plate}  ·  기사: 나`],
    ['sep'],
    ['kv', '승차', fmtDate(S.start)],
    ['kv', '하차', fmtDate(S.end)],
    ['kv', '주행거리', `${(S.dist / 1000).toFixed(2)} km`],
    ['kv', '주행시간', fmtTime(S.end - S.start)],
    ['sep'],
    ['kv', '기본요금', `${won(S.baseFare)}원`],
    ['kv', '거리요금', `${won(S.distFare)}원`],
    ['kv', '시간요금', `${won(S.timeFare)}원`],
    ['kv', '호출요금', `${won(S.call)}원`],
    ['kv', '적용할증', S.maxPct ? `최대 ${S.maxPct}%` : '없음'],
    ['dsep'],
    ['total'],
    ['dsep'],
    ['kv', '결제수단', '마음'],
    ['kv', '승인번호', String(S.start).slice(-8)],
    ['gap'],
    ['horse'],
    ['barcode'],
    ['small', '※ 실제로 청구되지 않습니다. 필요 없으니까요.'],
    ['small', '이용해 주셔서 감사합니다 · 안녕히 가세요'],
  ];
  const H_OF = { title: 58, center: 20, sep: 20, dsep: 22, kv: 25, total: 62, gap: 6, horse: 84, barcode: 48, small: 19 };
  const paperH = rows.reduce((h, r) => h + H_OF[r[0]], 0) + 44;
  const H = paperH + M * 2;

  const cv = document.createElement('canvas');
  cv.width = W * SC; cv.height = H * SC;
  const g = cv.getContext('2d');
  g.scale(SC, SC);

  // 배경
  g.fillStyle = '#1b1b1a';
  g.fillRect(0, 0, W, H);

  // 톱니 모양 종이
  const top = M, bot = M + paperH, tooth = 8;
  g.beginPath();
  g.moveTo(M, top + 4);
  for (let x = M; x < M + PW; x += tooth) { g.lineTo(x + tooth / 2, top); g.lineTo(x + tooth, top + 4); }
  g.lineTo(M + PW, bot - 4);
  for (let x = M + PW; x > M; x -= tooth) { g.lineTo(x - tooth / 2, bot); g.lineTo(x - tooth, bot - 4); }
  g.closePath();
  g.shadowColor = 'rgba(0,0,0,.5)'; g.shadowBlur = 16; g.shadowOffsetY = 6;
  g.fillStyle = '#f7f2e4';
  g.fill();
  g.shadowColor = 'transparent';

  const INK = '#2a2723', X0 = M + 20, X1 = M + PW - 20, CX = W / 2;
  let y = top + 22;
  g.textBaseline = 'middle';

  const dashed = (yy, dbl) => {
    g.strokeStyle = INK; g.lineWidth = 1; g.setLineDash([4, 3]);
    g.beginPath(); g.moveTo(X0, yy); g.lineTo(X1, yy); g.stroke();
    if (dbl) { g.beginPath(); g.moveTo(X0, yy + 4); g.lineTo(X1, yy + 4); g.stroke(); }
    g.setLineDash([]);
  };

  for (const [type, a, b] of rows) {
    const h = H_OF[type];
    const mid = y + h / 2;
    g.fillStyle = INK;
    if (type === 'title') {
      g.textAlign = 'center';
      g.font = '34px "Do Hyeon", sans-serif';
      g.fillText('영 수 증', CX, mid - 6);
      g.font = `bold 10px ${MONO}`;
      g.fillText('T A X I   R E C E I P T', CX, mid + 20);
    } else if (type === 'center') {
      g.textAlign = 'center'; g.font = `13px ${MONO}`;
      g.fillText(a, CX, mid);
    } else if (type === 'sep') dashed(mid);
    else if (type === 'dsep') dashed(mid - 2, true);
    else if (type === 'kv') {
      g.font = `14px ${MONO}`;
      g.textAlign = 'left'; g.fillText(a, X0, mid);
      g.textAlign = 'right'; g.font = `bold 14px ${MONO}`; g.fillText(b, X1, mid);
    } else if (type === 'total') {
      g.textAlign = 'left'; g.font = '22px "Do Hyeon", sans-serif';
      g.fillText('합  계', X0, mid);
      g.textAlign = 'right';
      g.font = '22px "Do Hyeon", sans-serif';
      g.fillText('원', X1, mid + 2);
      const wW = g.measureText('원').width;
      g.font = '28px DSEG7, monospace';
      g.fillText(String(total()), X1 - wW - 6, mid);
    } else if (type === 'horse') {
      drawReceiptHorse(g, CX - 52, y - 2, 0.75, INK);
    } else if (type === 'barcode') {
      let x = X0 + 20, seed = S.start % 997;
      while (x < X1 - 20) {
        seed = (seed * 73 + 41) % 997;
        const w = 1 + (seed % 3);
        if (seed % 5) g.fillRect(x, y + 4, w, 32);
        x += w + 1 + (seed % 2);
      }
      g.textAlign = 'center'; g.font = `9px ${MONO}`;
      g.fillText(`${S.plate.replace(/\s/g, '')}-${String(total()).padStart(6, '0')}`, CX, y + 43);
    } else if (type === 'small') {
      g.textAlign = 'center'; g.font = `11px ${MONO}`;
      g.fillText(a, CX, mid);
    }
    y += h;
  }
  return cv;
}

function drawReceiptHorse(g, x, y, s, ink) {
  const p = horsePose(0.45, 1, 1);
  g.save();
  g.translate(x, y); g.scale(s, s);
  g.fillStyle = '#b7afa0';
  g.fill(new Path2D(p.legs.farRear.d)); g.fill(new Path2D(p.legs.farFront.d));
  g.fillStyle = ink; g.strokeStyle = ink; g.lineCap = 'round';
  g.lineWidth = 4.5; g.stroke(new Path2D(p.tail));
  g.fill(new Path2D(HORSE.body));
  const [px, py] = HORSE.neckPivot;
  g.save();
  g.translate(px, py); g.rotate(p.neck * Math.PI / 180); g.translate(-px, -py);
  g.lineWidth = 2.4; g.stroke(new Path2D(p.mane));
  g.fill(new Path2D(HORSE.neck));
  g.fillStyle = '#f7f2e4'; g.beginPath(); g.arc(22.5, 22, 1.5, 0, 7); g.fill();
  g.restore();
  g.fill(new Path2D(p.legs.nearRear.d)); g.fill(new Path2D(p.legs.nearFront.d));
  g.restore();
}

async function showReceipt() {
  const cv = await drawReceipt();
  receiptBlob = await new Promise((r) => cv.toBlob(r, 'image/png'));
  $('#receiptImg').src = cv.toDataURL('image/png');
  const dlg = $('#receiptDlg');
  if (!dlg.open) dlg.showModal();
}

async function shareReceipt() {
  if (!receiptBlob) return;
  const name = `taxi-receipt-${fmtDate(S.end).replace(/[.: ]/g, '')}.png`;
  const file = new File([receiptBlob], name, { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: '택시 영수증' }); } catch { /* 취소 */ }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(receiptBlob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

$('#shareBtn').addEventListener('click', shareReceipt);
$('#closeReceipt').addEventListener('click', () => $('#receiptDlg').close());
$('#closeInfo').addEventListener('click', () => $('#infoDlg').close());

/* ---------- 화면 비율 맞춤 ---------- */
const DESIGN = { w: 393, h: 759 };
function fitDevice() {
  const st = $('.stage'), cs = getComputedStyle(st);
  const w = st.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const h = st.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const s = Math.min(w / DESIGN.w, h / DESIGN.h, 1.4);
  document.documentElement.style.setProperty('--s', s.toFixed(4));
}
addEventListener('resize', fitDevice);
addEventListener('orientationchange', () => setTimeout(fitDevice, 200));
fitDevice();

/* ---------- boot ---------- */
if (S.status === 'riding') {
  lastTick = Date.now();
  if (S.demo) setGps('모의'); else startGeo();
  toast('주행 기록을 이어갑니다');
} else if (S.demo) setGps('모의');
if (S.awake) wake();
render();
setInterval(tick, 1000);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

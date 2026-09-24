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
  if (callBuf === null) return;
  if (callBuf.length < 5) callBuf = (callBuf + n).replace(/^0+(?=\d)/, '');
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

  $('#hint').textContent = {
    idle: S.demo ? '모의주행 준비' : '주행을 누르면 출발',
    riding: speed * 3.6 > FARE.slowKmh ? '거리요금 가산 중' : '시간요금 가산 중',
    paid: `합계 ${won(total())}원`,
  }[S.status];
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
 * 달리는 말
 * ========================================================= */
const HORSE_BODY =
  'M40 52C35 47 33 40 32 33C30 27 26 24 21 23L12 27C8 28 5.5 24 8 21L17 11' +
  'C19 8 22 6 25 7L27 1.5L30 9C36 16 42 26 50 30C60 33 72 32 82 30' +
  'C90 29 96 33 96 40C96 46 92 50 86 52C80 55 70 56 60 56C52 56 45 55 40 52Z';
const HIP_F = [44, 50], HIP_R = [83, 47];

function legPoints(hip, a1, a2, L1, L2) {
  const [hx, hy] = hip;
  const kx = hx + L1 * Math.sin(a1), ky = hy + L1 * Math.cos(a1);
  const fx = kx + L2 * Math.sin(a1 + a2), fy = ky + L2 * Math.cos(a1 + a2);
  return [hx, hy, kx, ky, fx, fy];
}

/** 보폭 위상(phase)과 세기(amp)로 네 다리 각도 계산. 각도 0 = 수직, + = 뒤쪽 */
function horsePose(phase, amp) {
  const front = (off) => {
    const q = phase + off;
    return legPoints(HIP_F, -0.55 * amp * Math.sin(q),
      0.06 + 1.05 * amp * Math.max(0, Math.cos(q)) ** 1.5, 16, 16);
  };
  const rear = (off) => {
    const q = phase + off;
    return legPoints(HIP_R, 0.2 - 0.5 * amp * Math.sin(q),
      -0.28 - 0.6 * amp * Math.max(0, -Math.cos(q)) ** 1.4, 16, 17);
  };
  return {
    farRear: rear(0.55), farFront: front(2.95),
    nearRear: rear(0), nearFront: front(2.4),
  };
}

const Horse = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = $('#horse');
  const el = (tag, attrs, parent = svg) => {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    parent.appendChild(n);
    return n;
  };
  const AMB = '#f5c33b';
  const line = { fill: 'none', stroke: AMB, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };

  const road = el('path', { ...line, 'stroke-width': 1.6, 'stroke-dasharray': '7 7', opacity: 0.45 });
  const dustG = el('g', { fill: AMB });
  const body = el('g', {});
  const mkLeg = (w, op = 1) => {
    const g = el('g', { opacity: op }, body);
    return [el('path', { ...line, 'stroke-width': w * 1.7 }, g), el('path', { ...line, 'stroke-width': w }, g)];
  };
  const farRear = mkLeg(2.8, 0.45);
  const farFront = mkLeg(2.8, 0.45);
  const tail = el('path', { ...line, 'stroke-width': 3.4 }, body);
  el('path', { d: HORSE_BODY, fill: '#3a3c39', stroke: AMB, 'stroke-width': 2.4, 'stroke-linejoin': 'round' }, body);
  const mane = el('path', { ...line, 'stroke-width': 2 }, body);
  const nearRear = mkLeg(3.2);
  const nearFront = mkLeg(3.2);
  el('circle', { cx: 19.5, cy: 13.5, r: 1.4, fill: AMB }, body);
  el('circle', { cx: 10, cy: 23.5, r: 0.9, fill: AMB }, body);

  const f = (n) => n.toFixed(1);
  const setLeg = ([upper, lower], p) => {
    upper.setAttribute('d', `M${p[0]} ${p[1]}L${f(p[2])} ${f(p[3])}`);
    lower.setAttribute('d', `M${f(p[2])} ${f(p[3])}L${f(p[4])} ${f(p[5])}`);
  };

  let phase = 0, amp = 0, roadOff = 0, last = performance.now();
  const dust = [];

  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const kmh = speed * 3.6;

    // 속도 → 보폭 세기와 발놀림 빈도
    const targetAmp = kmh < 0.5 ? 0 : Math.min(1, 0.25 + kmh / 40);
    amp += (targetAmp - amp) * Math.min(1, dt * 4);
    const freq = kmh < 0.5 ? 0 : 0.9 + Math.min(kmh, 100) * 0.032;
    phase += 2 * Math.PI * freq * dt;
    if (freq === 0) phase += (Math.round(phase / (2 * Math.PI)) * 2 * Math.PI - phase) * Math.min(1, dt * 3);

    const pose = horsePose(phase, amp);
    setLeg(farRear, pose.farRear);
    setLeg(farFront, pose.farFront);
    setLeg(nearRear, pose.nearRear);
    setLeg(nearFront, pose.nearFront);

    const bob = amp * 2.4 * Math.sin(2 * phase);
    const pitch = amp * 3.5 * Math.sin(phase + 0.6);
    body.setAttribute('transform', `translate(0 ${(-bob).toFixed(2)}) rotate(${pitch.toFixed(2)} 64 44)`);

    // 꼬리: 정지 시 늘어지고, 달리면 뒤로 휘날림
    const w = Math.sin(phase * 1.5) * amp;
    tail.setAttribute('d',
      `M93 34Q${104 + amp * 4} ${36 - amp * 3 + w * 2} ${101 + amp * 13} ${60 - amp * 20 + w * 4}`);

    // 갈기
    const m = amp * 5, mw = Math.sin(phase * 2) * amp * 1.5;
    mane.setAttribute('d',
      `M29 9Q${34 + m} ${11 + mw} ${36 + m} ${9 + mw}M34 15Q${39 + m} ${17 + mw} ${42 + m} ${15 + mw}` +
      `M40 22Q${45 + m} ${24 + mw} ${48 + m} ${22 + mw}`);

    // 도로
    roadOff = (roadOff + kmh * dt * 1.6) % 14;
    road.setAttribute('d', 'M-6 84.5H126');
    road.setAttribute('stroke-dashoffset', (-roadOff).toFixed(1));

    // 흙먼지
    if (kmh > 20 && Math.random() < dt * kmh / 8) {
      dust.push({ x: 86 + Math.random() * 8, y: 82, r: 0.8, life: 1 });
    }
    while (dustG.childNodes.length < dust.length) el('circle', {}, dustG);
    for (let i = dust.length - 1; i >= 0; i--) {
      const p = dust[i];
      p.x += (8 + kmh * 0.5) * dt; p.y -= 6 * dt; p.r += 3 * dt; p.life -= dt * 1.4;
      if (p.life <= 0) { dust.splice(i, 1); dustG.removeChild(dustG.lastChild); }
    }
    dust.forEach((p, i) => {
      const c = dustG.childNodes[i];
      c.setAttribute('cx', p.x.toFixed(1)); c.setAttribute('cy', p.y.toFixed(1));
      c.setAttribute('r', p.r.toFixed(1)); c.setAttribute('opacity', (p.life * 0.35).toFixed(2));
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
      drawReceiptHorse(g, CX - 48, y + 2, 0.8, INK);
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
  const pose = horsePose(1.1, 1);
  g.save();
  g.translate(x, y); g.scale(s, s);
  g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = ink;
  const leg = (p, w) => {
    g.lineWidth = w * 1.7; g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(p[2], p[3]); g.stroke();
    g.lineWidth = w; g.beginPath(); g.moveTo(p[2], p[3]); g.lineTo(p[4], p[5]); g.stroke();
  };
  g.globalAlpha = 0.45; leg(pose.farRear, 2.8); leg(pose.farFront, 2.8); g.globalAlpha = 1;
  g.lineWidth = 3.4; g.beginPath(); g.moveTo(93, 34); g.quadraticCurveTo(108, 33, 114, 40); g.stroke();
  const p = new Path2D(HORSE_BODY);
  g.fillStyle = '#f7f2e4'; g.fill(p); g.lineWidth = 2.4; g.stroke(p);
  g.lineWidth = 2; g.beginPath();
  g.moveTo(29, 9); g.quadraticCurveTo(39, 11, 41, 9);
  g.moveTo(34, 15); g.quadraticCurveTo(44, 17, 47, 15);
  g.moveTo(40, 22); g.quadraticCurveTo(50, 24, 53, 22); g.stroke();
  leg(pose.nearRear, 3.2); leg(pose.nearFront, 3.2);
  g.fillStyle = ink; g.beginPath(); g.arc(19.5, 13.5, 1.4, 0, 7); g.fill();
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

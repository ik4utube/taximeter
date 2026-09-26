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

// 친구끼리 쓰는 영수증용 재미 환산: 스타벅스 아메리카노(Tall) 기준가 (2026년 기준 4,700원)
const COFFEE_PRICE = 4700;

const $ = (s) => document.querySelector(s);
const STORE = 'taximeter.v1';
// 안드로이드 앱(Capacitor) 안에서 실행 중인지
const NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

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
 * 달리는 말 — Eadweard Muybridge, "The Horse in Motion"(1878, 퍼블릭 도메인)
 * 실사 연속 사진 11장(습보 한 보폭) + 서 있는 사진 1장을 실루엣으로 만든 프레임
 * ========================================================= */
const HORSE_FRAMES = Array.from({ length: 12 }, (_, i) => `img/horse-${String(i + 1).padStart(2, '0')}.png`);
const GALLOP_COUNT = 11;       // 1~11: 달리는 동작, 12: 서 있는 모습
const STAND = 11;              // 0부터 센 인덱스
const HORSE_BOX = { x: 2, y: 12, w: 136, h: 86.8 };  // 프레임(293×187) 비율 그대로

// 미리 불러 두어 프레임 전환 시 깜빡임 방지
const horseImages = HORSE_FRAMES.map((src) => { const im = new Image(); im.src = src; return im; });

const Horse = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = $('#horse');
  const el = (tag, attrs, parent = svg) => {
    const node = document.createElementNS(NS, tag);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    parent.appendChild(node);
    return node;
  };
  const AMB = '#f5c33b';

  // 흰 실루엣 PNG를 마스크로 써서 LCD 호박색으로 칠함
  const defs = el('defs', {});
  const mask = el('mask', { id: 'horseMask', maskUnits: 'userSpaceOnUse', x: 0, y: 10, width: 140, height: 90 }, defs);
  const img = el('image', { href: HORSE_FRAMES[STAND], x: HORSE_BOX.x, y: HORSE_BOX.y, width: HORSE_BOX.w, height: HORSE_BOX.h }, mask);
  const road = el('path', { d: 'M-10 98.5H150', fill: 'none', stroke: AMB, 'stroke-width': 1.4, 'stroke-dasharray': '8 8', opacity: 0.4 });
  const dustG = el('g', { fill: AMB });
  el('rect', { x: 0, y: 10, width: 140, height: 90, fill: AMB, mask: 'url(#horseMask)' });

  let phase = 0, shown = STAND, roadOff = 0, last = performance.now();
  const dust = [];

  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const kmh = speed * 3.6;

    // 속도가 빠를수록 사진을 빨리 넘김 (5km/h ≈ 초당 6장, 60km/h ≈ 초당 18장)
    let next = STAND;
    if (kmh >= 0.5) {
      phase = (phase + (5 + Math.min(kmh, 100) * 0.22) * dt) % GALLOP_COUNT;
      next = Math.floor(phase);
    }
    if (next !== shown) {
      img.setAttribute('href', HORSE_FRAMES[next]);
      shown = next;
    }

    roadOff = (roadOff + kmh * dt * 1.6) % 16;
    road.setAttribute('stroke-dashoffset', (-roadOff).toFixed(1));

    // 흙먼지 (뒷발 쪽)
    if (kmh > 20 && Math.random() < dt * kmh / 7) {
      dust.push({ x: 104 + Math.random() * 16, y: 96, r: 1, life: 1 });
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
let receiptBlobReady = Promise.resolve();

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
    ['center', '달리는 말 택시조합'],
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
    ['coffee'],
    ['dsep'],
    ['kv', '결제수단', '마음'],
    ['kv', '승인번호', String(S.start).slice(-8)],
    ['gap'],
    ['horse'],
    ['barcode'],
    ['small', '※ 실제로 청구되지 않습니다. 말이 달렸을 뿐이에요.'],
    ['small', '이용해 주셔서 감사합니다 · 안녕히 가세요'],
  ];
  const H_OF = { title: 58, center: 20, sep: 20, dsep: 22, kv: 25, total: 62, coffee: 48, gap: 6, horse: 84, barcode: 48, small: 19 };
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
    } else if (type === 'coffee') {
      // 친구끼리 보는 영수증이니까: 이 요금이 커피 몇 잔인지 재치로 한 줄
      const cups = Math.max(1, Math.floor(total() / COFFEE_PRICE));
      g.textAlign = 'center'; g.font = `13px ${MONO}`;
      g.fillText(`☕ 이 돈이면 아아 ${cups}잔인데`, CX, y + 13);
      const shown = Math.min(cups, 6);
      const gap = 24, rowW = (shown - 1) * gap, startX = CX - rowW / 2;
      for (let i = 0; i < shown; i++) drawCup(g, startX + i * gap, y + 35, 15);
      if (cups > shown) {
        g.textAlign = 'left'; g.font = `bold 11px ${MONO}`;
        g.fillText(`+${cups - shown}`, startX + shown * gap - 4, y + 35);
      }
    } else if (type === 'horse') {
      await drawReceiptHorse(g, CX - 52, y - 2, 104, INK);
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

/** 영수증용 미니 커피잔 아이콘 (김이 살짝 나는 손잡이 컵). g.fillStyle이 곧 잉크색. */
function drawCup(g, cx, cy, s) {
  const w = s, h = s * 1.05, ink = g.fillStyle;
  g.beginPath();
  g.moveTo(cx - w * 0.34, cy - h * 0.42);
  g.lineTo(cx + w * 0.34, cy - h * 0.42);
  g.lineTo(cx + w * 0.24, cy + h * 0.46);
  g.lineTo(cx - w * 0.24, cy + h * 0.46);
  g.closePath();
  g.fill();
  g.strokeStyle = ink; g.lineWidth = w * 0.13; g.lineCap = 'round';
  g.beginPath(); g.arc(cx + w * 0.42, cy - h * 0.02, w * 0.2, -1, 1); g.stroke();
  for (const dx of [-w * 0.14, w * 0.1]) {
    g.beginPath();
    g.moveTo(cx + dx, cy - h * 0.52);
    g.quadraticCurveTo(cx + dx - w * 0.12, cy - h * 0.72, cx + dx, cy - h * 0.9);
    g.stroke();
  }
}

/** 영수증용: 달리는 프레임 하나를 잉크색으로 칠해서 그림 */
async function drawReceiptHorse(g, x, y, w, ink) {
  const im = horseImages[6];
  if (!im.complete) await new Promise((r) => { im.onload = r; im.onerror = r; });
  if (!im.naturalWidth) return;
  const h = w * im.naturalHeight / im.naturalWidth;
  const off = document.createElement('canvas');
  off.width = im.naturalWidth; off.height = im.naturalHeight;
  const o = off.getContext('2d');
  o.drawImage(im, 0, 0);
  o.globalCompositeOperation = 'source-in';
  o.fillStyle = ink;
  o.fillRect(0, 0, off.width, off.height);
  g.drawImage(off, x, y, w, h);
}


async function showReceipt() {
  const cv = await drawReceipt();
  // toBlob은 안드로이드 WebView에서 수 초씩 걸려서, 빠른 toDataURL로 먼저 보여 줌
  const url = cv.toDataURL('image/png');
  $('#receiptImg').src = url;
  const dlg = $('#receiptDlg');
  if (!dlg.open) dlg.showModal();
  // 웹 공유용 파일은 뒤에서 미리 만들어 둠 (공유 버튼을 누른 순간 바로 쓰도록)
  receiptBlob = null;
  receiptBlobReady = fetch(url).then((r) => r.blob()).then((b) => (receiptBlob = b));
}

async function shareReceipt() {
  if (!$('#receiptImg').src) return;
  const name = `taxi-receipt-${fmtDate(S.end).replace(/[.: ]/g, '')}.png`;
  if (NATIVE) {
    // 앱 안에서는 웹 공유가 없으므로 캐시에 PNG로 저장한 뒤 안드로이드 공유 창을 띄움
    const { Filesystem, Share } = window.Capacitor.Plugins;
    try {
      const data = $('#receiptImg').src.split(',')[1];
      const { uri } = await Filesystem.writeFile({ path: name, data, directory: 'CACHE' });
      await Share.share({ title: '택시 영수증', files: [uri] });
    } catch (e) {
      if (!/cancel/i.test(String(e && e.message))) toast('공유하지 못했어요');
    }
    return;
  }
  if (!receiptBlob) await receiptBlobReady;
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

// 서비스 워커는 웹(PWA)에서만. 앱에는 파일이 이미 들어 있으므로 예전에 등록된 것도 지움
if (NATIVE && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations()
    .then((regs) => regs.forEach((r) => r.unregister()))
    .catch(() => {});
}
if ('serviceWorker' in navigator && location.protocol !== 'file:' && !NATIVE) {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    // 앱으로 돌아올 때마다 새 버전 확인
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch(() => {});
  // 새 버전이 설치되면 한 번 새로고침 (주행 상태는 저장돼 있어 이어짐)
  if (navigator.serviceWorker.controller) {
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!reloaded) { reloaded = true; location.reload(); }
    });
  }
}

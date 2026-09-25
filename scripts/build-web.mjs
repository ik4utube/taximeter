// 앱에 들어갈 웹 파일만 www/ 로 복사한다 (node_modules, android 폴더 등은 제외)
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const FILES = ['index.html', 'style.css', 'app.js', 'sw.js', 'manifest.webmanifest'];
const DIRS = ['icons', 'img'];

rmSync('www', { recursive: true, force: true });
mkdirSync('www');
for (const f of FILES) cpSync(f, `www/${f}`);
for (const d of DIRS) cpSync(d, `www/${d}`, { recursive: true });
console.log('www/ 준비 완료:', [...FILES, ...DIRS.map((d) => `${d}/`)].join(', '));

#!/usr/bin/env node

/**
 * git-approval-gate: Public Push Safety Gate
 *
 * 核心功能：
 * 1. 拦截发往公开 Git 托管平台的未授权推送
 * 2. 依赖自检：检测图形环境与 Chromium 架构浏览器，缺失时抛出排错指引
 * 3. 运行环境自适应降级：
 *    - GUI 桌面：自适应屏幕居中偏上弹出 Chromium 卡片（含 Commits 摘要与文件改动统计）
 *    - SSH 终端：终端 TUI 输出带颜色审计明细，等待手动输入确认
 *    - 无头静默：安全失败 (Fail-Closed)，直接阻断未授权推送
 * 4. 私有远端免审放行：内网 / 私有 SSH 仓库零延迟放行
 */

import http from 'node:http';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

// ============================================================
// 1. 解析目标远端并执行私有仓快路径放行 (Private Fast-Path)
// ============================================================
const remoteName = process.argv[2] || 'origin';
let remoteUrl = process.argv[3] || '';

if (!remoteUrl) {
  try {
    remoteUrl = execSync(`git remote get-url "${remoteName}" 2>/dev/null`, { encoding: 'utf-8' }).trim();
  } catch {
    remoteUrl = '';
  }
}

// 检查是否为私有远端白名单（默认包含内网 IP、localhost、.internal、.local 等通用私有特征）
const defaultPrivatePatterns = [
  /127\.0\.0\.1/,
  /localhost/,
  /192\.168\./,
  /10\.\d+\./,
  /172\.(1[6-9]|2\d|3[01])\./,
  /\.internal\b/,
  /\.local\b/,
  /\.lan\b/
];

// 支持开发者通过 git config 或环境变量自定义私有远端模式
let customPattern = process.env.PUSHGATE_PRIVATE_PATTERN || '';
if (!customPattern) {
  try {
    customPattern = execSync('git config pushgate.privatePattern 2>/dev/null', { encoding: 'utf-8' }).trim();
  } catch {}
}

const privatePatterns = [...defaultPrivatePatterns];
if (customPattern) {
  try {
    privatePatterns.push(new RegExp(customPattern, 'i'));
  } catch {}
}

// 外层 git-time-gate 已按 remote-url 分流；它调用本工具时设置
// PUSHGATE_FORCE_PUBLIC=1，明确要求走公开仓的人工确认，不能再让 URL 子串或
// pushgate.privatePattern 把本次推送降级为“私有免审”。
const isPrivate = process.env.PUSHGATE_FORCE_PUBLIC === '1'
  ? false
  : privatePatterns.some((pattern) => pattern.test(remoteUrl));
if (isPrivate) {
  // 私有仓库推送，0 秒静默放行，不打扰开发
  process.exit(0);
}

// ============================================================
// 2. 收集 Git 待推送差异数据 (Commits & Diff Stat)
// ============================================================
let commitsSummary = '（未检测到新增 commit，可能为标签或无差异推送）';
let diffStats = '';

try {
  const logOut = execSync('git log @{u}..HEAD --oneline -n 15 2>/dev/null || git log -1 --oneline', { encoding: 'utf-8' }).trim();
  if (logOut) commitsSummary = logOut;
} catch {
  try {
    commitsSummary = execSync('git log -1 --oneline', { encoding: 'utf-8' }).trim();
  } catch {}
}

try {
  diffStats = execSync('git diff --stat @{u}..HEAD 2>/dev/null', { encoding: 'utf-8' }).trim();
  if (!diffStats) {
    diffStats = execSync('git show --stat --oneline -s HEAD 2>/dev/null', { encoding: 'utf-8' }).trim();
  }
} catch {}

const repoName = path.basename(process.cwd());

// ============================================================
// 3. 环境探测与浏览器依赖自检 (Dependency Self-Check)
// ============================================================
const hasDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

function checkInteractiveTerminal() {
  if (process.env.PUSHGATE_FORCE_HEADLESS === '1') {
    return false;
  }
  if (process.env.PUSHGATE_TEST_TUI_INPUT === '1') {
    return true;
  }
  // 如果标准输入、标准输出或标准错误任一是 TTY
  if (process.stdin.isTTY || process.stdout.isTTY || process.stderr.isTTY) {
    return true;
  }
  // 作为 Git pre-push hook 运行时，Git 会将 stdin 重定向为 pipe 传入 ref 列表。
  // 检测控制终端 (/dev/tty) 是否存在且可读，以判断是否有用户终端交互环境。
  if (process.platform !== 'win32') {
    try {
      const fd = fs.openSync('/dev/tty', 'r');
      fs.closeSync(fd);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

const isTTY = checkInteractiveTerminal();

let pushgateMode = process.env.PUSHGATE_MODE;
if (!pushgateMode) {
  try {
    pushgateMode = execSync('git config pushgate.mode 2>/dev/null', { encoding: 'utf-8' }).trim();
  } catch {}
}
const forceTui = pushgateMode === 'tui' || process.env.PUSHGATE_FORCE_TUI === '1';

function findChromiumBrowser() {
  if (process.env.MOCK_NO_BROWSER === '1') {
    return null;
  }
  const candidates = [
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'brave-browser',
    'microsoft-edge'
  ];

  for (const bin of candidates) {
    try {
      execSync(`which ${bin} 2>/dev/null`);
      return bin;
    } catch {}
  }
  return null;
}

// ============================================================
// 4. 三态自适应分流 (Adaptive Three-Tier Dispatch)
// ============================================================

// 4.0 显式指定/偏好 TUI 终端模式
if (forceTui && isTTY) {
  runTuiGate();
}
// 4.1 GUI 桌面模式
else if (hasDisplay) {
  const browserBin = findChromiumBrowser();
  if (!browserBin) {
    console.error(`
\x1b[31;1m❌ [git-approval-gate] 依赖缺失报错 (Missing Browser Dependency)\x1b[0m
检测到当前处于图形桌面环境，但系统中未找到 Chromium 架构浏览器！
门禁弹窗需要调用 Chromium 架构浏览器（以 --app 独立卡片模式渲染居中审计框）。

\x1b[33m可被识别的浏览器候选列表：\x1b[0m
  - google-chrome / google-chrome-stable
  - chromium / chromium-browser
  - brave-browser
  - microsoft-edge

\x1b[32m快速安装建议：\x1b[0m
  - Ubuntu / Debian:  sudo apt install -y chromium-browser
  - Fedora / RHEL:    sudo dnf install -y chromium
  - Arch Linux:       sudo pacman -S --noconfirm chromium

\x1b[31m[安全阻断] 为防止未审查推送，Git Push 已终止。\x1b[0m
`);
    process.exit(1);
  }

  runGuiGate(browserBin);
}
// 4.2 SSH 交互式终端模式 (TUI Fallback)
else if (isTTY) {
  runTuiGate();
}
// 4.3 无头非交互环境 (Fail-Closed)
else {
  console.error(`
\x1b[31;1m❌ [git-approval-gate: SECURITY BLOCKED]\x1b[0m
检测到正在向公开远端 (\x1b[33m${remoteUrl || 'public remote'}\x1b[0m) 执行推送！
当前运行环境为【无头 / 非交互】模式（未连接图形会话且无 TTY 交互终端）。
根据人机确认安全原则，公开仓推送必须经由人工交互确认，已阻断推送！
`);
  process.exit(1);
}

// ============================================================
// 5. 模式实现：GUI 居中卡片渲染 (Chromium App)
// ============================================================
function runGuiGate(browserBin) {
  let screenW = 1440;
  let screenH = 900;
  try {
    const xrandrOut = execSync('xrandr --current 2>/dev/null', { encoding: 'utf-8' });
    const match = xrandrOut.match(/connected.*?(\d+)x(\d+)\+(\d+)\+(\d+)/);
    if (match) {
      screenW = parseInt(match[1], 10);
      screenH = parseInt(match[2], 10);
    }
  } catch {}

  const winW = 900;
  const winH = 640;
  const posX = Math.max(0, Math.round((screenW - winW) / 2));
  const posY = Math.max(0, Math.round(screenH * 0.36 - winH / 2));

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  let chromeProcess = null;
  let resolved = false;

  function finish(code) {
    if (resolved) return;
    resolved = true;
    if (chromeProcess && chromeProcess.pid) {
      try {
        process.kill(-chromeProcess.pid, 'SIGKILL');
      } catch {
        try { chromeProcess.kill('SIGKILL'); } catch {}
      }
    }
    server.close(() => {
      if (code !== 0) {
        console.error('\n\x1b[31m❌ [SECURITY BLOCKED] 公开仓推送已被用户 GUI 拒绝或超时！\x1b[0m');
      } else {
        console.log('\n\x1b[32m✅ [SECURITY PASSED] 已获得用户 GUI 显式授权，放行本次推送。\x1b[0m');
      }
      process.exit(code);
    });
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/allow') {
      res.end('ok');
      finish(0);
    } else if (req.url === '/deny') {
      res.end('ok');
      finish(1);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>🚨 公开仓推送权限门禁 (git-approval-gate)</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #181825; color: #cdd6f4;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    padding: 22px 24px; display: flex; flex-direction: column; justify-content: space-between;
    height: 100vh; user-select: none;
  }
  .header { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
  .icon { font-size: 26px; }
  .title { font-size: 17px; font-weight: 700; color: #f38ba8; letter-spacing: 0.5px; }
  .desc { font-size: 13px; line-height: 1.45; color: #a6adc8; margin-bottom: 12px; }
  .meta-box {
    background: #1e1e2e; border: 1px solid #313244; border-radius: 8px;
    padding: 8px 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px; color: #89b4fa; line-height: 1.5; margin-bottom: 12px;
  }
  .meta-box span { color: #6c7086; }
  .section-label {
    font-size: 12px; font-weight: 600; color: #fab387; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;
  }
  .scroll-box {
    background: #11111b; border: 1px solid #313244; border-radius: 8px;
    padding: 10px 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11.5px; color: #a6e3a1; line-height: 1.5; max-height: 155px;
    overflow-y: auto; white-space: pre-wrap; word-break: break-all;
    margin-bottom: 14px;
  }
  .footer { display: flex; justify-content: space-between; align-items: center; border-top: 1px solid #313244; padding-top: 14px; }
  .timer { font-size: 12px; color: #6c7086; }
  .btn-group { display: flex; gap: 10px; }
  button {
    padding: 9px 20px; border-radius: 6px; font-size: 13px; font-weight: 600;
    cursor: pointer; border: none; transition: opacity 0.15s;
  }
  button:hover { opacity: 0.85; }
  .btn-deny { background: #313244; color: #f38ba8; border: 1px solid #45475a; }
  .btn-allow { background: #a6e3a1; color: #11111b; }
</style>
</head>
<body>
  <div>
    <div class="header">
      <div class="icon">🚨</div>
      <div class="title">公开仓推送安全审计门禁</div>
    </div>
    <div class="desc">
      检测到代码推送请求！该操作将代码合并推送到 <b>GitHub 公开版本</b>。<br>
      请核实以下准备发布的 Commit 详情与文件变动明细：
    </div>
    <div class="meta-box">
      <div><span>目标仓库:</span> ${escapeHtml(repoName)}</div>
      <div><span>远端地址:</span> ${escapeHtml(remoteUrl || 'origin')}</div>
    </div>
    <div class="section-label">📋 即将同步推向公开仓的内容 (Commits & Diff Stat)</div>
    <div class="scroll-box"><b>[Commits 摘要]</b>\n${escapeHtml(commitsSummary)}\n\n<b>[变更统计]</b>\n${escapeHtml(diffStats || '无本地未推文件变更')}</div>
  </div>
  <div class="footer">
    <div class="timer" id="timer">120 秒后自动拦截</div>
    <div class="btn-group">
      <button class="btn-deny" onclick="action('/deny')">❌ 拒绝拦截 (Esc)</button>
      <button class="btn-allow" onclick="action('/allow')">✅ 授权推送 (Enter)</button>
    </div>
  </div>
  <script>
    let left = 120;
    const timerEl = document.getElementById('timer');
    const interval = setInterval(() => {
      left--;
      if (left <= 0) {
        clearInterval(interval);
        action('/deny');
      } else {
        timerEl.innerText = left + ' 秒后自动拦截';
      }
    }, 1000);

    function action(endpoint) {
      clearInterval(interval);
      fetch(endpoint).finally(() => {
        try { window.close(); } catch {}
      });
      setTimeout(() => {
        try { window.close(); } catch {}
      }, 60);
    }

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') action('/deny');
      if (e.key === 'Enter') action('/allow');
    });
  </script>
</body>
</html>`);
    }
  });

  const listenPort = parseInt(process.env.PUSHGATE_PORT, 10) || 0;
  server.listen(listenPort, '127.0.0.1', () => {
    const port = server.address().port;
    const cdpPort = parseInt(process.env.PUSHGATE_CDP_PORT, 10) || 0;
    if (process.env.PUSHGATE_TEST_MODE === '1') {
      console.log(`[PUSHGATE_READY] port=${port} cdp=${cdpPort}`);
    }

    const profileDir = process.env.PUSHGATE_PROFILE_DIR || '/tmp/git-approval-gate-profile';

    const chromeArgs = [
      `--app=http://127.0.0.1:${port}`,
      `--window-size=${winW},${winH}`,
      `--window-position=${posX},${posY}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages'
    ];

    if (cdpPort > 0) {
      chromeArgs.push(`--remote-debugging-port=${cdpPort}`);
    }

    if (process.env.CI || (typeof process.getuid === 'function' && process.getuid() === 0)) {
      chromeArgs.push('--no-sandbox', '--disable-gpu');
    }

    chromeProcess = spawn(browserBin, chromeArgs, {
      stdio: 'ignore',
      detached: true
    });

    // 提醒：卡片可能落在其它窗口或虚拟桌面后面，必须给出跨平台的正反馈。
    // 注意：spawn 的 ENOENT 是异步 'error' 事件，try/catch 捕不到，必须挂 error 监听，
    // 否则进程会因未捕获异常直接崩溃（2026-11-03 实测踩过）。
    const notify = (bin, args) => {
      try {
        const child = spawn(bin, args, { stdio: 'ignore', detached: true });
        child.on('error', () => {});
        child.unref();
      } catch {}
    };

    if (process.platform === 'linux') {
      notify('notify-send', ['-u', 'critical', '-a', 'git-approval-gate',
        '公开仓推送待授权', '请到授权卡片上点击「✅ 授权推送」']);
      try { fs.writeSync(fs.openSync('/dev/tty', 'w'), '\x07'); } catch {}
    } else {
      notify('powershell.exe', ['-NoProfile', '-Command', '[console]::beep(880,400)']);
    }

    // 终端里也留一行，避免"窗口被遮挡 = 完全无感"。
    try {
      fs.writeSync(fs.openSync('/dev/tty', 'w'),
        '\n🔔 已弹出公开仓推送授权卡片（Chromium 独立窗口，约 900×640，居中偏上）。\n' +
        '   若没看到，请检查其它窗口 / 虚拟桌面；121 秒内未确认会自动拒绝。\n\n');
    } catch {
      console.error('\n🔔 已弹出公开仓推送授权卡片；121 秒内未确认会自动拒绝。\n');
    }

    chromeProcess.on('exit', () => {
      finish(1);
    });
  });

  setTimeout(() => {
    finish(1);
  }, 121000);
}

// ============================================================
// 6. 模式实现：交互式终端模式 (Terminal TUI Mode)
// ============================================================
function runTuiGate() {
  let inputStream = process.stdin;
  let outputStream = process.stdout;
  let ttyInFd = null;
  let ttyOutStream = null;

  // 在 Git pre-push hook 中，stdin/stdout 会被 pre-commit 等管道重定向。
  // 非测试环境下，优先通过 /dev/tty 接管输入输出，防止 pre-commit 缓冲输出导致提示语被吞。
  if (process.env.PUSHGATE_TEST_TUI_INPUT !== '1' && process.platform !== 'win32') {
    try {
      ttyInFd = fs.openSync('/dev/tty', 'r');
      inputStream = fs.createReadStream(null, { fd: ttyInFd });
    } catch {}
    try {
      const ttyOutFd = fs.openSync('/dev/tty', 'w');
      ttyOutStream = fs.createWriteStream(null, { fd: ttyOutFd });
      outputStream = ttyOutStream;
    } catch {}
  }

  function print(msg = '') {
    if (ttyOutStream) {
      ttyOutStream.write(msg + '\n');
    } else {
      console.log(msg);
    }
  }

  print('\n\x1b[35;1m====================================================================\x1b[0m');
  print('\x1b[31;1m🚨 [git-approval-gate] 公开仓推送安全审计门禁 (TTY 终端交互模式)\x1b[0m');
  print('\x1b[35;1m====================================================================\x1b[0m');
  print(`\x1b[34m目标仓库:\x1b[0m ${repoName}`);
  print(`\x1b[34m远端地址:\x1b[0m ${remoteUrl}`);
  print('\n\x1b[33;1m📋 [Commits 摘要]\x1b[0m');
  print(commitsSummary);
  print('\n\x1b[36;1m📊 [变更统计]\x1b[0m');
  print(diffStats || '无本地未推文件变更');
  print('\x1b[35m--------------------------------------------------------------------\x1b[0m');

  const rl = readline.createInterface({
    input: inputStream,
    output: outputStream
  });

  const cleanup = () => {
    rl.close();
    if (ttyInFd !== null) {
      try { fs.closeSync(ttyInFd); } catch {}
    }
  };

  const timer = setTimeout(() => {
    print('\n\x1b[31m❌ [超时拦截] 30 秒无输入，已自动终止推送！\x1b[0m');
    cleanup();
    process.exit(1);
  }, 30000);

  rl.question('\x1b[32;1m确认授权本次公开推送？输入 "yes" 放行，其它任意键拒绝 (30s 超时): \x1b[0m', (answer) => {
    clearTimeout(timer);
    cleanup();
    if (answer.trim().toLowerCase() === 'yes') {
      print('\x1b[32m✅ [SECURITY PASSED] 已获得人工确认，放行本次推送。\x1b[0m\n');
      process.exit(0);
    } else {
      print('\x1b[31m❌ [SECURITY BLOCKED] 用户已拒绝本次公开推送！\x1b[0m\n');
      process.exit(1);
    }
  });
}

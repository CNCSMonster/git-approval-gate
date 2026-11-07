#!/usr/bin/env node

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gateBinPath = path.resolve(__dirname, '../bin/git-approval-gate.mjs');

let passedCount = 0;
let totalCount = 0;

async function runTestCase(name, fn) {
  totalCount++;
  process.stdout.write(`▶ 运行测试 [${totalCount}]: ${name} ... `);
  try {
    await fn();
    passedCount++;
    console.log('\x1b[32m✔ 通过\x1b[0m');
  } catch (err) {
    console.log('\x1b[31m✖ 失败\x1b[0m');
    console.error(err);
    process.exitCode = 1;
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    s.on('error', reject);
  });
}

function runProcess(args, env = {}, stdinInput = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [gateBinPath, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    if (stdinInput !== null) {
      child.stdin.write(stdinInput);
      child.stdin.end();
    } else {
      child.stdin.end();
    }

    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });

    child.on('error', reject);
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

/**
 * 原生零依赖 CDP 指令执行器 (向 Chrome 发送 Runtime.evaluate)
 */
/**
 * 纯原生零依赖 CDP 指令执行器 (纯 TCP 协议实现，跨 Node 18~24 绝对稳定)
 */
function sendCdpEval(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const url = new URL(wsUrl);
    const client = net.connect(parseInt(url.port, 10), url.hostname, () => {
      const key = crypto.randomBytes(16).toString('base64');
      const req = [
        `GET ${url.pathname} HTTP/1.1`,
        `Host: ${url.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '\r\n'
      ].join('\r\n');
      client.write(req);
    });

    let handshaken = false;
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      client.destroy();
      reject(new Error('CDP 指令响应超时 (5s)'));
    }, 5000);

    client.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshaken) {
        const headerEnd = buf.indexOf('\r\n\r\n');
        if (headerEnd !== -1) {
          handshaken = true;
          const payload = Buffer.from(JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: { expression }
          }));
          const mask = crypto.randomBytes(4);
          const masked = Buffer.alloc(payload.length);
          for (let i = 0; i < payload.length; i++) {
            masked[i] = payload[i] ^ mask[i % 4];
          }

          let frameHeader;
          if (payload.length < 126) {
            frameHeader = Buffer.from([0x81, 0x80 | payload.length]);
          } else {
            frameHeader = Buffer.alloc(4);
            frameHeader[0] = 0x81;
            frameHeader[1] = 0x80 | 126;
            frameHeader.writeUInt16BE(payload.length, 2);
          }
          client.write(Buffer.concat([frameHeader, mask, masked]));
          buf = buf.subarray(headerEnd + 4);
        }
      }
      if (handshaken && buf.length > 2) {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        client.destroy();
        resolve(buf.toString('utf-8'));
      }
    });

    client.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      reject(err);
    });

    client.on('close', () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * 轮询等待 Chrome 渲染就绪并获取页面的 CDP 调试 WebSocket 链接
 */
async function waitForPageDebuggerUrl(cdpPort, expectedPort, maxWaitMs = 15000) {
  const start = Date.now();
  const targetPrefix = `http://127.0.0.1:${expectedPort}`;
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await httpGet(`http://127.0.0.1:${cdpPort}/json`);
      if (res.statusCode === 200) {
        const targets = JSON.parse(res.body);
        const page = targets.find((t) => t.type === 'page' && t.url && t.url.startsWith(targetPrefix));
        if (page && page.webSocketDebuggerUrl) {
          return page.webSocketDebuggerUrl;
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`在 ${maxWaitMs}ms 内未能在 Chrome CDP (${cdpPort}) 中找到目标页面 (${targetPrefix})`);
}

console.log('\n========================================');
console.log('🧪 开始运行 git-approval-gate 自动化测试套件');
console.log('========================================\n');

// -------------------------------------------------------------
// 测试 1：私有远端免审放行 (RFC 1918 / localhost / .internal)
// -------------------------------------------------------------
await runTestCase('私有仓免审放行 (192.168.x.x 内网)', async () => {
  const res = await runProcess(['origin', 'git@192.168.1.50:org/repo.git']);
  assert.strictEqual(res.code, 0, `私有仓应该以 0 退出，实际退出码: ${res.code}`);
});

await runTestCase('私有仓免审放行 (localhost)', async () => {
  const res = await runProcess(['origin', 'ssh://git@localhost:2222/repo.git']);
  assert.strictEqual(res.code, 0, `localhost 应该以 0 退出，实际退出码: ${res.code}`);
});

await runTestCase('私有仓免审放行 (.internal 域名)', async () => {
  const res = await runProcess(['origin', 'https://git.company.internal/core.git']);
  assert.strictEqual(res.code, 0, `.internal 应该以 0 退出，实际退出码: ${res.code}`);
});

// -------------------------------------------------------------
// 测试 2：无头 / 非交互环境下向公开远端推送必须安全阻断 (Fail-Closed)
// -------------------------------------------------------------
await runTestCase('无头非交互模式安全阻断 (退出码应为 1)', async () => {
  const res = await runProcess(
    ['origin', 'https://github.com/CNCSMonster/git-approval-gate.git'],
    {
      DISPLAY: '',
      WAYLAND_DISPLAY: '',
      SSH_CONNECTION: '',
      PUSHGATE_FORCE_HEADLESS: '1'
    }
  );
  assert.strictEqual(res.code, 1, `无头模式遇到公开仓必须以 1 退出，实际退出码: ${res.code}`);
  assert.ok(res.stderr.includes('SECURITY BLOCKED'), '应输出安全阻断提示');
});

// -------------------------------------------------------------
// 测试 3：终端 TUI 交互模式测试 (用户输入授权放行与拒绝)
// -------------------------------------------------------------
await runTestCase('终端 TUI 交互：用户输入 "yes" 放行 (退出码应为 0)', async () => {
  const res = await runProcess(
    ['origin', 'https://github.com/CNCSMonster/git-approval-gate.git'],
    {
      DISPLAY: '',
      WAYLAND_DISPLAY: '',
      PUSHGATE_TEST_TUI_INPUT: '1'
    },
    'yes\n'
  );
  assert.strictEqual(res.code, 0, `输入 yes 应授权通过，实际退出码: ${res.code}`);
  assert.ok(res.stdout.includes('SECURITY PASSED'), '输出应包含放行标识');
});

await runTestCase('终端 TUI 交互：用户输入非 yes 拒绝 (退出码应为 1)', async () => {
  const res = await runProcess(
    ['origin', 'https://github.com/CNCSMonster/git-approval-gate.git'],
    {
      DISPLAY: '',
      WAYLAND_DISPLAY: '',
      PUSHGATE_TEST_TUI_INPUT: '1'
    },
    'no\n'
  );
  assert.strictEqual(res.code, 1, `输入 no 应拒绝推送，实际退出码: ${res.code}`);
  assert.ok(res.stdout.includes('SECURITY BLOCKED'), '输出应包含阻断标识');
});

// -------------------------------------------------------------
// 测试 3：真实 GUI 端到端测试 (CDP 真实 DOM 点击触发测试)
// -------------------------------------------------------------
const hasDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

if (!hasDisplay) {
  console.log('\nℹ️ 当前环境无图形会话 ($DISPLAY)，跳过真实 GUI 交互测试。');
  console.log('  （提示：CI 环境中通过 xvfb-run 会自动启用完整 GUI 交互测试）');
} else {
  await runTestCase('真实 GUI 端到端：CDP 真实点击「授权推送」按钮 (.btn-allow)', async () => {
    const cdpPort = await getFreePort();
    const profileDir = `/tmp/pushgate-test-profile-${Date.now()}-allow`;
    const child = spawn(process.execPath, [gateBinPath, 'origin', 'https://github.com/CNCSMonster/git-approval-gate.git'], {
      env: {
        ...process.env,
        PUSHGATE_TEST_MODE: '1',
        PUSHGATE_CDP_PORT: String(cdpPort),
        PUSHGATE_PROFILE_DIR: profileDir
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let port = null;

    const childExitPromise = new Promise((resolve) => {
      if (child.exitCode !== null) resolve(child.exitCode);
      else child.on('close', resolve);
    });

    const readyPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('等待 GUI 弹窗就绪超时 (15s)'));
      }, 15000);

      child.stdout.on('data', (d) => {
        stdout += d.toString();
        const match = stdout.match(/\[PUSHGATE_READY\] port=(\d+)/);
        if (match && !port) {
          port = parseInt(match[1], 10);
          clearTimeout(timeout);
          resolve(port);
        }
      });
      child.on('error', reject);
    });

    const serverPort = await readyPromise;
    assert.ok(serverPort > 0, '未成功获取本地服务端口');

    // 1. 等待 Chrome 真实完成页面加载并获取该页面的 WebSocket 调试通道
    const wsDebuggerUrl = await waitForPageDebuggerUrl(cdpPort, serverPort);
    assert.ok(wsDebuggerUrl, '未能成功连接 Chrome 页面调试通道');

    // 2. 通过 Chrome 原生 CDP，轮询等待 DOM 渲染并真实触发 .btn-allow 点击
    let clicked = false;
    for (let i = 0; i < 50; i++) {
      if (child.exitCode !== null) {
        clicked = true;
        break;
      }
      try {
        const evalRes = await sendCdpEval(wsDebuggerUrl, `
          (function() {
            const btn = document.querySelector('.btn-allow');
            if (btn) { btn.click(); return 'clicked'; }
            return 'not_found';
          })()
        `);
        if ((evalRes && evalRes.includes('clicked')) || child.exitCode !== null) {
          clicked = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(clicked, '未能成功在 Chrome 页面中点击 .btn-allow 按钮');

    // 3. 验证整个系统链路如期以 0 退出，放行本次推送
    const exitCode = await childExitPromise;
    assert.strictEqual(exitCode, 0, `真实点击授权推送按钮后，退出码应为 0，实际退出码: ${exitCode}`);
  });

  await runTestCase('真实 GUI 端到端：CDP 真实点击「拒绝拦截」按钮 (.btn-deny)', async () => {
    const cdpPort = await getFreePort();
    const profileDir = `/tmp/pushgate-test-profile-${Date.now()}-deny`;
    const child = spawn(process.execPath, [gateBinPath, 'origin', 'https://github.com/CNCSMonster/git-approval-gate.git'], {
      env: {
        ...process.env,
        PUSHGATE_TEST_MODE: '1',
        PUSHGATE_CDP_PORT: String(cdpPort),
        PUSHGATE_PROFILE_DIR: profileDir
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let port = null;

    const childExitPromise = new Promise((resolve) => {
      if (child.exitCode !== null) resolve(child.exitCode);
      else child.on('close', resolve);
    });

    const readyPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('等待 GUI 弹窗就绪超时 (15s)'));
      }, 15000);

      child.stdout.on('data', (d) => {
        stdout += d.toString();
        const match = stdout.match(/\[PUSHGATE_READY\] port=(\d+)/);
        if (match && !port) {
          port = parseInt(match[1], 10);
          clearTimeout(timeout);
          resolve(port);
        }
      });
      child.on('error', reject);
    });

    const serverPort = await readyPromise;
    assert.ok(serverPort > 0, '未成功获取本地服务端口');

    // 1. 等待 Chrome 真实完成页面加载并获取调试通道
    const wsDebuggerUrl = await waitForPageDebuggerUrl(cdpPort, serverPort);
    assert.ok(wsDebuggerUrl, '未能成功连接 Chrome 页面调试通道');

    // 2. 通过 Chrome 原生 CDP，轮询等待 DOM 渲染并真实触发 .btn-deny 点击
    let clicked = false;
    for (let i = 0; i < 50; i++) {
      if (child.exitCode !== null) {
        clicked = true;
        break;
      }
      try {
        const evalRes = await sendCdpEval(wsDebuggerUrl, `
          (function() {
            const btn = document.querySelector('.btn-deny');
            if (btn) { btn.click(); return 'clicked'; }
            return 'not_found';
          })()
        `);
        if ((evalRes && evalRes.includes('clicked')) || child.exitCode !== null) {
          clicked = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(clicked, '未能成功在 Chrome 页面中点击 .btn-deny 按钮');

    // 3. 验证系统链路如期以 1 退出，安全阻断本次推送
    const exitCode = await childExitPromise;
    assert.strictEqual(exitCode, 1, `真实点击拒绝拦截按钮后，退出码应为 1，实际退出码: ${exitCode}`);
  });
}

console.log('\n----------------------------------------');
console.log(`🎉 测试完成: ${passedCount}/${totalCount} 通过`);
console.log('----------------------------------------\n');

if (passedCount !== totalCount) {
  process.exit(1);
}

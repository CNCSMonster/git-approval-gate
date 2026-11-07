# git-approval-gate: 公开仓推送安全审计门禁

[English](./README.md) | 简体中文

> **AI 编程时代的人机确认与推送门禁**  
> 拦截向公开 Git 托管平台（GitHub、Gitee、GitLab 等）的未授权推送。推送前在屏幕正中偏上方弹出轻量卡片，展示待推送 Commit 列表与文件改动统计（Diff Stat），防止 Agent 静默推送未就绪或敏感代码。

---

## 💡 为什么需要它？

在深度使用 Cursor、Pi、Claude Code、Aider 等自主编程智能体（AI Coding Agents）时，智能体拥有极高的终端执行权限。一旦智能体产生幻觉或受到 Prompt 注入影响，可能在后台直接执行 `git push origin main`，将包含内部凭据、未脱敏内容或未测试代码推送到 GitHub 公开仓库。

**`git-approval-gate` 在 Git 发起网络传输前设立拦截屏障**：
- **私有仓免审放行**：推向内网服务器、本地 bare 仓或私有云时静默放行，不打断正常开发流程；
- **公开仓强制审查**：推向 GitHub 等公网托管平台时，必须由开发者在桌面弹窗或终端交互中确认；
- **变更透明可见**：弹窗自动提取并展示**即将推送的 Commit 摘要与文件改动行数统计（Diff Stat）**；
- **自适应居中**：根据显示器分辨率动态计算窗口坐标，默认居中偏上显示，避免窗口被边缘遮挡或在多显示器环境下偏移。

---

## 🛠️ 系统依赖要求 (Prerequisites)

使用本工具前，请确保系统已安装以下组件：

| 依赖组件 | 必需性 | 作用说明 | 安装指引 |
| :--- | :--- | :--- | :--- |
| **pre-commit** | 必需 | 管理与调度 Git 钩子 | `pip install pre-commit` 或 `brew install pre-commit` 或 `sudo apt install pre-commit` |
| **Node.js (>= 18)** | 必需 | 门禁脚本运行环境 | `node -v` 检查版本，[官网下载](https://nodejs.org/) 或通过系统包管理器安装 |
| **Chromium 内核浏览器** | 图形环境必需 | 渲染轻量模态卡片 | 见下方安装指引（无图形会话时自动降级为终端 TTY 交互） |
| **xrandr** | 可选（推荐） | 获取多显示器分辨率以实现居中定位 | 缺失时自动回退到 1440×900 基准居中坐标 |

### 浏览器安装建议 (支持任一 Chromium 系列浏览器)：
- **Ubuntu / Debian**: `sudo apt install -y chromium-browser` 或 `google-chrome-stable`
- **Fedora / RHEL**: `sudo dnf install -y chromium`
- **Arch Linux**: `sudo pacman -S --noconfirm chromium`
- **macOS**: 自动识别系统中已安装的 Google Chrome、Chromium、Brave 或 Microsoft Edge。

---

## 🚀 安装与使用

推荐通过 **`pre-commit`** 框架进行配置与管理。

### 方式一：零侵入本地模式（推荐：仅本地生效，不改动代码库文件）
如果您只想在当前本机的仓库中启用，且**不想向代码库提交任何新配置文件**：

#### 终端一键配置与安装：
```bash
# 1. 在本地 .git/ 内部写入锁定提交哈希的私有配置：
cat << 'EOF' > .git/pre-commit-config.yaml
repos:
  - repo: https://github.com/CNCSMonster/git-approval-gate
    rev: 258340a7510b474402a1093f806a9950c197931e
    hooks:
      - id: public-push-gui-gate
EOF

# 2. 激活生效（仅写入 .git/hooks/pre-push，工作区零文件改动）：
pre-commit install --config .git/pre-commit-config.yaml --hook-type pre-push
```

### 方式二：团队共享模式（随代码仓库协同）
如果您希望团队成员在克隆项目后均受到门禁保护：
在项目根目录创建 `.pre-commit-config.yaml`：
```yaml
repos:
  - repo: https://github.com/CNCSMonster/git-approval-gate
    rev: 258340a7510b474402a1093f806a9950c197931e
    hooks:
      - id: public-push-gui-gate
```
团队成员克隆后执行一次激活命令即可：
```bash
pre-commit install --hook-type pre-push
```

### 方式三：配置私有远端白名单
门禁默认会自动识别常见私有网络标识（RFC 1918 私有 IP、`localhost`、`.internal`、`.local`、`.lan`）并直接放行。
若团队使用自定义私有域名或跳板机，可配置白名单正则表达式：
```bash
# 在全局或当前仓库中配置私有域名白名单：
git config --global pushgate.privatePattern "my-private-host|git\.mycompany\.com"
```

---

## 🧪 安装验证与测试

配置完成后，可通过 Git 的 `--dry-run` 选项测试门禁是否生效，无需真正推送代码：

```bash
# 执行模拟推送（不会对远程仓库产生任何实际影响）
git push --dry-run origin <你的分支名>
```
- **预期行为**：若远端属于公开托管平台，屏幕中央会弹出卡片并列出即将推送的 Commit 列表；
- 点击 **“❌ 拒绝拦截”** 或按 **`Esc`** 键，推送将终止并输出拦截提示。

---

## 🛡️ 多环境运行与自动降级机制

无论在本地图形工作站、远程服务器还是 CI/CD 流水线，门禁均能自适应匹配相应的确认方式：

```
[检测到向公开 Git 托管平台发起推送]
                 │
                 ├── 1. 图形桌面 ($DISPLAY / $WAYLAND) ──▶ 弹出轻量卡片 (支持鼠标/快捷键确认)
                 │
                 ├── 2. 交互式终端 (SSH / TTY)         ──▶ 终端输出差异统计 + 输入 "yes" 确认
                 │
                 └── 3. 非交互/无头环境 (CI / Agent)   ──▶ 安全失败 (Fail-Closed)：退出码 1 阻断推送
```

---

## 🔒 供应链安全与版本哈希锁定

很多开发者会顾虑：**“如果上游开源 Hook 仓库被篡改，是否会导致本地凭据或代码泄露？”**

本项目遵循**零依赖、低代码量、提交哈希锁定**的原则：

1. **零第三方依赖**：
   本工具未引入任何第三方 npm 依赖包，核心逻辑全部位于 [`bin/git-approval-gate.mjs`](./bin/git-approval-gate.mjs) 单一文件中（约 200 行原生 Node.js 代码），代码可快速通读审计，确保不存在未授权的网络请求。
2. **为什么推荐锁定 40 位 Commit 哈希而非 Release 标签？**
   - Git 标签（如 `v1.0.0`）在上游可被强制移动（Force Push）；
   - 40 位 **Commit SHA** 是基于提交内容的密码学哈希。代码若发生任何改动，哈希值都会改变；
   - 在配置中直接锁定特定的 Commit SHA，能确保本地运行的代码与审计时的代码字节级一致。
3. **如何查询目标版本的 Commit 哈希？**
   ```bash
   # 使用 Git 原生命令查询远程标签对应的真实哈希：
   git ls-remote https://github.com/CNCSMonster/git-approval-gate.git refs/tags/v1.0.0
   ```
   输出示例：`258340a7510b474402a1093f806a9950c197931e`，将该哈希填入 `rev:` 字段即可。

---

## ⚠️ 边界说明与卸载指引

1. **关于 `--no-verify` 参数**：
   本工具基于 Git 客户端钩子。若推送命令显式指定了 `--no-verify`，Git 会跳过全部预检脚本。建议在 AI Agent 的系统规则中明确禁止使用 `--no-verify`。
2. **卸载与临时停用**：
   - **卸载门禁**：
     ```bash
     pre-commit uninstall --hook-type pre-push
     ```
   - **单次临时绕过**（仅限人工紧急排障）：
     ```bash
     git push --no-verify origin <分支名>
     ```

---

## 📄 License
MIT License.

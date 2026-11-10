# git-approval-gate: Public Push Safety Gate

English | [简体中文](./README.zh-CN.md)

> **The human-in-the-loop safety airgap for the AI Agent era.**  
> Intercepts unauthorized pushes to public Git remotes (GitHub, Gitee, GitLab). Audits pending commits and diffs in an ergonomically centered modal before network transfer.

---

## 💡 Why git-approval-gate?

Autonomous coding agents (Cursor, Pi, Claude Code, Aider) operate with elevated terminal privileges. If an agent hallucinates or encounters prompt injection, it might silently execute `git push origin main` and leak internal credentials or unverified code directly to public GitHub repositories.

**`git-approval-gate` establishes a safety guard before Git network transmission:**
- **Zero Friction on Private Remotes**: Pushes to internal bare repos, private SSH remotes, or VPN subnets proceed in **0.00s silently** without interrupting flow;
- **Mandatory Review on Public Remotes**: Pushes to public hosts (GitHub, GitLab, etc.) **strictly require physical human confirmation**;
- **Transparent Commits & Diff Stat**: Automatically inspects and displays **pending commit titles and file change statistics (Diff Stat)** in a scrollable panel;
- **Adaptive Centering**: Dynamically calculates screen coordinates to place the modal in the upper-center foveal vision zone, preventing corner occlusions.

---

## 🛠️ System Prerequisites

Ensure the following components are installed before using the gate:

| Component | Necessity | Purpose | Installation Guide |
| :--- | :--- | :--- | :--- |
| **pre-commit** | Required | Manages and triggers Git hooks | `pip install pre-commit` or `brew install pre-commit` or `sudo apt install pre-commit` |
| **Node.js (>= 18)** | Required | Core gate runner | Check via `node -v`, install from [nodejs.org](https://nodejs.org/) or your package manager |
| **Chromium-based Browser** | Required in GUI | Renders the centered modal card | See browser installation guides below (falls back to TTY in terminal sessions) |
| **xrandr** | Recommended | Detects display resolution for geometric centering | Falls back to standard 1440×900 centered coordinates |

### Browser Installation (Pick any Chromium flavor):
- **Ubuntu / Debian**: `sudo apt install -y chromium-browser` or `google-chrome-stable`
- **Fedora / RHEL**: `sudo dnf install -y chromium`
- **Arch Linux**: `sudo pacman -S --noconfirm chromium`
- **macOS**: Automatically detects installed Google Chrome, Chromium, Brave, or Microsoft Edge.

---

## 🚀 Installation & Usage

Declaratively installable via the industry-standard **`pre-commit`** framework.

### Approach 1: Zero-Pollution Private Mode (Recommended)
If you want the gate active in your local project without committing any new files (since `.git/` is Git's private folder, it will never be tracked, committed, or leaked):

#### [One-Liner Automation] Run directly in your terminal:
```bash
# 1. Write the cryptographically pinned private config:
cat << 'EOF' > .git/pre-commit-config.yaml
repos:
  - repo: https://github.com/CNCSMonster/git-approval-gate
    rev: 258340a7510b474402a1093f806a9950c197931e
    hooks:
      - id: public-push-gui-gate
EOF

# 2. Activate pre-push gate (touches only .git/hooks/pre-push, 0 working tree files added):
pre-commit install --config .git/pre-commit-config.yaml --hook-type pre-push
```

### Approach 2: Team Shared Mode (Collaborative Repository Tracking)
If you want every developer to be protected after cloning:
Create `.pre-commit-config.yaml` at your repository root:
```yaml
repos:
  - repo: https://github.com/CNCSMonster/git-approval-gate
    rev: 258340a7510b474402a1093f806a9950c197931e
    hooks:
      - id: public-push-gui-gate
```
Team members enable it with a single command:
```bash
pre-commit install --hook-type pre-push
```

### Approach 3: Custom Private Remote Whitelist
By default, standard private subnets (RFC 1918 private IPs, `localhost`, `.internal`, `.local`, `.lan`) pass silently without review.
You can configure custom private hosts via Git config:
```bash
# Set global or local regex whitelist:
git config --global pushgate.privatePattern "my-private-host|git\.mycompany\.com"
```

> When invoked by an outer gate that has already classified the remote as public, the caller sets `PUSHGATE_FORCE_PUBLIC=1`. This skips the private fast-path, so a broad `privatePattern` cannot silently approve a public push.

---

## 🧪 Verification & Testing

Verify that the gate is properly configured without actually pushing code to the remote:

```bash
# Perform a dry-run push (does not affect remote repositories)
git push --dry-run origin <your-branch>
```
- **Expected Outcome**: If pushing to GitHub or public remotes, a modal card will pop up in the upper center of your screen;
- Click **"❌ 拒绝拦截"** or press **`Esc`** to abort the push and observe the security block message.

---

## 🛡️ Runtime Adaptation & Fallback Strategy

The gate automatically adapts its confirmation mechanism across workstations, remote SSH sessions, and CI/headless environments:

```
[Push to Public Git Remote Detected]
                 │
                 ├── 1. Graphical Desktop ($DISPLAY / $WAYLAND) ──▶ Centered Modal Card (Mouse / Keyboard)
                 │
                 ├── 2. Remote SSH Interactive TTY             ──▶ Terminal ANSI Diff Stat + type "yes"
                 │
                 └── 3. Headless / Non-Interactive (Agent / CI) ──▶ Fail-Closed (exit code 1 block)
```

---

## 🔒 Supply Chain Safety & Tamper-Proof Pinning

Many engineers ask: **"What if an upstream open-source hook repository gets compromised and leaks my private code or credentials?"**

To eliminate supply chain risks entirely, this project adheres to the **zero-dependency, quick-audit, and cryptographic pinning** doctrine:

1. **Zero Third-Party Dependencies (Auditable in minutes)**:
   This tool has no bloated npm dependencies. The entire logic lives in a single file [`bin/git-approval-gate.mjs`](./bin/git-approval-gate.mjs) (~200 lines of standard Node.js). You or your security team can inspect the entire codebase line-by-line within minutes to confirm there are zero hidden network calls.
2. **Why pin the 40-character Commit SHA instead of tags?**
   - Floating tags (e.g. `v1.0.0`) could theoretically be reassigned by an upstream attacker;
   - A Git **40-character Commit SHA** is calculated from all repository files. **If an attacker changes even a single whitespace in the code, the hash changes completely.**
   - By pinning the exact 40-character SHA instead of a tag, you guarantee that the code running on your machine matches the audited source byte-for-byte.
3. **How to inspect the commit hash for any future release?**
   ```bash
   # Retrieve the exact 40-character commit hash for a tag using native Git:
   git ls-remote https://github.com/CNCSMonster/git-approval-gate.git refs/tags/v1.0.0
   ```
   Output: `258340a7510b474402a1093f806a9950c197931e`. Simply paste that hash into the `rev:` field.

---

## ⚠️ Security Boundaries & Uninstallation

1. **Regarding the `--no-verify` flag**:
   This tool relies on the standard Git Hook mechanism. If a command explicitly uses `git push --no-verify`, Git bypasses all client-side hooks. Ensure that your AI Agent system prompts prohibit the use of `--no-verify`.
2. **Uninstallation / Temporary Bypass**:
   - **Uninstall the hook**:
     ```bash
     pre-commit uninstall --hook-type pre-push
     ```
   - **Emergency bypass** (human manual use only):
     ```bash
     git push --no-verify origin <branch>
     ```

---

## 📄 License
MIT License.

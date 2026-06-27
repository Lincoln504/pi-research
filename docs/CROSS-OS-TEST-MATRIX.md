# pi-research — Cross-OS Manual Test Matrix

Targets: **Windows 11**, **macOS** (Apple Silicon arm64 + Intel x64), **Fedora Linux**.
Scope: everything CI cannot reliably cover — real display servers, OS process tables, native
binary loading, GPU backends, NTFS/APFS semantics, symlink privilege, terminal rendering,
residential-IP network behavior. Node floor: `>=22.19.0`.

This document is the source of truth for the 3-VM verification pass. Work **one VM at a time**:
spin up, run the full per-OS column, record pass/fail in the result tables, shut down, next VM.

---

## 0. VM management protocol (one at a time)

1. **Snapshot before testing.** Take a clean snapshot of each VM so a failed install/uninstall
   test can be rolled back (uninstall tests mutate `~/.pi`, `~/.claude/skills`, browser caches).
2. **One VM live at a time** — these are heavyweight (browser download, GPU, embedding model).
   Do not run two VMs concurrently against the same shared network resource (DuckDuckGo / YouTube
   share a source IP per NAT and will rate-limit/block faster).
3. **Order:** Fedora first (closest to CI, fastest to triage), then macOS arm64, then Windows,
   then macOS Intel last (expected partial failure — see §8 / knowledge store).
4. Run each VM's research workload from a **residential IP** for the network subsystems
   (DuckDuckGo search + YouTube transcripts fail from datacenter/VPS IPs by design).
5. After each VM, restore the clean snapshot before re-testing install flows.

---

## 1. Per-VM prerequisite / environment checklist

Set up before any functional test. Without these, runs fail in ways unrelated to OS portability.

| Item | Why | Windows | macOS | Fedora |
|---|---|---|---|---|
| Node >= 22.19.0 | engines floor; `setup.cjs` warns below | ✅ | ✅ | ✅ |
| pi auth: `~/.pi/agent/models.json` + `auth.json` (or explicit apiKey/provider) | LLM auth — run dies on first planning call without it | ✅ | ✅ | ✅ |
| `PI_RESEARCH_MODEL` resolving to an **authed** provider (not keyless built-in) | else 401 on first call | ✅ | ✅ | ✅ |
| Residential network IP | DuckDuckGo search + YouTube PoToken attestation | ✅ | ✅ | ✅ |
| camoufox installed (`npx camoufox-js fetch`) at OS-correct cache path | browser search/scrape | ✅ | ✅ | ✅ |
| GPU driver (D3D12 / Metal / Vulkan-loader) **or** `EMBEDDING_DEVICE=cpu` | WebGPU embeddings vs CPU fallback | ✅ | ✅ | ✅ |
| `NVD_API_KEY` (optional) | NVD 6s→0.6s spacing | optional | optional | optional |
| `GITHUB_TOKEN` (recommended) | GH advisories 60→5000/hr | rec | rec | rec |
| `STACKEXCHANGE_API_KEY` (optional) | 300→10k/day | optional | optional | optional |
| Fedora bare-TTY only: `xorg-x11-server-Xvfb` **iff** `PI_RESEARCH_USE_XVFB=true` | Xvfb opt-in | — | — | conditional |
| Corp networks only: `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS` | **no built-in proxy support** | as needed | as needed | as needed |

---

## 1A. Execution model — SSH (remote-drivable) vs console (human-in-the-loop)

Every test below is tagged with how it runs. Two of the three VMs can be largely driven over SSH;
a residue **must** be verified by a human sitting at the VM's real desktop/console because it involves
pixels, OS security dialogs, GPU/desktop sessions, or interactive TTY behavior that SSH cannot observe.

**Legend (used in the per-OS result tables):**
- **[SSH]** — fully drivable over SSH from the controller; output is text/exit-code/log-parseable.
  These can be scripted and even run unattended.
- **[CON]** — requires a human at the VM's physical/virtual **console** (GUI or real terminal). SSH
  cannot see the result (rendered colors, a popped browser window, a Gatekeeper/SmartScreen dialog,
  a desktop GPU session). Lincoln runs and eyeballs these.
- **[HYB]** — start/drive over SSH, but a human must confirm a visual/interactive outcome (e.g. trigger
  a run over SSH, then watch the console for whether a browser window actually appeared).

### What inherently needs Lincoln at the console ([CON]/[HYB])
| Area | Why SSH can't cover it |
|---|---|
| TUI truecolor wave + heavy box glyphs (§7.1–7.2) | rendered pixels/fonts; depends on the actual terminal emulator + font, not the byte stream |
| Ghost-panel on menu open, resize/SIGWINCH redraw (§7.3) | visual artifact + interactive window resize |
| Alt+P / Esc / Ctrl+C / Ctrl+Break key semantics (§7.4, §7.5) | needs a real interactive TTY; SSH PTYs mangle modifier keys differently than the native console |
| Windows headed browser window, incl. RDP-disconnected (§4.1) | a visible desktop window; RDP-disconnect explicitly removes the interactive session |
| macOS Gatekeeper / Windows SmartScreen/Defender first-launch prompts (§2.1, §5.1) | modal OS security dialogs only appear on the interactive desktop |
| GPU/WebGPU backend actually engaging (Metal/D3D12/Vulkan) (§5.2) | a headless SSH session often has **no GPU/display context** → you'd test the CPU-fallback path by accident, not the GPU path. Run from a logged-in desktop session. |
| Terminal color/glyph across Windows Terminal vs ConHost vs cmd, Terminal.app vs iTerm2 (§7 table) | each emulator renders the same bytes differently |

Everything else — install/uninstall/build/pack, path/cache resolution, config/state/locking, orphan-sweep
logic, network/SSRF/CVE/SE/YouTube, healthcheck, exit codes, knowledge-store native-load — is **[SSH]**.

### Per-OS SSH bring-up (controller → VM)

**Fedora (sshd is the native case):**
- Enable: `sudo systemctl enable --now sshd`; open firewall `sudo firewall-cmd --add-service=ssh --permanent && sudo firewall-cmd --reload`.
- Key auth: `ssh-copy-id user@fedora-vm`. File push: `scp` / `rsync -az ./ user@fedora-vm:~/pi-research`.
- GPU/WebGPU caveat: a pure SSH login has no desktop GL/Vulkan context. To test the **real GPU path**,
  either run from a `ssh -X`-incapable but **logged-in graphical session** (e.g. `ssh user@vm 'DISPLAY=:0 …'`
  while a desktop is logged in) or run from a terminal inside the desktop. SSH-only = CPU-fallback test.

**macOS (arm64 + Intel):**
- Enable Remote Login: `sudo systemsetup -setremotelogin on` (or System Settings → General → Sharing → Remote Login).
- `ssh-copy-id`, `scp`/`rsync` as above.
- **Gatekeeper/codesign tests are [CON]** — the quarantine dialog and `xattr -d com.apple.quarantine`
  approval surface only on the desktop. For the GPU (Metal) path, run from a logged-in console session,
  not a bare SSH shell.

**Windows 11:**
- Enable OpenSSH server: `Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0` then
  `Start-Service sshd; Set-Service -Name sshd -StartupType Automatic`; firewall rule for port 22.
- **Default SSH shell**: set to PowerShell for sane scripting —
  `New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value 'C:\Program Files\PowerShell\7\pwsh.exe' -PropertyType String -Force`.
- File push: `scp` (built into Win OpenSSH) or `rsync` under MSYS/WSL on the controller.
- **Crucial Windows split:** an SSH session is a **non-interactive, headless** session with **no desktop**.
  Since the browser launches **headed** on Windows (headless crashes Firefox there), a scrape started over
  SSH has **no desktop to draw the window** — this is itself the "RDP-disconnected / non-interactive" test
  case (§4.1) and may legitimately fail. To test the **normal** headed path, drive it from an **interactive
  RDP/console logon** [HYB]. Use SSH for everything that is not the browser-window/TUI/GPU path.
- Ctrl+C/Ctrl+Break and TUI rendering over an SSH PTY do **not** represent the native ConHost/Terminal
  experience — those stay [CON] on a real Windows Terminal / cmd window.

### Suggested division of labor
- **Controller-over-SSH (scriptable, can batch):** §2 install/build/pack/uninstall, §3 skill resolver
  logic + manifest, §4.2–4.5 paths/orphan-logic/locking (inspect process tables + logs over SSH), §5.1/5.3/5.4
  native-load + cache + DB paths + corruption recovery, §6 config/state/logging/locking, §8 all network/CVE/
  SE/YouTube/healthcheck/exit-codes. Capture logs (`PI_RESEARCH_LOG_PATH`) and `status --json` for assertions.
- **Lincoln at the console (eyeball/interact):** §4.1 headed-window + RDP-disconnect, §5.2 GPU-engaged +
  forced GPU-error fallback, §7 all TUI/terminal/key tests across each emulator, all Gatekeeper/SmartScreen
  first-launch prompts, Windows-AV-active atomic-write run (§6.3), antivirus/firewall first-run popups.

---

## 2. Install / Uninstall / Build / Package

### 2.1 Postinstall — camoufox download (`scripts/setup.cjs`)
- Clean `npm i` → downloads camoufox; prints `camoufox ready`. Verify the printed cache path is the
  **real on-disk path** per OS:
  - Windows: `%USERPROFILE%\AppData\Local\camoufox\camoufox\Cache` (note **doubled `camoufox`**, uses
    `homedir()` not `%LOCALAPPDATA%` — `setup.cjs:54`/`browser/config.ts:30`). A mismatch = perpetual re-download.
  - macOS: `~/Library/Caches/camoufox`. Intel + Apple Silicon are different binaries — test both arches.
  - Fedora: `$XDG_CACHE_HOME/camoufox` or `~/.cache/camoufox`.
- Re-install with cache present → `Camoufox already installed … Skipping fetch`.
- Force offline → prints ERROR + manual fix, **exits 0** (must never abort the consumer's `npm install`).
- **macOS Gatekeeper / Windows SmartScreen/Defender** may quarantine the downloaded browser binary
  on first launch — manual approval / `xattr -d com.apple.quarantine`. CI never hits this.
- Path with spaces (`C:\Users\First Last\…`) — verify quoted `execSync` of the bin survives.

### 2.2 Fedora system deps (KNOWN GAP)
- `npx playwright install-deps` (`setup.cjs:73`) is **Debian/Ubuntu-only** — fails/no-ops on Fedora;
  the fallback message lists `apt-get` package names. On a minimal Fedora box manually install the
  dnf equivalents (`mesa-libgbm`, `nss`, `atk`, `cups-libs`, `libxkbcommon`, `libXcomposite`, and
  `xorg-x11-server-Xvfb` if using Xvfb) or the browser won't launch. **Document the dnf list.**

### 2.3 Preuninstall — `scripts/cleanup.cjs` + skill removal
- Install skill (see §3), then `npm uninstall` → owned symlink/junction removed, foreign left,
  manifest pruned. Test **both** a symlink/junction install (→ `unlinkSync`) and a copy-fallback
  install (→ `rmSync`) on Windows.
- **Windows junction ownership regex** (`cleanup.cjs:49`, `skill-installer.ts:210`): `readlinkSync` of a
  junction can return a `\\?\C:\…` extended path — verify the regex still matches, else uninstall
  orphans the junction and falsely reports it foreign.
- `PI_RESEARCH_PURGE_BROWSERS=1 npm uninstall` → runs camoufox `remove`; default leaves shared browser.

### 2.4 Build / pack / verify (`build.cjs`, `prepare.cjs`, `verify-package.cjs`)
- `npm run build` on each OS → produces `dist/cli.mjs`, `dist/openclaw-entry.js`, `dist/thread-worker.mjs`,
  `dist/prompts/`, `skills/.../run.mjs`. **esbuild ships per-platform/arch binaries** — most likely
  single-platform-CI-blind build break; confirm on Win/mac-arm64/Intel.
- Git install (`npm i github:Lincoln504/pi-research`) runs the full esbuild build **on the user's
  machine** via `prepare` — this is the real cross-OS build surface. Test per OS.
- `node scripts/verify-package.cjs manifest`, then pack + install into temp + `verify-package.cjs installed`.
- **Windows bin**: shebang assertion passes but tells you nothing about the `.cmd`/`.ps1` shim — live-test
  `pi-research status` actually launches in PowerShell **and** cmd.

| Test | Win | macOS arm64 | macOS x64 | Fedora |
|---|---|---|---|---|
| postinstall camoufox to correct path | | | | |
| offline postinstall exits 0 | | | | |
| build produces all artifacts | | | | |
| pack/install/verify | | | | |
| uninstall removes owned skill only | | | | |

---

## 3. Skill install + launcher (Claude / pi / codex)  — highest Windows-symlink risk

`src/skill-install/skill-installer.ts` + `skills/pi-research/scripts/run.mjs`.

- Install via `/research-config` action → creates symlink (Unix) / **junction** (Windows) at
  `~/.claude/skills/pi-research` → package `skills/pi-research`; manifest at `~/.pi/research/installed-skills.json`.
- **Windows three cases, all required:**
  1. Non-elevated, Developer Mode OFF, same volume → junction should succeed (junctions need no elevation).
  2. Cross-volume (source on `D:`, home on `C:`) → junction throws → **copy fallback**
     (`skill-installer.ts:326`, message "symlink unavailable … copied instead"). A copy is a static
     snapshot — does NOT update when the package updates. Document for affected users.
  3. Copy install → later uninstall must take the `rmSync` branch.
- Re-install when present → `already-installed`. Foreign skill at target → `skipped-foreign`, untouched.
- End-to-end: confirm the agent harness (Claude Code / pi) actually traverses the junction and loads `SKILL.md`.
- Launcher `run.mjs`: resolves engine via `PI_RESEARCH_BIN` → `PI_RESEARCH_PATH` → PATH (`PATHEXT` on
  Windows finds `pi-research.cmd`) → node_modules → `~/.pi/bin`. Engine absent → exit **78** with install
  instructions. `.js/.mjs/.cjs` bins launched as `node <path>` (handles Windows no-exec-bit). Verify a
  `.cmd` shim actually launches (may need shell) and no console window flashes (`windowsHide:true`).

---

## 4. Browser / scraping infrastructure

### 4.1 Headless launch policy (`browser/config.ts:235` `resolveHeadlessMode`) — highest browser risk
- **Windows → `false` (visible window).** `headless:true` crashes Firefox on Windows (camoufox-js #614).
  - Verify a Camoufox window actually pops up per worker and scrape returns markdown.
  - **Critical Windows unknown:** behavior on a **non-interactive / RDP-disconnected** session (no desktop).
    Test interactive logon AND an RDP session that is then disconnected. CI's Windows runner has a desktop.
- **macOS → `true` (true headless), no Xvfb.** Verify on arm64 AND Intel.
- **Fedora, three sub-cases each tested separately:**
  1. Wayland desktop (`WAYLAND_DISPLAY`) → headless `true` (confirm it does not attach to live compositor).
  2. X11 (`DISPLAY`) → headless `true`.
  3. Bare TTY (SSH, no display) → true-headless, **no Xvfb needed**. Then `PI_RESEARCH_USE_XVFB=true`
     with Xvfb installed → `'virtual'` mode. Then without Xvfb → actionable error.
  - **BUG:** the no-display error says `sudo apt install xvfb` (`healthcheck/index.ts:36`,
    `thread-worker-browser.ts:173`, `research-health.ts:60`) — wrong for Fedora (`dnf install
    xorg-x11-server-Xvfb`). Verify and flag.

### 4.2 Profile dir + cache paths
- Profiles → `~/.cache/pi-research/profiles` on **all** OSes (Windows uses a literal `~\.cache\…`, no
  `%LOCALAPPDATA%`). Verify created + writable on Windows; worker `TMP`/`TEMP`/`TMPDIR` repointed there
  (`browser/config.ts:124`). Test `PI_RESEARCH_TMP_DIR` override per OS.
- Fedora: confirm `/tmp` is tmpfs (`mount | grep /tmp`) and profiles land on disk, not RAM.

### 4.3 Orphan-process sweep — MUST never kill the user's own Firefox (verify each OS separately)
Marker: `/camoufox|[/\\]pi-research[/\\]profiles[/\\]/i` against full command line.
- **Unix (macOS + Fedora):** `ps -eo pid,ppid,args`; orphan iff `ppid===1` or dead parent; SIGTERM→SIGKILL.
  Verify `ps` doesn't truncate the args column past the marker (macOS truncates differently than Linux).
- **Windows:** PowerShell `Get-CimInstance Win32_Process` (no wmic — gone in Win11 24H2); `taskkill /F /T`.
  - Verify PowerShell is on PATH/executable (else sweep silently no-ops).
  - Verify a **non-admin** user can read its own camoufox `CommandLine` (null for unreadable procs → marker
    never matches → orphans accumulate).
  - Verify personal `firefox.exe` is never matched; single-match `ConvertTo-Json` (object vs array) handled.
- **Test for all:** open personal Firefox → start run → `kill -9`/end the main process mid-run → start a
  new run → startup sweep reaps orphaned camoufox AND personal browser survives. Also verify clean
  shutdown leaves zero camoufox processes.

### 4.4 Profile-lock reclamation / file locking
- Unix: PID-encoding `lock` symlink + `.parentlock`, `process.kill(pid,0)` liveness.
- Windows: `parent.lock` mtime freshness + OS refusing to delete an open file is the real safety net.
  With a live run holding a profile, trigger a concurrent startup sweep → in-use profile NOT deleted,
  stale one IS.

### 4.5 Worker pool / liveness (`worker-pool-manager.ts`, `process-lifecycle-service.ts`)
- Each OS: pool spins up `WORKER_THREADS` children, real scrape completes. Rename `thread-worker.mjs`
  → expect actionable missing-bundle error, not a crash-loop.
- Kill the parent → workers self-terminate within ~10s (`process.kill(ppid,0)` probe — **confirm on Windows**).
- Start-time probe: Linux `/proc/{pid}/stat`, Windows PowerShell `StartTime`, macOS `ps -o etimes=` —
  verify non-null/no-crash per OS.

---

## 5. Knowledge store / embedding / native ML deps  — macOS Intel is a known failure

### 5.1 Native binary load (CONFIRMED defects)
- **macOS Intel (darwin-x64) is UNSUPPORTED by two native deps** (verified in `node_modules`):
  - `@lancedb/lancedb@0.29.0` ships no `darwin-x64` optional dep (only arm64 + linux + win32).
  - `onnxruntime-node@1.24.3` ships `darwin/arm64` only (no `darwin/x64`).
  - → On Intel Mac the knowledge store fails to init. **Verify it degrades gracefully to
    `KNOWLEDGE_STORE_MODE='none'` and does not crash the whole run; document as unsupported.**
- **apache-arrow ABI mismatch on ALL platforms:** package pins/overrides `apache-arrow@21.1.0`; LanceDB
  0.29.0 declares peer `>=15.0.0 <=18.1.0`. 21.1.0 is outside the tested range. Schema build uses Arrow
  types directly (`store-schema.ts`). Exercise `createTable`/`add` on each OS — a format mismatch can
  surface as platform-specific errors. **High-priority cross-platform correctness check.**
- LanceDB + ONNX load on Win (MSVC runtime + DirectML.dll), macOS arm64 (Metal dylib), Fedora
  (glibc-gnu, not musl; needs vulkan-loader for GPU). Gatekeeper/Defender may block unsigned `.dylib`/`.dll`.

### 5.2 WebGPU backend vs CPU fallback (three distinct GPU code paths)
- Default `EMBEDDING_DEVICE=webgpu` via onnxruntime-node bundled Dawn: **Vulkan (Fedora) / Metal (macOS)
  / D3D12-DirectML (Windows)**.
- Each OS: confirm `device: webgpu` + adapter logged. Force GPU failure (VM with no Vulkan, tiny GPU) →
  confirm CPU fallback engages and embeddings still succeed.
- **RISK:** the WebGPU-error allowlist that triggers CPU fallback (`embedder-init.ts:99-117`) is
  **Vulkan/Linux-biased** (`vk_error_out_of_device_memory`, etc.). A Metal/D3D12 device-lost/OOM string
  not in the list would hard-fail instead of falling back. Deliberately induce a GPU error on macOS and
  Windows and confirm fallback, not crash. `EMBEDDING_DEVICE=cpu` must be honored on headless servers.
- Multi-process GPU contention: leader runs `EmbeddingServer`, others become HTTP clients; dead-leader
  detection uses `process.kill(pid,0)` — **confirm Windows signal-0 / PID-reuse semantics.**

### 5.3 Model cache + DB paths
- Model cache always `~/.cache/pi-research/models` on all OSes (not `~/Library/Caches` on mac, not
  `%LOCALAPPDATA%` on Win). First-run downloads granite r2 ONNX; second run = cache hit (offline OK).
  **Windows: deep nesting `models/<org>/<model>/onnx/…` can exceed legacy 260-char MAX_PATH — verify.**
- DB dir `~/.pi/research/knowledge_db/knowledge.lance`. `mode:0o700` is a no-op on NTFS — verify lock
  still mutually exclusive. Migration uses `rename` — **fails cross-device (EXDEV)** if `KNOWLEDGE_STORE_DIR`
  is on a different volume; verify the temp-name fallback on Windows drive boundaries / macOS APFS volumes.
- `close()` flushes ≤10s; rapid close→reopen on Windows (lingering handles) must not see a half-flushed manifest.
- Corruption recovery keys on an exact LanceDB error string — verify identical across platform builds.

### 5.4 pdf-oxide-wasm (WASM, OS-portable but verify)
- Scrape a PDF URL per OS → markdown + page count; near-100MB PDF doesn't OOM; `doc.free()` releases
  WASM memory across many PDFs.

---

## 6. Config / state / paths / logging

### 6.1 Config-dir consistency (single most important cross-context check)
- `getConfigDirName()` (`utils/host-config.ts:30`): env → host pi `CONFIG_DIR_NAME` → `.pi`. Verify the
  **main process and the spawned browser worker resolve the same `~/.pi`** — a mismatch silently splits
  state/logs. Set `PI_RESEARCH_CONFIG_DIR_NAME=.pitest` → everything relocates under `~/.pitest`.
- Windows: confirm `os.homedir()` = `%USERPROFILE%` and a OneDrive-redirected / roaming home doesn't break `~/.pi`.

### 6.2 Env precedence + `.env` parsing
- Order (later wins): defaults < `config.env` < `{iface}.env` < legacy `.pi-research.env` < project
  registry < `process.env`. Verify with layered `PI_RESEARCH_MAX_RESEARCHERS`.
- **Windows CRLF/BOM:** author `config.env` in Notepad (CRLF). Verify `KEY=true\r\n` parses as `true`
  (not `true\r`) and a UTF-8 BOM on line 1 doesn't corrupt the first key. `saveConfig` writes LF-only —
  verify round-trip.

### 6.3 Atomic writes / NTFS rename-over-existing
- Four sites do temp-write + rename with a `win32` copy+delete fallback (`config.env`, state, state-backup,
  log-rotation). On Windows with AV/Search-indexer active on `~/.pi`: many rapid saves → no `EPERM`/`EBUSY`
  corruption; fallback path actually taken; no leftover `.tmp.<ts>` litter. Note the Windows copy+unlink
  fallback is **not atomic** and `config.env` has no backup — verify behavior under forced interruption.
- macOS/Linux: kill process immediately after a write → state file never half-written (fsync durability).

### 6.4 Multi-process file locking
- Launch two pi-research processes against the same `~/.pi` writing config/state simultaneously → no
  lost-update/corruption. `kill -9` mid-write → next process reclaims via dead-PID (Unix `EPERM`=alive vs
  `ESRCH`=dead) / stale-mtime. **Windows `process.kill(pid,0)` cross-user liveness** must not wrongly reclaim.

### 6.5 Logging + rotation
- Default `os.tmpdir()/pi-research.log`: Fedora `/tmp`, macOS `/var/folders/…`, Windows `%TEMP%` (per-user
  — verify two users don't collide). One consolidated file across main + workers.
- Force >10MB → rotation archives with **NTFS-legal names** (`:`→`-`); win32 copy fallback for rename.
- `PI_RESEARCH_LOG_PATH` with Windows backslashes/spaces honored by main AND worker.
- Clear-logs action deletes active + archives even with a handle open (Windows refuse-to-unlink → no crash).

### 6.6 stdio FD-2 capture (Unix-only path)
- macOS vs Fedora: native addon stderr (Dawn/ONNX) captured into log during embedding init via `/dev/fd/2`
  (different driver on macOS vs Linux); FD 2 restored cleanly after task. Windows: FD-level skipped (guarded),
  JS-level console/stderr still captured, no error from missing `/dev/fd`.
- **Windows TUI corruption risk:** because FD-2 redirect is skipped, native ONNX/Dawn/WebGPU stderr may
  leak onto the terminal and corrupt the live panel — verify the panel isn't interrupted by native log spam.

### 6.7 Case-insensitive FS registry keying
- `normalizeWorkspacePath(cwd)`: save a project setting from `C:\Users\me\Proj`, relaunch from
  `c:\users\me\proj` → same entry reused on Windows/macOS (case-insensitive); distinct on Fedora ext4/btrfs.

---

## 7. TUI / CLI / OpenClaw integration

### 7.1 TUI color (highest terminal-render risk)
- The wave animation emits **24-bit truecolor unconditionally** (`research-panel-wave.ts:269`), no
  `COLORTERM`/`TERM` capability detection.
  - **Windows legacy ConHost / `cmd.exe`:** truecolor unreliable — may render literal garbage or band.
    Test Windows Terminal (OK) AND raw `conhost`/`cmd.exe` (worst case).
  - **macOS Terminal.app:** no truecolor (quantizes) — gradient banding vs iTerm2. Test both.
  - **Fedora:** GNOME VTE/konsole/xterm OK; bare TTY 256-color → banding.
  - tmux/screen without truecolor passthrough mangles it everywhere.

### 7.2 Unicode box-drawing + heavy glyphs
- Panel borders + wave head glyphs U+2574 `╴`, U+2576 `╶`, U+257C `╼`, U+257A `╺` (heavy/partial dashes
  uncommon in default fonts). On Windows `cmd.exe` raster fonts and some default monospace fonts they may
  render as tofu/wrong-width, breaking the seamless wave. Test each OS's **default** terminal font.
- Header percent (rounded 10%) is the real progress indicator (there is no literal `[====]` bar).
- Narrow terminal + ambiguous-width settings → verify border alignment math holds.

### 7.3 Animation timing, teardown, resize
- 33ms (~30 FPS) pulse: Windows timer granularity (~15.6ms) + slower ConHost write path → possible jitter
  not seen on Linux/macOS. Observe ~30s; also over SSH from each OS (per-frame full-line repaint).
- **Ghost panels (recurring failure class):** start research → open `/research-config` mid-run → navigate
  → exit → no leftover/stacked rows. Also Esc-cancel. Windows Terminal vs ConHost clear lines differently.
- **Resize:** Windows emits **no SIGWINCH** — pi-tui polls `stdout.columns`; resize redraw may lag until
  next keypress. Drag-resize narrow↔wide during the live wave on each OS; no stale columns / dark-trail flash.

### 7.4 Steering / raw-mode keys
- Type + submit steering; **Esc** cancel; **Ctrl+C**; **Alt+P** pop queued steering.
- Ctrl+C semantics differ (Windows `CTRL_C_EVENT` vs `\x03` byte) — verify no double-abort/hung run.
- Alt-as-Meta is terminal-dependent (iTerm2 needs "Esc+ sends Meta"; macOS Terminal sends accented chars;
  Windows Terminal sends `ESC p`) — confirm Alt+P fires on each terminal.

### 7.5 CLI (`src/cli.ts`)
- `pi-research help|status|status --json|--version`; `research "<q>" --depth 1` piped to a file and `| cat`
  → Markdown report on **stdout**, progress/errors on **stderr**, no stray ANSI in piped output.
- Exit codes: bad args → **64**; unconfigured model → **78**; runtime error → **70**; success → **0**.
- **Windows: no `SIGBREAK` handler in the CLI `main()`** (the SDK registers it at `sdk.ts:109`, the CLI does
  not) — Ctrl+Break may orphan browser pool / WASM threads. Test Ctrl+Break specifically on Windows.
- **Entry-point guard** (`cli.ts:841`) compares `fileURLToPath(import.meta.url)` to `argv[1]` — Windows
  drive-letter/`\`-vs-`/` casing can make this fail so `node dist\cli.mjs …` silently doesn't run `main()`.
  Test the bin directly AND `node dist/cli.mjs` on Windows.
- `npm i -g` → working `pi-research` on PATH in PowerShell and cmd. CRLF `config.env`/`cli.env` load.

### 7.6 OpenClaw plugin (`dist/openclaw-entry.js`)
- Install via `openclaw plugins install npm:@lincoln504/pi-research`; run a research tool call; toggle
  `knowledgeEnabled`, `reportExportEnabled` + `reportExportPath`; trigger host cleanup/reload.
- **Worker path resolution (cross-OS landmine):** under bundled `dist/openclaw-entry.js` + `--omit=dev`,
  browser workers (`thread-worker.mjs`) resolve peer deps relative to the worker file, not the host install.
  Verify a research call actually spawns browser workers and doesn't fail `ERR_MODULE_NOT_FOUND` —
  Windows drive-letter/`\` path resolution is the most fragile.
- `hasUI:false` → no live TUI; verify lifecycle/progress not silently swallowed.
- `reportExportPath`: test a Windows path, a UNC path, a path with spaces; system-prefix rejection.
- Reload must not leak browser processes (per-OS kill logic).

**All rows below are [CON]** — run at the real terminal emulator, not over an SSH PTY.

| Subsystem | Win Terminal | Win ConHost/cmd | macOS Term.app | iTerm2 | Fedora VTE | Fedora TTY |
|---|---|---|---|---|---|---|
| truecolor wave | | | | | | |
| heavy box glyphs | | | | | | |
| ghost-panel on menu | | | | | | |
| resize redraw | | | | | | |
| Alt+P / Esc / Ctrl+C | | | | | | |

---

## 8. Research workflow + network + security/CVE + YouTube (end-to-end)

### 8.1 Healthcheck
- Fresh VM no camoufox → research query → critical-fail with "npx camoufox-js fetch" message.
- Installed → `/health` action → all OK; KnowledgeStore reports device (webgpu/cpu).
- `PI_RESEARCH_SKIP_HEALTHCHECK=true` → bypass.
- **BUG:** `isBusyPoolHealthFailure` proceeds only if every unhealthy error matches `/tim(e|ed)\s*out/i`
  — **English-locale-coupled**; a non-English Node/OS timeout string would abort instead of proceed.
  Note for non-English-locale VMs.

### 8.2 Full workflow
- No auth → actionable "configure models.json" error (exit 78). Configured → quick query end-to-end
  (planning→search→scrape→synthesis → cited report). Full/deep query: multi-round; inject steering
  **during gathering and again during the evaluator phase** → consumed, not silently dropped.
- Verify `PI_RESEARCH_LLM_THINKING_LEVEL` (default off) and `PLANNING/SYNTHESIS_MAX_TOKENS` env overrides
  take effect (report not truncated) identically per OS.

### 8.3 Network / DNS / TLS / SSRF
- **No HTTP proxy support exists** (the proxy-pool is an unimplemented plan). On corp networks set OS-global
  `HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS` and verify each subsystem (search, scrape, security DBs, SE, YouTube)
  honors it — many may not.
- **DuckDuckGo datacenter-IP block** — biggest false-failure risk. On a residential IP, search returns
  results; on a datacenter VM all queries return 0 → "Search completely failed". This is exactly what CI suppresses.
- SSRF guard: attempt `http://127.0.0.1/`, `http://[::1]/`, `http://169.254.169.254/`, `http://2130706433/`,
  and a public host with a private A-record → all blocked with distinct errors; a normal public URL succeeds.
  Redirect SSRF: public URL 302→`169.254.169.254` → blocked at the hop.
- **`dns.resolve4/6` uses the system resolver and ignores `/etc/hosts`** — on split-horizon/VPN/corp DNS,
  behavior differs per OS; a host pinned to a private IP in `/etc/hosts` is NOT caught by the resolve check.
  TLS relies on Node's bundled CA — corp MITM root CA fails all `fetch` unless `NODE_EXTRA_CA_CERTS` set.
- `PI_RESEARCH_ALLOW_LOOPBACK_SCRAPE=true` permits only loopback — verify it does NOT also permit RFC1918/169.254.

### 8.4 Security / CVE DB clients
- Run a security lookup for a known CVE (e.g. CVE-2021-44228) → hits from NVD + GitHub + OSV + KEV.
- NVD with/without `NVD_API_KEY` (6s vs 0.6s spacing, 429 backoff). GitHub without `GITHUB_TOKEN` →
  graceful partial results, not a hard abort. CISA KEV from cisa.gov (some corp firewalls block `.gov`).

### 8.5 Stack Exchange
- Query per OS → quota gauge decrements; `backoff` honored. `STACKEXCHANGE_API_KEY` 300→10k/day; shared
  NAT exhausts the anonymous daily quota faster.

### 8.6 YouTube transcript (most environment-sensitive)
- Runs YouTube BotGuard VM via jsdom + Node-realm `new Function`. **Requires a residential IP** — the
  integrity/attestation step rejects datacenter IPs ("requires a residential IP"; timedtext returns
  HTTP 200 + empty body on token failure). On a residential box: non-empty transcript with title/author;
  on a datacenter VM: graceful residential-IP failure, never crashes the run. Verify no TUI corruption
  (youtubei.js logging silenced). `PI_RESEARCH_YOUTUBE_POTOKEN_REQUEST_KEY` override when YouTube rotates keys.

---

## 8A. LIVE FEDORA RESULTS (run on Fedora 44 VM, x86_64, headless/no-DISPLAY, Node 22.22, glm-4.7)

**What works end-to-end (verified live):**
- `pi install git:https://github.com/Lincoln504/pi-research` — succeeds; the committed `package-lock.json`
  in the clone pins impit 0.13.0, so npm install passes the pnpm guard. camoufox downloaded, `prepare` build ran.
- Full research run (depth 1) with `PI_RESEARCH_EMBEDDING_DEVICE=cpu` — **exit 0, accurate cited report,
  6 real scraped sources.** Pipeline confirmed: healthcheck → GLM planning → DuckDuckGo search (VM NAT IP
  NOT datacenter-blocked) → camoufox **headless scrape (no Xvfb, Fedora libs sufficient)** → evaluate →
  GLM synthesis → CPU embedding → lancedb knowledge write.
- **lancedb + apache-arrow 21 at runtime:** connect → createTable(arrow-21 schema) → add → countRows all
  succeed. The arrow-21-vs-lancedb-peer-`<=18.1` mismatch is a cosmetic install warning, NOT a runtime break.
- onnxruntime-node linux x64/arm64 binaries present; CPU embedding works.
- **Resource teardown is clean:** 0 orphaned camoufox/firefox, 0 lingering workers, 0 profile dirs left,
  no stale state locks, 0 ERROR in run log.
- Skill install/uninstall (symlinks to `~/.pi/skills` + `~/.claude/skills`, manifest), foreign-skill safety
  (`skipped-foreign`, untouched), and `pi remove` (clone deleted, settings cleared) — all work on Fedora.

**Not yet done on Fedora:** TUI visual rendering (color/glyphs/animation/ghost-panel) — [CON], needs human eyes.

## 9. Confirmed cross-OS defects found during investigation (fix candidates)

CRITICAL (reproduced live on Fedora, block default-config use):

-1. **[CRITICAL] Default `EMBEDDING_DEVICE=webgpu` SEGFAULTS on a software/llvmpipe Vulkan adapter.**
   On the GPU-less VM, Dawn selected `mesa llvmpipe` (software Vulkan); the embedder logged the adapter
   (`embedder-utils.ts:149`) but proceeded into onnxruntime's WebGPU EP and the process **segfaulted (exit 139)**,
   aborting research. This is the norm for VMs, headless servers, and CI. A native segfault cannot be caught,
   so the only robust fix is **pre-flight detection** in `initializeDawnWebGPU` (`embedder-utils.ts:131-159`):
   if `adapter.isFallbackAdapter` or vendor/device matches `/llvmpipe|lavapipe|swiftshader|software|microsoft basic/i`,
   return CPU. Workaround for now: `PI_RESEARCH_EMBEDDING_DEVICE=cpu`.

-2. **[HIGH] Embedder partial-cache poisoning permanently breaks the knowledge store.**
   `isModelCached` (`embedder-init.ts:130`) checks only `onnx/model.onnx`, not the 18-200 MB external-weights
   `model.onnx_data`. An interrupted first download (e.g. a `--print` that loads the extension, or Ctrl+C)
   leaves `model.onnx` + an orphan `model.onnx_data.tmp.<pid>.<rand>` but no final `model.onnx_data`. Next run:
   cache-hit detection → `allowRemoteModels=false` → load fails on the missing data file → never re-downloads.
   Fix: cache-hit must verify `model.onnx_data` (or all referenced external-data files) and reap stale `.tmp`.

-3. **[HIGH] Embedder/knowledge-store init failure is FATAL to the research run.**
   A non-WebGPU load error is rethrown at `embedder.ts:206-207` and propagates to the top, aborting research
   (empty report, exit 1). The knowledge store is "lazy/non-critical" everywhere else — its init failure must
   degrade to no-knowledge-store and let research complete, not crash it.

-4. **[MED] Standalone `dist/cli.mjs` cannot resolve pi peer deps after `pi install`.**
   `pi install` clones + `npm install` but never installs the `@earendil-works/*` peers (pi provides them
   in-process for the extension). So `node dist/cli.mjs <anything>` → `ERR_MODULE_NOT_FOUND: @earendil-works/pi-ai`,
   exit 1. The extension path works; the standalone CLI only works via `npm i -g` (npm auto-installs peers).
   Consequence: the **Claude-Code skill path** (`run.mjs` → resolves engine → `node cli.mjs`) **fails from a
   `pi install` deployment** — it needs a separate npm-global install. Decide the intended skill-deployment story.

-5. **[MED] `pi remove` orphans large caches + skill symlinks (no cleanup hook).**
   `pi remove` deletes the clone + settings entry but does NOT run the package `preuninstall` (`cleanup.cjs`).
   Left behind: ~1.4 GB camoufox cache, ~195 MB model cache, the knowledge_db, and any TUI-installed skill
   symlinks (which become dangling pointers to the deleted clone). cleanup.cjs only runs on `npm uninstall`,
   which is not the deployment path. Needs a pi-native cleanup or documented manual purge.



0. **[RELEASE BLOCKER — reproduced live on Fedora] `npm install` is broken on any clean machine.**
   The published package ships **no lockfile/npm-shrinkwrap.json**, so a clean `npm install` floats
   camoufox-js's `impit@^0.13.0` up to **impit@0.13.1**, whose `preinstall: npx only-allow pnpm` aborts
   the whole install (`code 127`, `only-allow: command not found`). The dev host only escaped because its
   `node_modules` was originally populated with **pnpm** (`~/.local/share/pnpm/pnpm`). Affects ALL OSes.
   Two fixes: (a) surgical — add `"impit": "0.13.0"` to `overrides` (0.13.0 has no guard); (b) robust —
   ship `npm-shrinkwrap.json` so end users get the exact tested tree. Also: `postinstall`/install logs piped
   through `tail` mask npm's non-zero exit, so the failure silently reported success — stop masking exit codes.

1. **macOS Intel (darwin-x64) knowledge store is broken** — no LanceDB and no onnxruntime-node prebuilt
   binary for darwin-x64. Verify graceful degrade to `KNOWLEDGE_STORE_MODE='none'`; document unsupported,
   or drop Intel-Mac knowledge support explicitly.
2. **apache-arrow 21.1.0 is outside LanceDB 0.29.0's peer range (`>=15 <=18.1`)** on ALL platforms (forced
   via `overrides`). Exercise table create/add per OS; consider aligning Arrow to the supported range.
3. **Fedora Xvfb guidance says `apt`** in four places (`healthcheck/index.ts:36`,
   `thread-worker-browser.ts:173`, `research-health.ts:60`, `setup.cjs:128`) and `setup.cjs:73` runs
   Debian-only `playwright install-deps`. Add dnf-aware messaging + a Fedora dep list.
4. **CLI has no `SIGBREAK` handler** (Windows Ctrl+Break) though the SDK does — risk of orphaned browser/WASM.
5. **WebGPU CPU-fallback error allowlist is Vulkan-biased** — Metal/D3D12 device-lost/OOM strings may hard-fail.
6. **`isBusyPoolHealthFailure` timeout match is English-locale-coupled** — non-English locales abort instead
   of busy-proceed.
7. **Windows camoufox cache path** uses doubled `camoufox\camoufox` + `homedir()` not `%LOCALAPPDATA%` —
   must exactly match camoufox-js runtime path or `isBrowserAvailable()` reports false despite a working install.
8. **TUI emits unconditional truecolor** — no capability fallback for ConHost/cmd/Terminal.app.

---

## 10. Time-boxed priority (if you can only do a few per OS)

Tag key: [SSH] remote-drivable · [CON] human at console · [HYB] drive over SSH, confirm at console.

1. **Fedora:** bare-TTY true-headless + `PI_RESEARCH_USE_XVFB` opt-in [SSH]; DuckDuckGo on residential IP
   [SSH]; dnf Xvfb/deps [SSH]; tmpfs profile steering [SSH]; Vulkan WebGPU actually engages [CON, desktop session].
2. **macOS arm64:** Gatekeeper on camoufox + unsigned dylib/`.node` [CON]; Metal WebGPU + forced-error CPU
   fallback [CON]; true-headless launch [HYB]; install/build/pack [SSH].
3. **macOS Intel:** confirm knowledge store degrades, not crashes (defect #1) [SSH].
4. **Windows:** headed-browser launch incl. RDP-disconnected [HYB/CON]; orphan sweep spares personal Firefox
   as a non-admin user [HYB]; junction skill install + uninstall ownership [SSH]; truecolor/glyph TUI on
   ConHost [CON]; NTFS atomic writes under AV [HYB]; OpenClaw worker peer-dep resolution [SSH]; Ctrl+Break [CON].

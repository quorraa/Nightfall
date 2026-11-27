# Get Tailscale window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When this PC has no Tailscale, the manage window offers a small native window with a Windows download button and App Store / Google Play QR codes.

**Architecture:** QR matrices for the two fixed store URLs are generated once by `tools/qr.py` into `src/qr.rs` (rows of text). A dialog built with the existing `Template` shows them in two owner-drawn statics painted with GDI. `manage()` checks Tailscale once per pass and adds a command link for `Tailscale::Absent`.

**Tech Stack:** Rust std + Win32 (user32, gdi32), no crates; Python + segno for the generator, opencv for a one-off decode check.

**Spec:** `docs/superpowers/specs/2026-11-27-tailscale-helper-design.md`

## Global Constraints

- No Cargo dependencies.
- URLs exactly: `https://tailscale.com/download/windows`, `https://apps.apple.com/app/tailscale/id1470499037`, `https://play.google.com/store/apps/details?id=com.tailscale.ipn`.
- Labels: "iPhone: App Store", "Android: Google Play"; buttons "Get Tailscale for Windows", "Back"; command link "Use it away from home\nGet Tailscale on this PC and your phone".
- QR error correction M or better, 4-module white quiet zone.

## Review Focus

- High-DPI screens (150-200%): the codes must stay square and crisp: module size is a whole number of pixels computed from the control's real client rect.
- Esc and the title-bar close both act as Back (IDCANCEL ends the dialog).
- A PC where the Tailscale CLI exists but is signed out counts as Absent and shows the link (today's `tailscale()` already returns Absent then).
- Dark mode: the codes are always black on white regardless of theme.
- The manage window re-checks after Back, so installing Tailscale meanwhile changes what it shows.

---

### Task 1: QR matrices

**Files:**
- Create: `tools/qr.py`, `src/qr.rs`
- Modify: `src/main.rs` (add `mod qr;`)

**Interfaces:**
- Produces: `pub const APP_STORE: &[&str]`, `pub const GOOGLE_PLAY: &[&str]` in `src/qr.rs`, one string per row, `#` dark and `.` light, no quiet zone.

- [ ] Write `tools/qr.py`: `segno.make(url, error="m", micro=False)`, write `src/qr.rs` with both consts and a header saying it's generated and how to rerun; with `--check`, render each matrix to a PNG (quiet zone 4, 8 px modules) and decode with `cv2.QRCodeDetector`, asserting it returns the URL.
- [ ] Run `uv run --no-project --with segno --with opencv-python-headless python tools/qr.py --check`; expected: both URLs decoded.
- [ ] Tests in `src/qr.rs`: `codes_are_square_qr_sizes` (rows equal length, size = 17 + 4v), `codes_have_three_finder_patterns` (7x7 rings at top-left, top-right, bottom-left).
- [ ] `cargo test qr` passes.

### Task 2: The Tailscale window

**Files:**
- Modify: `src/setup.rs` (gdi32 externs, template, dialog proc, `get_tailscale()`, tests)

**Interfaces:**
- Consumes: `qr::APP_STORE`, `qr::GOOGLE_PLAY`.
- Produces: `fn get_tailscale()` (modal, returns when closed), `fn tailscale_template() -> Template`.

- [ ] Test `tailscale_dialog_template_is_laid_out_for_windows`, same checks as the port window's test with this template's item count.
- [ ] `tailscale_template()`: intro static, Windows button (id 120), two `SS_OWNERDRAW` statics (ids 121, 122) of equal square size, a centred label under each, Back as IDCANCEL (default button).
- [ ] Dialog proc: WM_INITDIALOG sets icons; WM_COMMAND 120 opens the Windows URL with ShellExecuteW, IDCANCEL ends; WM_DRAWITEM fills the rect white, then dark modules with module = floor(min(w,h) / (n + 8)), centred.
- [ ] Ignored look-at test `tailscale_window` that calls `get_tailscale()`.
- [ ] `cargo test` passes; open the window with `cargo test -- --ignored tailscale_window`, screenshot, scan both codes from the screen (decode the screenshot with opencv).

### Task 3: Manage window wiring

**Files:**
- Modify: `src/setup.rs` (`where_to_open`, `manage`)

- [ ] `where_to_open(port, ts: &Tailscale)` takes the state instead of running the check; `manage()` calls `tailscale(port)` once per pass.
- [ ] When the state is Absent, push `(AWAY, "Use it away from home\nGet Tailscale on this PC and your phone")` before Change the port, running or not; `AWAY => get_tailscale()` then loop.
- [ ] `cargo test` and `cargo clippy --release` clean; build release; check the manage window shows the link when Tailscale is absent (simulate by pointing the check at a missing exe in a debug-only run, or on a PC without it) and is hidden when present.

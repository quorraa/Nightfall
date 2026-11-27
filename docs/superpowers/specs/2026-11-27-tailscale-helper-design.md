# Get Tailscale from the manage window

## Why

Tailscale is what lets the phone reach Nightfall away from home, and it makes https work with no
certificate to install. The manage window already checks this PC for Tailscale but says nothing
when it's missing, so someone without it never learns it's an option. This gives them a short
path: install it on the PC, scan a code to get it on the phone.

## What

- In the manage window, when this PC has no Tailscale (`Tailscale::Absent`: the CLI isn't there,
  or it isn't signed in), a command link: **Use it away from home** / *Get Tailscale on this PC
  and your phone*. It shows whether or not Nightfall is running.
- It opens a small Nightfall window:
  - one line on what Tailscale does and that both devices sign in to the same account;
  - a **Get Tailscale for Windows** button that opens `https://tailscale.com/download/windows`;
  - two QR codes side by side, labelled *iPhone: App Store* and *Android: Google Play*, for
    `https://apps.apple.com/app/tailscale/id1470499037` and
    `https://play.google.com/store/apps/details?id=com.tailscale.ipn` (all three checked to open
    the Tailscale app or page);
  - a **Back** button (and Esc) that returns to the manage window, which checks again, so once
    Tailscale is set up the window shows the away-from-home address or the `tailscale serve` step.
- Ready and NeedsServe keep today's text; the new link only appears for Absent.

## Approaches

- **Native window** (chosen): a dialog built with the existing `Template`, the QR codes drawn as
  black squares on white in an owner-drawn static control. Stays inside Nightfall, works while
  Nightfall is stopped, no dependencies.
- Browser page: a local page with the codes. Easier to style, but needs Nightfall running and
  sends you to a browser just to scan. Not chosen.

## Constraints

- No dependencies (Cargo.toml says so). The store links are fixed, so each QR matrix is
  generated once by a script kept in the repo (`tools/qr.py`, run with `uv run --with segno`)
  and stored in `src/qr.rs` as rows of text. The script is how to regenerate them.
- Codes drawn with a 4-module white quiet zone, at a size a phone camera reads from a screen.
- The Tailscale check runs the CLI; the manage window calls it once per pass, not twice.

## Left to the builder

Exact dialog layout and wording beyond the above, QR error-correction level (M or better), and
the tests: the matrices are square with the three finder patterns, the template lays out like
the port window's test, and the codes decode back to the URLs (checked once with a decoder
during development, not in the test suite).

//! QR codes for getting Tailscale on a phone, shown in the manage window.
//!
//! The store links never change, so the codes are made once by tools/qr.py and kept in
//! qr_codes.rs: one string per row, '#' dark and '.' light, without the quiet zone.

include!("qr_codes.rs");

#[cfg(test)]
mod tests {
    use super::*;

    fn dark(code: &[&str], x: usize, y: usize) -> bool {
        code[y].as_bytes()[x] == b'#'
    }

    #[test]
    fn codes_are_square_qr_sizes() {
        for code in [APP_STORE, GOOGLE_PLAY] {
            let n = code.len();
            assert!(n >= 21 && (n - 17) % 4 == 0, "{n} rows isn't a QR size");
            assert!(code.iter().all(|row| row.len() == n && row.bytes().all(|b| b == b'#' || b == b'.')));
        }
    }

    #[test]
    fn codes_have_three_finder_patterns() {
        for code in [APP_STORE, GOOGLE_PLAY] {
            let n = code.len();
            for (ox, oy) in [(0, 0), (n - 7, 0), (0, n - 7)] {
                for y in 0..7 {
                    for x in 0..7 {
                        let ring = x == 0 || y == 0 || x == 6 || y == 6;
                        let centre = (2..=4).contains(&x) && (2..=4).contains(&y);
                        assert_eq!(dark(code, ox + x, oy + y), ring || centre, "finder at {ox},{oy}: {x},{y}");
                    }
                }
            }
        }
    }
}

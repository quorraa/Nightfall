//! The phone's page and its small JSON API, for this LAN and Tailscale only.
//!
//!   GET  /api/status                 {host, now, pending, last, dry_run}
//!   POST /api/dim     {"delay": s}   screens off now, or in s seconds (0 to 6 h)
//!   POST /api/cancel                 drop the pending timer
//!   POST /api/wake                   screens back on
//!   GET  /nightfall.crt              the certificate authority phones install for https
//!
//! Everything else is the page: web/ next to the .exe when it is there, otherwise the copy
//! built into the .exe. http and https share the port (see tls.rs).

use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::bedtime::BEDTIME;
use crate::json::{self, Value};
use crate::tls;

mod assets {
    include!(concat!(env!("OUT_DIR"), "/assets.rs"));
}

pub const MAX_DELAY: f64 = 6.0 * 60.0 * 60.0;
const MAX_BODY: u64 = 4096;
const MAX_HEADER_LINE: u64 = 8192;
const MAX_HEADERS: usize = 100;
const IDLE: Duration = Duration::from_secs(15);

pub fn serve(listener: TcpListener) {
    for conn in listener.incoming() {
        match conn {
            Ok(stream) => {
                let _ = std::thread::Builder::new().name("http".into()).spawn(move || connection(stream));
            }
            Err(_) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

/// Loopback, private LAN ranges, link-local and Tailscale only.
pub fn client_allowed(ip: IpAddr) -> bool {
    let ip = match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(IpAddr::V6(v6), IpAddr::V4),
        v4 => v4,
    };
    match ip {
        IpAddr::V4(a) => {
            let o = a.octets();
            let tailscale = o[0] == 100 && (o[1] & 0xC0) == 64; // 100.64.0.0/10
            a.is_loopback() || a.is_link_local() || a.is_private() || tailscale
        }
        IpAddr::V6(a) => {
            let first = a.segments()[0];
            let link_local = (first & 0xFFC0) == 0xFE80; // fe80::/10
            let unique_local = (first & 0xFE00) == 0xFC00; // fc00::/7, Tailscale's fd7a:115c:a1e0::/48 included
            a.is_loopback() || link_local || unique_local
        }
    }
}

struct Request {
    method: String,
    target: String,
    http11: bool,
    headers: Vec<(String, String)>,
}

impl Request {
    /// The first header called `name` (lowercase).
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    fn path(&self) -> &str {
        self.target.split(['?', '#']).next().unwrap_or("")
    }

    fn wants_close(&self) -> bool {
        let close = self.header("connection").is_some_and(|v| v.split(',').any(|t| t.trim().eq_ignore_ascii_case("close")));
        !self.http11 || close
    }
}

enum Body {
    Owned(Vec<u8>),
    Static(&'static [u8]),
}

struct Response {
    code: u16,
    content_type: &'static str,
    body: Body,
    headers: Vec<(&'static str, String)>,
    close: bool,
}

impl Response {
    fn json(code: u16, body: String) -> Self {
        Response { code, content_type: "application/json", body: Body::Owned(body.into_bytes()), headers: vec![], close: false }
    }

    fn error(code: u16, message: &str) -> Self {
        Self::json(code, format!("{{\"error\": {}}}", json::string(message)))
    }

    fn page_error(code: u16, message: &str) -> Self {
        let message = message.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
        let html = format!(
            "<!doctype html>\n<meta charset=\"utf-8\">\n<title>{code} {}</title>\n<p>{message}</p>\n",
            reason(code)
        );
        Response {
            code,
            content_type: "text/html; charset=utf-8",
            body: Body::Owned(html.into_bytes()),
            headers: vec![],
            close: false,
        }
    }

    fn closing(mut self) -> Self {
        self.close = true;
        self
    }
}

fn reason(code: u16) -> &'static str {
    match code {
        200 => "OK",
        301 => "Moved Permanently",
        304 => "Not Modified",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        411 => "Length Required",
        415 => "Unsupported Media Type",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        _ => "",
    }
}

/// A connection, plain or https. Both arrive on the same port.
enum Conn {
    Plain(TcpStream),
    Tls(Box<tls::Stream>),
}

impl Conn {
    fn tcp(&self) -> &TcpStream {
        match self {
            Conn::Plain(s) => s,
            Conn::Tls(s) => s.tcp(),
        }
    }
}

impl Read for Conn {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            Conn::Plain(s) => s.read(buf),
            Conn::Tls(s) => s.read(buf),
        }
    }
}

impl Write for Conn {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            Conn::Plain(s) => s.write(buf),
            Conn::Tls(s) => s.write(buf),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            Conn::Plain(s) => s.flush(),
            Conn::Tls(s) => s.flush(),
        }
    }
}

/// A TLS connection starts with a handshake record (0x16); an http request starts with a letter.
const TLS_HANDSHAKE: u8 = 0x16;

fn connection(stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(IDLE));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
    let _ = stream.set_nodelay(true);
    let Ok(peer) = stream.peer_addr() else { return };
    let mut first = [0u8; 1];
    if !matches!(stream.peek(&mut first), Ok(1)) {
        return; // the client closed, or went quiet
    }
    let conn = if first[0] == TLS_HANDSHAKE {
        let Some(creds) = tls::credentials() else { return };
        if !client_allowed(peer.ip()) {
            crate::warning!("refused {}", peer.ip());
            return;
        }
        match tls::Stream::accept(stream, creds) {
            Ok(s) => Conn::Tls(Box::new(s)),
            Err(e) => {
                // Usually a phone that doesn't trust the certificate yet.
                crate::info!("https handshake with {} failed: {e}", peer.ip().to_canonical());
                return;
            }
        }
    } else {
        Conn::Plain(stream)
    };
    let mut reader = BufReader::new(conn);
    loop {
        let req = match read_request(&mut reader) {
            Ok(Some(req)) => req,
            Ok(None) => return, // the client closed, or went quiet
            Err(code) => {
                let _ = send(reader.get_mut(), "", Response::page_error(code, reason(code)).closing(), false);
                return finish(reader.into_inner());
            }
        };
        if !client_allowed(peer.ip()) {
            crate::warning!("refused {}", peer.ip());
            let resp = Response::page_error(403, "Request forbidden.").closing();
            let _ = send(reader.get_mut(), req.path(), resp, req.method == "HEAD");
            return finish(reader.into_inner());
        }
        let mut resp = handle(&req, &mut reader);
        if req.wants_close() {
            resp.close = true;
        }
        let close = resp.close;
        if send(reader.get_mut(), req.path(), resp, req.method == "HEAD").is_err() || close {
            return finish(reader.into_inner());
        }
    }
}

/// Close politely: stop sending, then let the client's leftovers drain so Windows
/// doesn't reset the connection before the reply arrives.
fn finish(conn: Conn) {
    let stream = conn.tcp();
    let _ = stream.shutdown(Shutdown::Write);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
    let _ = io::copy(&mut stream.take(64 * 1024), &mut io::sink());
}

fn read_line(reader: &mut BufReader<Conn>) -> Result<Option<String>, u16> {
    let mut line = Vec::new();
    match reader.by_ref().take(MAX_HEADER_LINE).read_until(b'\n', &mut line) {
        Ok(0) => return Ok(None),
        Ok(_) => {}
        Err(_) => return Ok(None),
    }
    if !line.ends_with(b"\n") {
        return Err(if line.len() as u64 >= MAX_HEADER_LINE { 431 } else { 400 });
    }
    while matches!(line.last(), Some(b'\n' | b'\r')) {
        line.pop();
    }
    Ok(Some(String::from_utf8_lossy(&line).into_owned()))
}

fn read_request(reader: &mut BufReader<Conn>) -> Result<Option<Request>, u16> {
    let mut first = String::new();
    for _ in 0..4 {
        // tolerate stray blank lines between requests
        match read_line(reader)? {
            None => return Ok(None),
            Some(l) if l.is_empty() => continue,
            Some(l) => {
                first = l;
                break;
            }
        }
    }
    let mut parts = first.split(' ');
    let (Some(method), Some(target), Some(version), None) = (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(400);
    };
    let http11 = match version {
        "HTTP/1.1" => true,
        "HTTP/1.0" => false,
        _ => return Err(400),
    };
    let mut headers = Vec::new();
    loop {
        let Some(line) = read_line(reader)? else { return Err(400) };
        if line.is_empty() {
            break;
        }
        if headers.len() >= MAX_HEADERS {
            return Err(431);
        }
        let Some((name, value)) = line.split_once(':') else { return Err(400) };
        headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
    }
    Ok(Some(Request { method: method.into(), target: target.into(), http11, headers }))
}

fn handle(req: &Request, reader: &mut BufReader<Conn>) -> Response {
    match req.method.as_str() {
        "GET" | "HEAD" => {
            // A body on a GET is allowed but meaningless; skip it to keep the connection usable.
            let len = req.header("content-length").and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
            let skipped = io::copy(&mut reader.by_ref().take(len.min(64 * 1024)), &mut io::sink()).unwrap_or(0);
            let resp = get(req);
            if req.header("transfer-encoding").is_some() || skipped < len {
                resp.closing()
            } else {
                resp
            }
        }
        "POST" => post(req, reader),
        m => Response::page_error(501, &format!("Unsupported method ({m:?})")).closing(),
    }
}

fn get(req: &Request) -> Response {
    let path = req.path();
    if path == "/api/status" {
        return Response::json(200, BEDTIME.status());
    }
    if req.target.starts_with("/api/") {
        return Response::error(404, "Unknown endpoint.");
    }
    if path == CA_PATH {
        return match tls::ca_certificate() {
            Some(der) => Response {
                code: 200,
                content_type: "application/x-x509-ca-cert",
                body: Body::Owned(der),
                headers: vec![("Content-Disposition", "attachment; filename=\"Nightfall.crt\"".into())],
                close: false,
            },
            None => Response::page_error(404, "https isn't ready on this PC; see the log."),
        };
    }
    if path == "/setup" {
        let mut resp = Response::page_error(301, "Moved Permanently.");
        resp.headers.push(("Location", "/setup.html".into()));
        return resp;
    }
    static_file(req)
}

/// Where phones download the certificate authority that makes https work.
pub const CA_PATH: &str = "/nightfall.crt";

fn post(req: &Request, reader: &mut BufReader<Conn>) -> Response {
    // A JSON content type forces a CORS preflight, which we never answer, so other
    // websites open in a browser on the LAN can't fire these endpoints.
    if !req.header("content-type").unwrap_or("").starts_with("application/json") {
        return Response::error(415, "Send JSON.").closing();
    }
    if let Some(origin) = req.header("origin").filter(|o| !o.is_empty()) {
        if Some(netloc(origin)) != req.header("host") {
            return Response::error(403, "Cross-origin request refused.").closing();
        }
    }
    if req.header("transfer-encoding").is_some() {
        return Response::error(411, "Send a Content-Length.").closing();
    }
    let len = match req.header("content-length").map(|v| v.parse::<u64>()) {
        None => 0,
        Some(Ok(n)) => n,
        Some(Err(_)) => return Response::error(400, "Body is not valid JSON.").closing(),
    };
    let mut body = Vec::new();
    let want = len.min(MAX_BODY);
    if reader.by_ref().take(want).read_to_end(&mut body).is_err() || (body.len() as u64) < want {
        return Response::error(400, "Body is not valid JSON.").closing();
    }
    let more_left = len > MAX_BODY;
    let data = if body.is_empty() {
        Some(Value::Obj(vec![]))
    } else {
        std::str::from_utf8(&body).ok().and_then(json::parse)
    };
    let Some(data) = data else {
        let resp = Response::error(400, "Body is not valid JSON.");
        return if more_left { resp.closing() } else { resp };
    };
    let resp = action(req.path(), &data);
    if more_left {
        resp.closing()
    } else {
        resp
    }
}

fn action(route: &str, data: &Value) -> Response {
    let result = match route {
        "/api/dim" => {
            let delay = match data.get("delay") {
                None => Some(0.0),
                Some(Value::Num(n)) => Some(*n),
                Some(Value::Bool(b)) => Some(*b as u8 as f64),
                Some(Value::Str(s)) => s.trim().parse::<f64>().ok(),
                Some(_) => None,
            }
            .filter(|_| matches!(data, Value::Obj(_)));
            match delay {
                Some(d) if (0.0..=MAX_DELAY).contains(&d) => BEDTIME.dim(d),
                _ => return Response::error(400, &format!("Delay must be 0 to {MAX_DELAY} seconds.")),
            }
        }
        "/api/cancel" => {
            BEDTIME.cancel();
            Ok(())
        }
        "/api/wake" => {
            BEDTIME.wake();
            Ok(())
        }
        _ => return Response::error(404, "Unknown endpoint."),
    };
    match result {
        Ok(()) => Response::json(200, BEDTIME.status()),
        Err(e) => {
            crate::error!("action failed: {e}");
            Response::error(500, &format!("Windows refused the request: {e}"))
        }
    }
}

/// The host[:port] of an Origin such as "http://192.168.1.20:39847", as urlsplit() gives it.
fn netloc(url: &str) -> &str {
    let Some((scheme, rest)) = url.split_once(':') else { return "" };
    let scheme_ok = scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        && scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c));
    match rest.strip_prefix("//") {
        Some(rest) if scheme_ok => rest.split(['/', '?', '#']).next().unwrap_or(""),
        _ => "",
    }
}

// --- The page ------------------------------------------------------------------------

fn content_type(path: &str) -> &'static str {
    let ext = path.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "webmanifest" => "application/manifest+json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The request path as clean segments, or None for anything that tries to leave web/.
fn segments(path: &str) -> Option<Vec<String>> {
    let decoded = percent_decode(path)?;
    let mut out = Vec::new();
    for seg in decoded.split('/') {
        match seg {
            "" | "." => {}
            ".." => return None,
            s if s.contains(['\\', ':', '\0']) => return None,
            s => out.push(s.to_string()),
        }
    }
    Some(out)
}

enum Found {
    File { bytes: Body, etag: String },
    Dir,
    Missing,
}

fn find_on_disk(root: &Path, rel: &[String]) -> Found {
    let mut p: PathBuf = root.to_path_buf();
    p.extend(rel);
    let Ok(meta) = fs::metadata(&p) else { return Found::Missing };
    if meta.is_dir() {
        return Found::Dir;
    }
    if !meta.is_file() {
        return Found::Missing;
    }
    let Ok(bytes) = fs::read(&p) else { return Found::Missing };
    let stamp = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
    Found::File { etag: format!("\"d{:x}-{:x}\"", bytes.len(), stamp), bytes: Body::Owned(bytes) }
}

fn find_built_in(rel: &[String]) -> Found {
    let key = format!("/{}", rel.join("/"));
    if let Some((_, bytes, etag)) = assets::ASSETS.iter().find(|(p, _, _)| *p == key) {
        return Found::File { bytes: Body::Static(bytes), etag: (*etag).into() };
    }
    let dir = if key == "/" { key } else { key + "/" };
    if assets::ASSETS.iter().any(|(p, _, _)| p.starts_with(&dir)) {
        Found::Dir
    } else {
        Found::Missing
    }
}

fn static_file(req: &Request) -> Response {
    let path = req.path();
    let Some(mut rel) = segments(path) else { return Response::page_error(404, "File not found.") };
    let find = |rel: &[String]| match &crate::cfg().web {
        Some(root) => find_on_disk(root, rel),
        None => find_built_in(rel),
    };
    let mut found = find(&rel);
    if let Found::Dir = found {
        if !path.ends_with('/') {
            let query = req.target.find('?').map_or("", |i| &req.target[i..]);
            let mut resp = Response::page_error(301, "Moved Permanently.");
            resp.headers.push(("Location", format!("{path}/{query}")));
            return resp;
        }
        rel.push("index.html".into());
        found = find(&rel);
    }
    let Found::File { bytes, etag } = found else { return Response::page_error(404, "File not found.") };
    let content_type = content_type(rel.last().map_or("", |s| s.as_str()));
    let fresh = req
        .header("if-none-match")
        .is_some_and(|v| v.split(',').any(|t| t.trim() == etag || t.trim() == "*"));
    if fresh {
        return Response { code: 304, content_type, body: Body::Static(b""), headers: vec![("ETag", etag)], close: false };
    }
    Response { code: 200, content_type, body: bytes, headers: vec![("ETag", etag)], close: false }
}

// --- Writing replies -----------------------------------------------------------------

fn send(out: &mut Conn, path: &str, resp: Response, head_only: bool) -> io::Result<()> {
    let body: &[u8] = match &resp.body {
        Body::Owned(v) => v,
        Body::Static(s) => s,
    };
    let mut h = format!(
        "HTTP/1.1 {} {}\r\nServer: Nightfall/{}\r\nDate: {}\r\n",
        resp.code,
        reason(resp.code),
        env!("CARGO_PKG_VERSION"),
        http_date(SystemTime::now())
    );
    if resp.code != 304 {
        h += &format!("Content-Type: {}\r\nContent-Length: {}\r\n", resp.content_type, body.len());
    }
    for (k, v) in &resp.headers {
        h += &format!("{k}: {v}\r\n");
    }
    h += "X-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n";
    h += if path.starts_with("/vendor/") {
        "Cache-Control: public, max-age=604800, immutable\r\n"
    } else {
        "Cache-Control: no-cache\r\n"
    };
    h += if resp.close { "Connection: close\r\n\r\n" } else { "Connection: keep-alive\r\n\r\n" };
    out.write_all(h.as_bytes())?;
    if !head_only && resp.code != 304 {
        out.write_all(body)?;
    }
    out.flush()
}

/// "Thu, 26 Nov 2026 20:44:56 GMT"
fn http_date(t: SystemTime) -> String {
    let secs = t.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Howard Hinnant's civil_from_days
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + (month <= 2) as i64;
    const WEEKDAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    format!(
        "{}, {day:02} {} {year} {:02}:{:02}:{:02} GMT",
        WEEKDAYS[days.rem_euclid(7) as usize],
        MONTHS[month as usize - 1],
        rem / 3600,
        rem / 60 % 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_local_and_tailscale_clients_are_allowed() {
        for ok in ["127.0.0.1", "::1", "192.168.1.20", "10.0.0.5", "172.20.1.1", "169.254.3.3", "100.101.102.103",
                   "fd7a:115c:a1e0::1", "fe80::1", "::ffff:192.168.1.20", "::ffff:100.64.0.1"] {
            assert!(client_allowed(ok.parse().unwrap()), "{ok}");
        }
        for no in ["8.8.8.8", "100.128.0.1", "172.32.0.1", "2001:db8::1", "2001::1", "2606:4700::1", "::ffff:8.8.8.8"] {
            assert!(!client_allowed(no.parse().unwrap()), "{no}");
        }
    }

    #[test]
    fn origins_are_compared_by_host_and_port() {
        assert_eq!(netloc("http://192.168.1.20:39847"), "192.168.1.20:39847");
        assert_eq!(netloc("https://pc.tail1234.ts.net:39847/x?y"), "pc.tail1234.ts.net:39847");
        assert_eq!(netloc("null"), "");
        assert_eq!(netloc("a//b"), "");
    }

    #[test]
    fn paths_cannot_leave_the_web_folder() {
        assert_eq!(segments("/vendor/three.module.js").unwrap(), ["vendor", "three.module.js"]);
        assert_eq!(segments("/./a//b").unwrap(), ["a", "b"]);
        for bad in ["/../server.py", "/%2e%2e/server.py", "/a/..%2f..%2fx", "/..%5cserver.py", "/C:/x", "/%zz", "/a%00b"] {
            assert!(segments(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn dates_are_http_dates() {
        assert_eq!(http_date(UNIX_EPOCH), "Thu, 01 Jan 1970 00:00:00 GMT");
        assert_eq!(http_date(UNIX_EPOCH + Duration::from_secs(1_795_725_896)), "Thu, 26 Nov 2026 20:44:56 GMT");
    }

    #[test]
    fn the_page_is_built_in() {
        assert!(matches!(find_built_in(&["index.html".into()]), Found::File { .. }));
        assert!(matches!(find_built_in(&[]), Found::Dir));
        assert!(matches!(find_built_in(&["scenes".into()]), Found::Dir));
        assert!(matches!(find_built_in(&["dev".into(), "devices.html".into()]), Found::Missing));
    }
}

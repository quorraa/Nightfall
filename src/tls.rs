//! https on the same port as http, with Windows' own TLS (SChannel). A connection whose first
//! byte is a TLS handshake record (0x16) is wrapped in a `Stream`; anything else stays plain.
//!
//! `start` issues the server certificate (see cert.rs) and keeps it current: every few minutes
//! it checks this PC's addresses and reissues it if they changed.
#![allow(non_snake_case, clippy::upper_case_acronyms)]

use std::ffi::c_void;
use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::ptr::{null, null_mut};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use crate::cert;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct SecHandle {
    lower: usize,
    upper: usize,
}

#[repr(C)]
struct SecBuffer {
    len: u32,
    kind: u32,
    data: *mut c_void,
}

#[repr(C)]
struct SecBufferDesc {
    version: u32,
    count: u32,
    buffers: *mut SecBuffer,
}

#[repr(C)]
struct SCH_CREDENTIALS {
    dwVersion: u32,
    dwCredFormat: u32,
    cCreds: u32,
    paCred: *const *const c_void,
    hRootStore: *const c_void,
    cMappers: u32,
    aphMappers: *const c_void,
    dwSessionLifespan: u32,
    dwFlags: u32,
    cTlsParameters: u32,
    pTlsParameters: *const c_void,
}

#[repr(C)]
struct CRYPT_KEY_PROV_INFO {
    pwszContainerName: *const u16,
    pwszProvName: *const u16,
    dwProvType: u32,
    dwFlags: u32,
    cProvParam: u32,
    rgProvParam: *const c_void,
    dwKeySpec: u32,
}

#[repr(C)]
#[derive(Default)]
struct StreamSizes {
    header: u32,
    trailer: u32,
    max_message: u32,
    buffers: u32,
    block_size: u32,
}

#[link(name = "secur32")]
extern "system" {
    fn AcquireCredentialsHandleW(
        principal: *const u16, package: *const u16, usage: u32, logon_id: *const c_void, auth: *const c_void,
        get_key: *const c_void, get_key_arg: *const c_void, cred: *mut SecHandle, expiry: *mut i64,
    ) -> i32;
    fn FreeCredentialsHandle(cred: *mut SecHandle) -> i32;
    fn AcceptSecurityContext(
        cred: *const SecHandle, ctx: *const SecHandle, input: *const SecBufferDesc, req: u32, data_rep: u32,
        new_ctx: *mut SecHandle, output: *mut SecBufferDesc, attrs: *mut u32, expiry: *mut i64,
    ) -> i32;
    fn DeleteSecurityContext(ctx: *mut SecHandle) -> i32;
    fn FreeContextBuffer(buf: *mut c_void) -> i32;
    fn QueryContextAttributesW(ctx: *const SecHandle, attr: u32, buf: *mut c_void) -> i32;
    fn EncryptMessage(ctx: *const SecHandle, qop: u32, msg: *mut SecBufferDesc, seq: u32) -> i32;
    fn DecryptMessage(ctx: *const SecHandle, msg: *mut SecBufferDesc, seq: u32, qop: *mut u32) -> i32;
}

#[link(name = "crypt32")]
extern "system" {
    fn CertCreateCertificateContext(encoding: u32, der: *const u8, len: u32) -> *const c_void;
    fn CertSetCertificateContextProperty(cert: *const c_void, prop: u32, flags: u32, data: *const c_void) -> i32;
    fn CertFreeCertificateContext(cert: *const c_void) -> i32;
}

const SEC_E_OK: i32 = 0;
const SEC_I_CONTINUE_NEEDED: i32 = 0x0009_0312;
const SEC_I_CONTEXT_EXPIRED: i32 = 0x0009_0317;
const SEC_E_INCOMPLETE_MESSAGE: i32 = 0x8009_0318u32 as i32;

const SECBUFFER_EMPTY: u32 = 0;
const SECBUFFER_DATA: u32 = 1;
const SECBUFFER_TOKEN: u32 = 2;
const SECBUFFER_EXTRA: u32 = 5;
const SECBUFFER_STREAM_TRAILER: u32 = 6;
const SECBUFFER_STREAM_HEADER: u32 = 7;

const ASC_REQ: u32 = 0x4 | 0x8 | 0x10 | 0x100 | 0x8000 | 0x10000; // replay, sequence, confidentiality, allocate, extended error, stream
const SECPKG_CRED_INBOUND: u32 = 1;
const SECPKG_ATTR_STREAM_SIZES: u32 = 4;
const SCH_CREDENTIALS_VERSION: u32 = 5;
const SCH_CRED_NO_SYSTEM_MAPPER: u32 = 0x2;
const SCH_USE_STRONG_CRYPTO: u32 = 0x0040_0000;
const CERT_KEY_PROV_INFO_PROP_ID: u32 = 2;
const X509_AND_PKCS7: u32 = 0x0001_0001;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

fn sspi_error(what: &str, status: i32) -> io::Error {
    io::Error::other(format!("{what} failed (0x{:08X})", status as u32))
}

/// The server's TLS identity: its certificate (with a link to its key) as SChannel credentials.
pub struct Credentials {
    handle: SecHandle,
    cert: *const c_void,
}

// SChannel credential handles may be used from any thread.
unsafe impl Send for Credentials {}
unsafe impl Sync for Credentials {}

impl Credentials {
    pub fn new(certificate: &[u8]) -> io::Result<Credentials> {
        unsafe {
            let cert = CertCreateCertificateContext(X509_AND_PKCS7, certificate.as_ptr(), certificate.len() as u32);
            if cert.is_null() {
                return Err(io::Error::other(format!("CertCreateCertificateContext: {}", io::Error::last_os_error())));
            }
            let mut creds = Credentials { handle: SecHandle::default(), cert };
            let container = wide(cert::SERVER_KEY);
            let provider = wide(cert::KEY_STORE);
            let key = CRYPT_KEY_PROV_INFO {
                pwszContainerName: container.as_ptr(),
                pwszProvName: provider.as_ptr(),
                dwProvType: 0, // a CNG key
                dwFlags: 0,
                cProvParam: 0,
                rgProvParam: null(),
                dwKeySpec: 0,
            };
            if CertSetCertificateContextProperty(cert, CERT_KEY_PROV_INFO_PROP_ID, 0, (&key as *const CRYPT_KEY_PROV_INFO).cast()) == 0 {
                return Err(io::Error::other(format!("linking the server key: {}", io::Error::last_os_error())));
            }
            let certs = [cert];
            let auth = SCH_CREDENTIALS {
                dwVersion: SCH_CREDENTIALS_VERSION,
                dwCredFormat: 0,
                cCreds: 1,
                paCred: certs.as_ptr(),
                hRootStore: null(),
                cMappers: 0,
                aphMappers: null(),
                dwSessionLifespan: 0,
                dwFlags: SCH_CRED_NO_SYSTEM_MAPPER | SCH_USE_STRONG_CRYPTO,
                cTlsParameters: 0,
                pTlsParameters: null(),
            };
            let package = wide("Microsoft Unified Security Protocol Provider");
            let status = AcquireCredentialsHandleW(
                null(), package.as_ptr(), SECPKG_CRED_INBOUND, null(), (&auth as *const SCH_CREDENTIALS).cast(),
                null(), null(), &mut creds.handle, null_mut(),
            );
            if status != SEC_E_OK {
                return Err(sspi_error("AcquireCredentialsHandle", status));
            }
            Ok(creds)
        }
    }
}

impl Drop for Credentials {
    fn drop(&mut self) {
        unsafe {
            if self.handle.lower != 0 || self.handle.upper != 0 {
                FreeCredentialsHandle(&mut self.handle);
            }
            CertFreeCertificateContext(self.cert);
        }
    }
}

// --- Keeping a certificate ready -------------------------------------------------------

static CREDENTIALS: RwLock<Option<Arc<Credentials>>> = RwLock::new(None);
static CA: RwLock<Option<Vec<u8>>> = RwLock::new(None);

/// The credentials new https connections use, once a certificate is ready.
pub fn credentials() -> Option<Arc<Credentials>> {
    CREDENTIALS.read().ok()?.clone()
}

/// The CA certificate (DER) that phones install to trust Nightfall's https.
pub fn ca_certificate() -> Option<Vec<u8>> {
    CA.read().ok()?.clone()
}

/// Issue a certificate for this PC's current addresses now, then keep it current.
pub fn start(host: String) {
    let mut names = refresh(&host, None);
    let _ = std::thread::Builder::new().name("tls".into()).spawn(move || loop {
        std::thread::sleep(Duration::from_secs(300));
        names = refresh(&host, names.take());
    });
}

/// Reissue the server certificate if this PC's addresses differ from `last`.
fn refresh(host: &str, last: Option<cert::Names>) -> Option<cert::Names> {
    let names = cert::current_names(host);
    if last.as_ref() == Some(&names) {
        return last;
    }
    if names.ips.is_empty() && names.local_name.is_none() {
        return None;
    }
    let result = cert::issue(host, &names).and_then(|issued| Ok((Credentials::new(&issued.server)?, issued.ca)));
    match result {
        Ok((creds, ca)) => {
            *CREDENTIALS.write().unwrap() = Some(Arc::new(creds));
            *CA.write().unwrap() = Some(ca);
            crate::info!("https ready for {names}");
            Some(names)
        }
        Err(e) => {
            crate::warning!("https unavailable: {e}");
            last
        }
    }
}

// --- A TLS connection ----------------------------------------------------------------

pub struct Stream {
    tcp: TcpStream,
    _creds: Arc<Credentials>,
    ctx: SecHandle,
    sizes: StreamSizes,
    /// Received bytes not decrypted yet.
    incoming: Vec<u8>,
    /// Decrypted bytes not read yet.
    plain: Vec<u8>,
    plain_at: usize,
    closed: bool,
}

unsafe impl Send for Stream {}

fn read_more(tcp: &mut TcpStream, into: &mut Vec<u8>) -> io::Result<usize> {
    let mut buf = [0u8; 16 * 1024];
    let n = tcp.read(&mut buf)?;
    into.extend_from_slice(&buf[..n]);
    Ok(n)
}

impl Stream {
    /// Do the server side of the TLS handshake on `tcp`.
    pub fn accept(mut tcp: TcpStream, creds: Arc<Credentials>) -> io::Result<Stream> {
        let mut ctx = SecHandle::default();
        let mut have_ctx = false;
        let mut incoming = Vec::new();
        let mut need_more = true;
        loop {
            if need_more && read_more(&mut tcp, &mut incoming)? == 0 {
                return Err(io::ErrorKind::UnexpectedEof.into());
            }
            let mut input = [
                SecBuffer { len: incoming.len() as u32, kind: SECBUFFER_TOKEN, data: incoming.as_mut_ptr().cast() },
                SecBuffer { len: 0, kind: SECBUFFER_EMPTY, data: null_mut() },
            ];
            let input_desc = SecBufferDesc { version: 0, count: 2, buffers: input.as_mut_ptr() };
            let mut output = [SecBuffer { len: 0, kind: SECBUFFER_TOKEN, data: null_mut() }];
            let mut output_desc = SecBufferDesc { version: 0, count: 1, buffers: output.as_mut_ptr() };
            let mut attrs = 0u32;
            let status = unsafe {
                AcceptSecurityContext(
                    &creds.handle, if have_ctx { &ctx } else { null() }, &input_desc, ASC_REQ, 0, &mut ctx,
                    &mut output_desc, &mut attrs, null_mut(),
                )
            };
            if !output[0].data.is_null() {
                let token = unsafe { std::slice::from_raw_parts(output[0].data as *const u8, output[0].len as usize) };
                let sent = tcp.write_all(token);
                unsafe { FreeContextBuffer(output[0].data) };
                sent?;
            }
            match status {
                SEC_E_OK | SEC_I_CONTINUE_NEEDED => {
                    have_ctx = true;
                    // Bytes after this handshake message (the next message, or the first request).
                    let extra = if input[1].kind == SECBUFFER_EXTRA { input[1].len as usize } else { 0 };
                    incoming.drain(..incoming.len() - extra);
                    if status == SEC_E_OK {
                        break;
                    }
                    need_more = incoming.is_empty();
                }
                SEC_E_INCOMPLETE_MESSAGE => need_more = true,
                e => {
                    if have_ctx {
                        unsafe { DeleteSecurityContext(&mut ctx) };
                    }
                    return Err(sspi_error("TLS handshake", e));
                }
            }
        }
        let mut sizes = StreamSizes::default();
        let status = unsafe { QueryContextAttributesW(&ctx, SECPKG_ATTR_STREAM_SIZES, (&mut sizes as *mut StreamSizes).cast()) };
        if status != SEC_E_OK {
            unsafe { DeleteSecurityContext(&mut ctx) };
            return Err(sspi_error("QueryContextAttributes", status));
        }
        Ok(Stream { tcp, _creds: creds, ctx, sizes, incoming, plain: Vec::new(), plain_at: 0, closed: false })
    }

    pub fn tcp(&self) -> &TcpStream {
        &self.tcp
    }

    /// Decrypt the next record into `plain`. Ok(false) at the end of the stream.
    fn decrypt_more(&mut self) -> io::Result<bool> {
        loop {
            if !self.incoming.is_empty() {
                let mut bufs = [
                    SecBuffer { len: self.incoming.len() as u32, kind: SECBUFFER_DATA, data: self.incoming.as_mut_ptr().cast() },
                    SecBuffer { len: 0, kind: SECBUFFER_EMPTY, data: null_mut() },
                    SecBuffer { len: 0, kind: SECBUFFER_EMPTY, data: null_mut() },
                    SecBuffer { len: 0, kind: SECBUFFER_EMPTY, data: null_mut() },
                ];
                let mut desc = SecBufferDesc { version: 0, count: 4, buffers: bufs.as_mut_ptr() };
                let status = unsafe { DecryptMessage(&self.ctx, &mut desc, 0, null_mut()) };
                match status {
                    SEC_E_OK => {
                        // Decrypted in place: the data buffer points into `incoming`.
                        self.plain.clear();
                        self.plain_at = 0;
                        let mut extra = 0;
                        for b in &bufs {
                            if b.kind == SECBUFFER_DATA && !b.data.is_null() {
                                self.plain.extend_from_slice(unsafe { std::slice::from_raw_parts(b.data as *const u8, b.len as usize) });
                            } else if b.kind == SECBUFFER_EXTRA {
                                extra = b.len as usize;
                            }
                        }
                        let len = self.incoming.len();
                        self.incoming.drain(..len - extra);
                        if !self.plain.is_empty() {
                            return Ok(true);
                        }
                        continue;
                    }
                    SEC_I_CONTEXT_EXPIRED => {
                        self.closed = true;
                        return Ok(false); // the client said goodbye (close_notify)
                    }
                    SEC_E_INCOMPLETE_MESSAGE => {}
                    e => return Err(sspi_error("DecryptMessage", e)),
                }
            }
            if read_more(&mut self.tcp, &mut self.incoming)? == 0 {
                return Ok(false);
            }
        }
    }

    fn encrypt(&mut self, data: &[u8]) -> io::Result<()> {
        let (h, t) = (self.sizes.header as usize, self.sizes.trailer as usize);
        let mut buf = vec![0u8; h + data.len() + t];
        buf[h..h + data.len()].copy_from_slice(data);
        let base = buf.as_mut_ptr();
        let mut bufs = [
            SecBuffer { len: h as u32, kind: SECBUFFER_STREAM_HEADER, data: base.cast() },
            SecBuffer { len: data.len() as u32, kind: SECBUFFER_DATA, data: unsafe { base.add(h) }.cast() },
            SecBuffer { len: t as u32, kind: SECBUFFER_STREAM_TRAILER, data: unsafe { base.add(h + data.len()) }.cast() },
            SecBuffer { len: 0, kind: SECBUFFER_EMPTY, data: null_mut() },
        ];
        let mut desc = SecBufferDesc { version: 0, count: 4, buffers: bufs.as_mut_ptr() };
        let status = unsafe { EncryptMessage(&self.ctx, 0, &mut desc, 0) };
        if status != SEC_E_OK {
            return Err(sspi_error("EncryptMessage", status));
        }
        let total = (bufs[0].len + bufs[1].len + bufs[2].len) as usize;
        self.tcp.write_all(&buf[..total])
    }
}

impl Read for Stream {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if self.plain_at >= self.plain.len() && (self.closed || !self.decrypt_more()?) {
            return Ok(0);
        }
        let n = out.len().min(self.plain.len() - self.plain_at);
        out[..n].copy_from_slice(&self.plain[self.plain_at..self.plain_at + n]);
        self.plain_at += n;
        Ok(n)
    }
}

impl Write for Stream {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        let n = data.len().min(self.sizes.max_message.max(1) as usize);
        self.encrypt(&data[..n])?;
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.tcp.flush()
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        unsafe { DeleteSecurityContext(&mut self.ctx) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn structs_match_windows() {
        assert_eq!(size_of::<SecHandle>(), 16);
        assert_eq!(size_of::<SecBuffer>(), 16);
        assert_eq!(size_of::<SecBufferDesc>(), 16);
        assert_eq!(size_of::<SCH_CREDENTIALS>(), 72);
        assert_eq!(size_of::<CRYPT_KEY_PROV_INFO>(), 48);
        assert_eq!(size_of::<StreamSizes>(), 20);
    }
}

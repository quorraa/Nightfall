//! Nightfall's own certificate authority, so phones can open it over https on the home
//! network. (Chrome only installs a web app from an https address.)
//!
//! Two RSA keys are made once and kept by Windows (the Software Key Storage Provider: tied
//! to this Windows account, and never exportable): one for the CA and one for the server.
//! The CA certificate is saved in %LOCALAPPDATA%\Nightfall\tls\nightfall-ca.crt, and a phone
//! trusts it once (web/setup.html walks through it). A name constraint lets it vouch only for
//! private IPv4 addresses and .local names, so even a stolen CA key couldn't impersonate a
//! real website. The server certificate is issued fresh at every start, and again whenever
//! this PC's addresses change.
//!
//! The certificates are encoded here (DER, by hand); Windows makes the keys, hashes and signs.
#![allow(non_snake_case)]

use std::ffi::c_void;
use std::fs;
use std::io;
use std::net::{IpAddr, Ipv4Addr, ToSocketAddrs, UdpSocket};
use std::path::PathBuf;
use std::ptr::{null, null_mut};
use std::time::{SystemTime, UNIX_EPOCH};

pub const KEY_STORE: &str = "Microsoft Software Key Storage Provider";
pub const CA_KEY: &str = "Nightfall CA";
pub const SERVER_KEY: &str = "Nightfall server";

const DAY: i64 = 86_400;
const SERVER_DAYS: i64 = 397; // under Apple's 825-day limit for TLS certificates
const CA_DAYS: i64 = 30 * 365;

#[link(name = "ncrypt")]
extern "system" {
    fn NCryptOpenStorageProvider(provider: *mut usize, name: *const u16, flags: u32) -> i32;
    fn NCryptOpenKey(provider: usize, key: *mut usize, name: *const u16, legacy_spec: u32, flags: u32) -> i32;
    fn NCryptCreatePersistedKey(provider: usize, key: *mut usize, alg: *const u16, name: *const u16, legacy_spec: u32, flags: u32) -> i32;
    fn NCryptSetProperty(object: usize, name: *const u16, value: *const u8, len: u32, flags: u32) -> i32;
    fn NCryptFinalizeKey(key: usize, flags: u32) -> i32;
    fn NCryptExportKey(
        key: usize, export_key: usize, blob: *const u16, params: *const c_void, out: *mut u8, cap: u32, len: *mut u32, flags: u32,
    ) -> i32;
    fn NCryptSignHash(
        key: usize, padding: *const c_void, hash: *const u8, hash_len: u32, sig: *mut u8, cap: u32, len: *mut u32, flags: u32,
    ) -> i32;
    fn NCryptDeleteKey(key: usize, flags: u32) -> i32;
    fn NCryptFreeObject(object: usize) -> i32;
}

#[link(name = "bcrypt")]
extern "system" {
    fn BCryptHash(alg: usize, secret: *const u8, secret_len: u32, input: *const u8, input_len: u32, out: *mut u8, out_len: u32) -> i32;
    fn BCryptGenRandom(alg: usize, buf: *mut u8, len: u32, flags: u32) -> i32;
}

const NCRYPT_SILENT_FLAG: u32 = 0x40;
const BCRYPT_PAD_PKCS1: u32 = 0x2;
const BCRYPT_SHA1_ALG_HANDLE: usize = 0x31;
const BCRYPT_SHA256_ALG_HANDLE: usize = 0x41;
const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x2;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

fn check(status: i32, what: &str) -> io::Result<()> {
    if status == 0 {
        Ok(())
    } else {
        Err(io::Error::other(format!("{what} failed (0x{:08X})", status as u32)))
    }
}

fn hash(alg: usize, data: &[u8], out: &mut [u8]) -> io::Result<()> {
    check(
        unsafe { BCryptHash(alg, null(), 0, data.as_ptr(), data.len() as u32, out.as_mut_ptr(), out.len() as u32) },
        "BCryptHash",
    )
}

fn sha256(data: &[u8]) -> io::Result<[u8; 32]> {
    let mut out = [0u8; 32];
    hash(BCRYPT_SHA256_ALG_HANDLE, data, &mut out)?;
    Ok(out)
}

fn sha1(data: &[u8]) -> io::Result<[u8; 20]> {
    let mut out = [0u8; 20];
    hash(BCRYPT_SHA1_ALG_HANDLE, data, &mut out)?;
    Ok(out)
}

fn random<const N: usize>() -> io::Result<[u8; N]> {
    let mut out = [0u8; N];
    check(unsafe { BCryptGenRandom(0, out.as_mut_ptr(), N as u32, BCRYPT_USE_SYSTEM_PREFERRED_RNG) }, "BCryptGenRandom")?;
    Ok(out)
}

// --- Keys ----------------------------------------------------------------------------

struct Object(usize);

impl Drop for Object {
    fn drop(&mut self) {
        if self.0 != 0 {
            unsafe { NCryptFreeObject(self.0) };
        }
    }
}

fn key_store() -> io::Result<Object> {
    let mut p = 0;
    check(unsafe { NCryptOpenStorageProvider(&mut p, wide(KEY_STORE).as_ptr(), 0) }, "NCryptOpenStorageProvider")?;
    Ok(Object(p))
}

/// A persisted RSA key in the user's key store.
pub struct Key(Object);

impl Key {
    /// Open the key called `name`, or make it. Returns whether it was just made.
    pub fn open_or_create(name: &str) -> io::Result<(Key, bool)> {
        let store = key_store()?;
        let name_w = wide(name);
        let mut k = 0;
        if unsafe { NCryptOpenKey(store.0, &mut k, name_w.as_ptr(), 0, NCRYPT_SILENT_FLAG) } == 0 {
            return Ok((Key(Object(k)), false));
        }
        check(
            unsafe { NCryptCreatePersistedKey(store.0, &mut k, wide("RSA").as_ptr(), name_w.as_ptr(), 0, 0) },
            "NCryptCreatePersistedKey",
        )?;
        let key = Key(Object(k));
        let bits: u32 = 2048;
        check(
            unsafe { NCryptSetProperty(k, wide("Length").as_ptr(), (&bits as *const u32).cast(), 4, 0) },
            "NCryptSetProperty(Length)",
        )?;
        check(unsafe { NCryptFinalizeKey(k, NCRYPT_SILENT_FLAG) }, "NCryptFinalizeKey")?;
        Ok((key, true))
    }

    /// The DER RSAPublicKey (modulus and exponent).
    fn rsa_public_key(&self) -> io::Result<Vec<u8>> {
        let blob_type = wide("RSAPUBLICBLOB");
        let mut len = 0u32;
        check(
            unsafe { NCryptExportKey(self.0 .0, 0, blob_type.as_ptr(), null(), null_mut(), 0, &mut len, 0) },
            "NCryptExportKey",
        )?;
        let mut blob = vec![0u8; len as usize];
        check(
            unsafe { NCryptExportKey(self.0 .0, 0, blob_type.as_ptr(), null(), blob.as_mut_ptr(), len, &mut len, 0) },
            "NCryptExportKey",
        )?;
        // BCRYPT_RSAKEY_BLOB: magic, bit length, exponent size, modulus size, 0, 0; then both, big-endian.
        let word = |i: usize| u32::from_le_bytes(blob[i * 4..i * 4 + 4].try_into().unwrap()) as usize;
        let (e_len, n_len) = (word(2), word(3));
        let e = &blob[24..24 + e_len];
        let n = &blob[24 + e_len..24 + e_len + n_len];
        Ok(seq(&[int(n), int(e)]))
    }

    /// SubjectPublicKeyInfo, and the key identifier (SHA-1 of the public key, RFC 5280 4.2.1.2).
    pub fn public_key_info(&self) -> io::Result<(Vec<u8>, [u8; 20])> {
        let rsa = self.rsa_public_key()?;
        let spki = seq(&[seq(&[oid(RSA_ENCRYPTION), null_value()]), bits(&rsa, 0)]);
        Ok((spki, sha1(&rsa)?))
    }

    /// An RSA PKCS #1 v1.5 signature over SHA-256 of `data`.
    fn sign(&self, data: &[u8]) -> io::Result<Vec<u8>> {
        #[repr(C)]
        struct Padding {
            alg: *const u16,
        }
        let alg = wide("SHA256");
        let padding = Padding { alg: alg.as_ptr() };
        let digest = sha256(data)?;
        let flags = BCRYPT_PAD_PKCS1 | NCRYPT_SILENT_FLAG;
        let mut len = 0u32;
        let pad = (&padding as *const Padding).cast();
        check(
            unsafe { NCryptSignHash(self.0 .0, pad, digest.as_ptr(), 32, null_mut(), 0, &mut len, flags) },
            "NCryptSignHash",
        )?;
        let mut sig = vec![0u8; len as usize];
        check(
            unsafe { NCryptSignHash(self.0 .0, pad, digest.as_ptr(), 32, sig.as_mut_ptr(), len, &mut len, flags) },
            "NCryptSignHash",
        )?;
        sig.truncate(len as usize);
        Ok(sig)
    }
}

/// Remove both keys from the key store (uninstalling).
pub fn delete_keys() {
    let Ok(store) = key_store() else { return };
    for name in [CA_KEY, SERVER_KEY] {
        let mut k = 0;
        if unsafe { NCryptOpenKey(store.0, &mut k, wide(name).as_ptr(), 0, NCRYPT_SILENT_FLAG) } == 0
            && unsafe { NCryptDeleteKey(k, NCRYPT_SILENT_FLAG) } != 0
        {
            unsafe { NCryptFreeObject(k) }; // (a deleted key's handle is already freed)
        }
    }
}

// --- DER -----------------------------------------------------------------------------

fn tlv(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut v = vec![tag];
    let n = body.len();
    if n < 0x80 {
        v.push(n as u8);
    } else {
        let len = n.to_be_bytes();
        let skip = len.iter().take_while(|b| **b == 0).count();
        v.push(0x80 | (len.len() - skip) as u8);
        v.extend(&len[skip..]);
    }
    v.extend(body);
    v
}

fn seq(parts: &[Vec<u8>]) -> Vec<u8> {
    tlv(0x30, &parts.concat())
}

fn set(parts: &[Vec<u8>]) -> Vec<u8> {
    tlv(0x31, &parts.concat())
}

/// A non-negative INTEGER from big-endian bytes.
fn int(be: &[u8]) -> Vec<u8> {
    let skip = be.iter().take_while(|b| **b == 0).count().min(be.len().saturating_sub(1));
    let mut body = Vec::new();
    if be.get(skip).is_some_and(|b| b & 0x80 != 0) {
        body.push(0);
    }
    body.extend(&be[skip..]);
    if body.is_empty() {
        body.push(0);
    }
    tlv(0x02, &body)
}

fn oid(arcs: &[u64]) -> Vec<u8> {
    let mut body = Vec::new();
    let mut push = |mut n: u64| {
        let mut chunk = vec![(n & 0x7F) as u8];
        n >>= 7;
        while n > 0 {
            chunk.push(0x80 | (n & 0x7F) as u8);
            n >>= 7;
        }
        chunk.reverse();
        body.extend(chunk);
    };
    push(arcs[0] * 40 + arcs[1]);
    for a in &arcs[2..] {
        push(*a);
    }
    tlv(0x06, &body)
}

fn null_value() -> Vec<u8> {
    vec![0x05, 0x00]
}

fn bits(bytes: &[u8], unused: u8) -> Vec<u8> {
    let mut body = vec![unused];
    body.extend(bytes);
    tlv(0x03, &body)
}

fn octets(bytes: &[u8]) -> Vec<u8> {
    tlv(0x04, bytes)
}

fn utf8(s: &str) -> Vec<u8> {
    tlv(0x0C, s.as_bytes())
}

/// UTCTime before 2050, GeneralizedTime from then on, as RFC 5280 asks.
fn time(unix: i64) -> Vec<u8> {
    let (days, rem) = (unix.div_euclid(DAY), unix.rem_euclid(DAY));
    let z = days + 719_468; // Howard Hinnant's civil_from_days
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + (m <= 2) as i64;
    let clock = format!("{m:02}{d:02}{:02}{:02}{:02}Z", rem / 3600, rem / 60 % 60, rem % 60);
    if y < 2050 {
        tlv(0x17, format!("{:02}{clock}", y % 100).as_bytes())
    } else {
        tlv(0x18, format!("{y:04}{clock}").as_bytes())
    }
}

fn name(common_name: &str) -> Vec<u8> {
    seq(&[set(&[seq(&[oid(&[2, 5, 4, 3]), utf8(common_name)])])])
}

fn extension(id: &[u64], critical: bool, value: Vec<u8>) -> Vec<u8> {
    let mut parts = vec![oid(id)];
    if critical {
        parts.push(vec![0x01, 0x01, 0xFF]);
    }
    parts.push(octets(&value));
    seq(&parts)
}

const RSA_ENCRYPTION: &[u64] = &[1, 2, 840, 113549, 1, 1, 1];
const SHA256_WITH_RSA: &[u64] = &[1, 2, 840, 113549, 1, 1, 11];
const BASIC_CONSTRAINTS: &[u64] = &[2, 5, 29, 19];
const KEY_USAGE: &[u64] = &[2, 5, 29, 15];
const EXT_KEY_USAGE: &[u64] = &[2, 5, 29, 37];
const SUBJECT_ALT_NAME: &[u64] = &[2, 5, 29, 17];
const NAME_CONSTRAINTS: &[u64] = &[2, 5, 29, 30];
const SUBJECT_KEY_ID: &[u64] = &[2, 5, 29, 14];
const AUTHORITY_KEY_ID: &[u64] = &[2, 5, 29, 35];
const SERVER_AUTH: &[u64] = &[1, 3, 6, 1, 5, 5, 7, 3, 1];

/// The private IPv4 ranges the CA may vouch for (with .local names).
pub const PERMITTED: [(Ipv4Addr, Ipv4Addr); 3] = [
    (Ipv4Addr::new(10, 0, 0, 0), Ipv4Addr::new(255, 0, 0, 0)),
    (Ipv4Addr::new(172, 16, 0, 0), Ipv4Addr::new(255, 240, 0, 0)),
    (Ipv4Addr::new(192, 168, 0, 0), Ipv4Addr::new(255, 255, 0, 0)),
];

struct Spec<'a> {
    issuer: &'a str,
    subject: &'a str,
    not_before: i64,
    not_after: i64,
    public_key_info: &'a [u8],
    extensions: Vec<Vec<u8>>,
}

fn certificate(spec: Spec, signer: &Key) -> io::Result<Vec<u8>> {
    let mut serial = random::<16>()?;
    serial[0] = (serial[0] & 0x7F) | 0x40; // positive, and a full 16 bytes
    let algorithm = seq(&[oid(SHA256_WITH_RSA), null_value()]);
    let tbs = seq(&[
        tlv(0xA0, &int(&[2])), // version 3
        int(&serial),
        algorithm.clone(),
        name(spec.issuer),
        seq(&[time(spec.not_before), time(spec.not_after)]),
        name(spec.subject),
        spec.public_key_info.to_vec(),
        tlv(0xA3, &seq(&spec.extensions)),
    ]);
    let signature = signer.sign(&tbs)?;
    Ok(seq(&[tbs, algorithm, bits(&signature, 0)]))
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

fn ca_name(host: &str) -> String {
    format!("Nightfall home network ({host})")
}

fn make_ca(host: &str, key: &Key) -> io::Result<Vec<u8>> {
    let (spki, key_id) = key.public_key_info()?;
    let mut subtrees = Vec::new();
    for (net, mask) in PERMITTED {
        subtrees.push(seq(&[tlv(0x87, &[net.octets(), mask.octets()].concat())]));
    }
    subtrees.push(seq(&[tlv(0x82, b"local")]));
    let t = now();
    certificate(
        Spec {
            issuer: &ca_name(host),
            subject: &ca_name(host),
            not_before: t - DAY,
            not_after: t + CA_DAYS * DAY,
            public_key_info: &spki,
            extensions: vec![
                extension(BASIC_CONSTRAINTS, true, seq(&[vec![0x01, 0x01, 0xFF], int(&[0])])), // CA, no sub-CAs
                extension(KEY_USAGE, true, bits(&[0x06], 1)), // keyCertSign, cRLSign
                extension(SUBJECT_KEY_ID, false, octets(&key_id)),
                extension(NAME_CONSTRAINTS, true, seq(&[tlv(0xA0, &subtrees.concat())])),
            ],
        },
        key,
    )
}

/// The addresses and name a server certificate covers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Names {
    pub ips: Vec<Ipv4Addr>,
    pub local_name: Option<String>,
}

impl std::fmt::Display for Names {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        let mut all: Vec<String> = self.ips.iter().map(|ip| ip.to_string()).collect();
        all.extend(self.local_name.clone());
        f.write_str(&all.join(", "))
    }
}

fn permitted(ip: Ipv4Addr) -> bool {
    PERMITTED.iter().any(|(net, mask)| u32::from(ip) & u32::from(*mask) == u32::from(*net))
}

/// This PC's private IPv4 addresses, and its .local name.
pub fn current_names(host: &str) -> Names {
    let mut ips: Vec<Ipv4Addr> = (host, 0u16)
        .to_socket_addrs()
        .map(|a| a.filter_map(|a| match a.ip() { IpAddr::V4(v4) => Some(v4), _ => None }).collect())
        .unwrap_or_default();
    // The address the default route uses (connecting UDP sends nothing).
    if let Ok(s) = UdpSocket::bind("0.0.0.0:0") {
        if s.connect("192.0.2.1:9").is_ok() {
            if let Ok(IpAddr::V4(v4)) = s.local_addr().map(|a| a.ip()) {
                ips.push(v4);
            }
        }
    }
    ips.retain(|ip| permitted(*ip));
    ips.sort();
    ips.dedup();
    let label = host.to_ascii_lowercase();
    let valid = !label.is_empty()
        && label.len() <= 63
        && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        && !label.starts_with('-')
        && !label.ends_with('-');
    Names { ips, local_name: valid.then(|| format!("{label}.local")) }
}

fn make_server(host: &str, names: &Names, ca_key: &Key, server_key: &Key) -> io::Result<Vec<u8>> {
    let (spki, key_id) = server_key.public_key_info()?;
    let (_, ca_id) = ca_key.public_key_info()?;
    let mut alt = Vec::new();
    for ip in &names.ips {
        alt.push(tlv(0x87, &ip.octets()));
    }
    if let Some(n) = &names.local_name {
        alt.push(tlv(0x82, n.as_bytes()));
    }
    let t = now();
    certificate(
        Spec {
            issuer: &ca_name(host),
            subject: host,
            not_before: t - DAY,
            not_after: t + SERVER_DAYS * DAY,
            public_key_info: &spki,
            extensions: vec![
                extension(BASIC_CONSTRAINTS, true, seq(&[])),
                extension(KEY_USAGE, true, bits(&[0xA0], 5)), // digitalSignature, keyEncipherment
                extension(EXT_KEY_USAGE, false, seq(&[oid(SERVER_AUTH)])),
                extension(SUBJECT_ALT_NAME, false, seq(&alt)),
                extension(SUBJECT_KEY_ID, false, octets(&key_id)),
                extension(AUTHORITY_KEY_ID, false, seq(&[tlv(0x80, &ca_id)])),
            ],
        },
        ca_key,
    )
}

// --- Issuing -------------------------------------------------------------------------

pub fn folder() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Nightfall").join("tls"))
}

pub struct Issued {
    pub ca: Vec<u8>,
    pub server: Vec<u8>,
}

/// The CA certificate (kept if it still matches the CA key, else made and saved) and a fresh
/// server certificate for `names`.
pub fn issue(host: &str, names: &Names) -> io::Result<Issued> {
    let (ca_key, ca_new) = Key::open_or_create(CA_KEY)?;
    let (spki, _) = ca_key.public_key_info()?;
    let path = folder().ok_or_else(|| io::Error::other("LOCALAPPDATA isn't set"))?.join("nightfall-ca.crt");
    let saved = (!ca_new).then(|| fs::read(&path).ok()).flatten().filter(|der| der.windows(spki.len()).any(|w| w == spki));
    let ca = match saved {
        Some(der) => der,
        None => {
            let der = make_ca(host, &ca_key)?;
            fs::create_dir_all(path.parent().unwrap())?;
            fs::write(&path, &der)?;
            crate::info!("made a new certificate authority; phones need to trust it again (/setup)");
            der
        }
    };
    let (server_key, _) = Key::open_or_create(SERVER_KEY)?;
    let server = make_server(host, names, &ca_key, &server_key)?;
    Ok(Issued { ca, server })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn der_basics() {
        assert_eq!(int(&[0x00, 0x00, 0x05]), [0x02, 0x01, 0x05]);
        assert_eq!(int(&[0x80]), [0x02, 0x02, 0x00, 0x80]);
        assert_eq!(int(&[0, 0]), [0x02, 0x01, 0x00]);
        assert_eq!(oid(&[1, 2, 840, 113549, 1, 1, 11]), [0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x0B]);
        assert_eq!(oid(&[2, 5, 29, 19]), [0x06, 0x03, 0x55, 0x1D, 0x13]);
        let long = tlv(0x04, &[0u8; 300]);
        assert_eq!(&long[..4], &[0x04, 0x82, 0x01, 0x2C]);
        assert_eq!(time(0), tlv(0x17, b"700101000000Z"));
        assert_eq!(time(2_524_608_000), tlv(0x18, b"20500101000000Z")); // 2050 switches to GeneralizedTime
        assert_eq!(time(1_795_725_896), tlv(0x17, b"261126204456Z"));
    }

    #[test]
    fn only_private_addresses_are_permitted() {
        for ok in ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.3"] {
            assert!(permitted(ok.parse().unwrap()), "{ok}");
        }
        for no in ["8.8.8.8", "172.32.0.1", "100.64.0.1", "127.0.0.1", "169.254.1.1"] {
            assert!(!permitted(no.parse().unwrap()), "{no}");
        }
    }

    #[test]
    fn names_include_a_valid_local_name() {
        let n = current_names("My-PC");
        assert_eq!(n.local_name.as_deref(), Some("my-pc.local"));
        assert!(n.ips.iter().all(|ip| permitted(*ip)));
        assert_eq!(current_names("bad name").local_name, None);
    }
}

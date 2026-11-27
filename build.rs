// Builds two things into the .exe:
//  - the web page: every file under web/ (except web/dev, the test pages) becomes an entry in
//    ASSETS with its bytes and an ETag;
//  - Windows resources: the icon (assets/icon-*.png), a manifest (modern dialogs, sharp on
//    high-DPI screens, no admin rights asked for) and version info. They're written as a .res
//    file by hand, which the MSVC linker takes directly, so no resource compiler is needed.
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn walk(dir: &Path, root: &Path, out: &mut Vec<PathBuf>) {
    let mut entries: Vec<_> = fs::read_dir(dir).expect("read web/").flatten().map(|e| e.path()).collect();
    entries.sort();
    for p in entries {
        if p.is_dir() {
            if p.strip_prefix(root).unwrap() == Path::new("dev") {
                continue;
            }
            walk(&p, root, out);
        } else {
            out.push(p);
        }
    }
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn web_assets(manifest_dir: &Path, out_dir: &Path) {
    let root = manifest_dir.join("web");
    println!("cargo:rerun-if-changed=web");
    let mut files = Vec::new();
    walk(&root, &root, &mut files);
    let mut code = String::from("pub static ASSETS: &[(&str, &[u8], &str)] = &[\n");
    for f in &files {
        println!("cargo:rerun-if-changed={}", f.display());
        let rel = f.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/");
        let bytes = fs::read(f).unwrap();
        let etag = format!("\\\"e{:x}-{:x}\\\"", bytes.len(), fnv1a(&bytes));
        code.push_str(&format!("    (\"/{rel}\", include_bytes!(r\"{}\"), \"{etag}\"),\n", f.display()));
    }
    code.push_str("];\n");
    fs::write(out_dir.join("assets.rs"), code).unwrap();
}

// --- Windows resources ---------------------------------------------------------------

const RT_ICON: u16 = 3;
const RT_GROUP_ICON: u16 = 14;
const RT_VERSION: u16 = 16;
const RT_MANIFEST: u16 = 24;
const LANG_EN_US: u16 = 0x0409;

fn pad4(v: &mut Vec<u8>) {
    while v.len() % 4 != 0 {
        v.push(0);
    }
}

/// One entry of a .res file: a fixed 32-byte header (numeric type and name) and the data.
fn res_entry(out: &mut Vec<u8>, kind: u16, id: u16, data: &[u8]) {
    out.extend((data.len() as u32).to_le_bytes());
    out.extend(32u32.to_le_bytes()); // header size
    out.extend([0xFF, 0xFF]);
    out.extend(kind.to_le_bytes());
    out.extend([0xFF, 0xFF]);
    out.extend(id.to_le_bytes());
    out.extend(0u32.to_le_bytes()); // data version
    out.extend(0x1030u16.to_le_bytes()); // memory flags: moveable, pure, discardable
    out.extend(if kind == 0 { 0u16 } else { LANG_EN_US }.to_le_bytes());
    out.extend(0u32.to_le_bytes()); // version
    out.extend(0u32.to_le_bytes()); // characteristics
    out.extend(data);
    pad4(out);
}

fn utf16z(s: &str) -> Vec<u8> {
    s.encode_utf16().chain(Some(0)).flat_map(u16::to_le_bytes).collect()
}

enum Value<'a> {
    None,
    Text(&'a str),
    Bytes(Vec<u8>),
}

/// A VS_VERSIONINFO block: length, value length, type, key, value, then child blocks.
fn ver_block(key: &str, value: Value, children: &[Vec<u8>]) -> Vec<u8> {
    let (value_len, kind, bytes) = match value {
        Value::None => (0u16, 1u16, vec![]),
        Value::Text(t) => (t.encode_utf16().count() as u16 + 1, 1, utf16z(t)),
        Value::Bytes(b) => (b.len() as u16, 0, b),
    };
    let mut v = vec![0, 0];
    v.extend(value_len.to_le_bytes());
    v.extend(kind.to_le_bytes());
    v.extend(utf16z(key));
    pad4(&mut v);
    v.extend(&bytes);
    for child in children {
        pad4(&mut v);
        v.extend(child);
    }
    let len = v.len() as u16;
    v[0..2].copy_from_slice(&len.to_le_bytes());
    v
}

fn version_info() -> Vec<u8> {
    let version = env::var("CARGO_PKG_VERSION").unwrap();
    let parts: Vec<u32> = version.split(['.', '-']).take(3).map(|p| p.parse().unwrap_or(0)).collect();
    let (ms, ls) = ((parts[0] << 16) | parts[1], parts[2] << 16);
    let mut fixed = Vec::new();
    for word in [0xFEEF04BDu32, 0x0001_0000, ms, ls, ms, ls, 0x3F, 0, 0x0004_0004, 1, 0, 0, 0] {
        fixed.extend(word.to_le_bytes()); // signature, struct version, file and product versions,
                                          // flags mask, flags, OS (NT Win32), type (app), subtype, date
    }
    let strings: Vec<Vec<u8>> = [
        ("FileDescription", "Nightfall"),
        ("ProductName", "Nightfall"),
        ("FileVersion", version.as_str()),
        ("ProductVersion", version.as_str()),
        ("InternalName", "nightfall"),
        ("OriginalFilename", "nightfall.exe"),
        ("LegalCopyright", "Copyright (c) 2026 quorraa. MIT License."),
    ]
    .iter()
    .map(|(k, v)| ver_block(k, Value::Text(v), &[]))
    .collect();
    let table = ver_block("040904b0", Value::None, &strings); // US English, Unicode
    let string_info = ver_block("StringFileInfo", Value::None, &[table]);
    let translation = ver_block("Translation", Value::Bytes(vec![0x09, 0x04, 0xB0, 0x04]), &[]);
    let var_info = ver_block("VarFileInfo", Value::None, &[translation]);
    ver_block("VS_VERSION_INFO", Value::Bytes(fixed), &[string_info, var_info])
}

const MANIFEST: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <description>Nightfall</description>
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0"
        processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/>
    </dependentAssembly>
  </dependency>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security><requestedPrivileges><requestedExecutionLevel level="asInvoker" uiAccess="false"/></requestedPrivileges></security>
  </trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application><supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/></application>
  </compatibility>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2</dpiAwareness>
    </windowsSettings>
  </application>
</assembly>
"#;

fn windows_resources(manifest_dir: &Path, out_dir: &Path) {
    let assets = manifest_dir.join("assets");
    println!("cargo:rerun-if-changed=assets");
    let mut icons: Vec<(u32, Vec<u8>)> = fs::read_dir(&assets)
        .expect("read assets/")
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().unwrap().to_string_lossy().starts_with("icon-") && p.extension().is_some_and(|x| x == "png"))
        .map(|p| {
            let png = fs::read(&p).unwrap();
            let width = u32::from_be_bytes(png[16..20].try_into().unwrap()); // IHDR
            (width, png)
        })
        .collect();
    icons.sort_by_key(|(w, _)| std::cmp::Reverse(*w));

    let mut res = Vec::new();
    res_entry(&mut res, 0, 0, &[]); // a .res file starts with an empty entry
    let mut group = Vec::new();
    group.extend([0u16, 1, icons.len() as u16].iter().flat_map(|w| w.to_le_bytes()));
    for (i, (width, png)) in icons.iter().enumerate() {
        let id = i as u16 + 1;
        res_entry(&mut res, RT_ICON, id, png); // PNG-compressed icon images, as Windows allows
        let side = if *width >= 256 { 0 } else { *width as u8 };
        group.extend([side, side, 0, 0]);
        group.extend(1u16.to_le_bytes()); // planes
        group.extend(32u16.to_le_bytes()); // bits per pixel
        group.extend((png.len() as u32).to_le_bytes());
        group.extend(id.to_le_bytes());
    }
    res_entry(&mut res, RT_GROUP_ICON, 1, &group);
    res_entry(&mut res, RT_MANIFEST, 1, MANIFEST.as_bytes());
    res_entry(&mut res, RT_VERSION, 1, &version_info());

    let path = out_dir.join("nightfall.res");
    fs::write(&path, res).unwrap();
    // Every target, so the test build's dialogs look like the real ones too.
    println!("cargo:rustc-link-arg={}", path.display());
}

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    web_assets(&manifest_dir, &out_dir);
    if env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        windows_resources(&manifest_dir, &out_dir);
    }
}

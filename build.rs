// Builds the web page into the .exe: every file under web/ (except web/dev, the test pages)
// becomes an entry in ASSETS with its bytes and an ETag.
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

fn main() {
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("web");
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
    fs::write(PathBuf::from(env::var("OUT_DIR").unwrap()).join("assets.rs"), code).unwrap();
}

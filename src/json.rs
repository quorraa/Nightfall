//! Just enough JSON: parse a small request body, and quote strings for replies.

#[derive(Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Value>),
    Obj(Vec<(String, Value)>),
}

impl Value {
    /// The value under `key` (the last one, as Python's json does with repeated keys).
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Obj(pairs) => pairs.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
}

const MAX_DEPTH: usize = 64;

pub fn parse(text: &str) -> Option<Value> {
    let mut p = Parser { s: text.as_bytes(), i: 0 };
    p.ws();
    let v = p.value(0)?;
    p.ws();
    (p.i == p.s.len()).then_some(v)
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }

    fn ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.i += 1;
        }
    }

    fn eat(&mut self, lit: &[u8]) -> bool {
        if self.s[self.i..].starts_with(lit) {
            self.i += lit.len();
            true
        } else {
            false
        }
    }

    fn value(&mut self, depth: usize) -> Option<Value> {
        if depth > MAX_DEPTH {
            return None;
        }
        match self.peek()? {
            b'{' => {
                self.i += 1;
                let mut pairs = Vec::new();
                self.ws();
                if self.eat(b"}") {
                    return Some(Value::Obj(pairs));
                }
                loop {
                    self.ws();
                    if self.peek()? != b'"' {
                        return None;
                    }
                    let k = self.string()?;
                    self.ws();
                    if !self.eat(b":") {
                        return None;
                    }
                    self.ws();
                    let v = self.value(depth + 1)?;
                    pairs.push((k, v));
                    self.ws();
                    if self.eat(b",") {
                        continue;
                    }
                    return self.eat(b"}").then_some(Value::Obj(pairs));
                }
            }
            b'[' => {
                self.i += 1;
                let mut items = Vec::new();
                self.ws();
                if self.eat(b"]") {
                    return Some(Value::Arr(items));
                }
                loop {
                    self.ws();
                    items.push(self.value(depth + 1)?);
                    self.ws();
                    if self.eat(b",") {
                        continue;
                    }
                    return self.eat(b"]").then_some(Value::Arr(items));
                }
            }
            b'"' => self.string().map(Value::Str),
            b't' => self.eat(b"true").then_some(Value::Bool(true)),
            b'f' => self.eat(b"false").then_some(Value::Bool(false)),
            b'n' => self.eat(b"null").then_some(Value::Null),
            _ => self.number(),
        }
    }

    fn number(&mut self) -> Option<Value> {
        let start = self.i;
        self.eat(b"-");
        let digits = |p: &mut Self| {
            let from = p.i;
            while matches!(p.peek(), Some(b'0'..=b'9')) {
                p.i += 1;
            }
            p.i - from
        };
        let int_start = self.i;
        let n = digits(self);
        if n == 0 || (n > 1 && self.s[int_start] == b'0') {
            return None;
        }
        if self.eat(b".") && digits(self) == 0 {
            return None;
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.i += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.i += 1;
            }
            if digits(self) == 0 {
                return None;
            }
        }
        std::str::from_utf8(&self.s[start..self.i]).ok()?.parse().ok().map(Value::Num)
    }

    fn hex4(&mut self) -> Option<u32> {
        let h = self.s.get(self.i..self.i + 4)?;
        self.i += 4;
        u32::from_str_radix(std::str::from_utf8(h).ok()?, 16).ok()
    }

    fn string(&mut self) -> Option<String> {
        self.i += 1; // opening quote
        let mut out = String::new();
        loop {
            let start = self.i;
            while let Some(c) = self.peek() {
                if c == b'"' || c == b'\\' || c < 0x20 {
                    break;
                }
                self.i += 1;
            }
            // The input is a &str and we only stop on ASCII, so this slice is whole UTF-8.
            out.push_str(std::str::from_utf8(&self.s[start..self.i]).ok()?);
            match self.peek()? {
                b'"' => {
                    self.i += 1;
                    return Some(out);
                }
                b'\\' => {
                    self.i += 1;
                    let c = self.peek()?;
                    self.i += 1;
                    out.push(match c {
                        b'"' => '"',
                        b'\\' => '\\',
                        b'/' => '/',
                        b'b' => '\u{8}',
                        b'f' => '\u{c}',
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        b'u' => {
                            let hi = self.hex4()?;
                            let code = if (0xD800..0xDC00).contains(&hi) && self.s[self.i..].starts_with(b"\\u") {
                                let save = self.i;
                                self.i += 2;
                                match self.hex4()? {
                                    lo @ 0xDC00..=0xDFFF => 0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00),
                                    _ => {
                                        self.i = save;
                                        hi
                                    }
                                }
                            } else {
                                hi
                            };
                            char::from_u32(code).unwrap_or('\u{FFFD}')
                        }
                        _ => return None,
                    });
                }
                _ => return None, // raw control character
            }
        }
    }
}

/// A JSON string literal for `s`.
pub fn string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// A JSON number for `x` (finite values only; anything else becomes 0).
pub fn number(x: f64) -> String {
    if x.is_finite() {
        format!("{x}")
    } else {
        "0".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bodies() {
        assert_eq!(parse(r#"{"delay": 30}"#).unwrap().get("delay"), Some(&Value::Num(30.0)));
        assert_eq!(parse(" { } ").unwrap(), Value::Obj(vec![]));
        assert_eq!(parse(r#"{"a":1,"a":2}"#).unwrap().get("a"), Some(&Value::Num(2.0)));
        assert_eq!(parse(r#"["xé🌙", -1.5e2, true, null]"#).unwrap(),
                   Value::Arr(vec![Value::Str("xé🌙".into()), Value::Num(-150.0), Value::Bool(true), Value::Null]));
    }

    #[test]
    fn rejects_bad_json() {
        for bad in ["", "{", "{\"a\"}", "[1,]", "01", "1.", "NaN", "{'a':1}", "\"a\nb\"", "1 2", "tru"] {
            assert_eq!(parse(bad), None, "{bad:?}");
        }
        assert_eq!(parse(&"[".repeat(100)), None);
    }

    #[test]
    fn quotes_strings() {
        assert_eq!(string("a\"b\\c\n\u{1}"), r#""a\"b\\c\n\u0001""#);
    }
}

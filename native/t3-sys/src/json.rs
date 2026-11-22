//! Minimal JSON value, parser and writer for the stdio protocols.

use std::fmt::Write as _;

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Value>),
    Obj(Vec<(String, Value)>),
}

impl Value {
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Obj(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn str(&self) -> Option<&str> {
        if let Value::Str(s) = self { Some(s) } else { None }
    }
    pub fn num(&self) -> Option<f64> {
        if let Value::Num(n) = self { Some(*n) } else { None }
    }
    pub fn bool(&self) -> Option<bool> {
        if let Value::Bool(b) = self { Some(*b) } else { None }
    }
    pub fn arr(&self) -> Option<&[Value]> {
        if let Value::Arr(a) = self { Some(a) } else { None }
    }
    pub fn get_str(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(Value::str)
    }
    pub fn get_num(&self, key: &str) -> Option<f64> {
        self.get(key).and_then(Value::num)
    }
    pub fn get_bool(&self, key: &str) -> Option<bool> {
        self.get(key).and_then(Value::bool)
    }
}

impl From<&str> for Value {
    fn from(s: &str) -> Self {
        Value::Str(s.to_owned())
    }
}
impl From<String> for Value {
    fn from(s: String) -> Self {
        Value::Str(s)
    }
}
impl From<bool> for Value {
    fn from(b: bool) -> Self {
        Value::Bool(b)
    }
}
macro_rules! num_from {
    ($($t:ty),*) => {$(impl From<$t> for Value { fn from(n: $t) -> Self { Value::Num(n as f64) } })*};
}
num_from!(i32, i64, u32, u64, usize, f64);

/// Builds an object from `(key, value)` pairs.
pub fn obj<const N: usize>(fields: [(&str, Value); N]) -> Value {
    Value::Obj(fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

pub fn write_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

impl Value {
    pub fn write(&self, out: &mut String) {
        match self {
            Value::Null => out.push_str("null"),
            Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Value::Num(n) if n.is_finite() && n.fract() == 0.0 && n.abs() < 9.0e15 => {
                let _ = write!(out, "{}", *n as i64);
            }
            Value::Num(n) if n.is_finite() => {
                let _ = write!(out, "{n}");
            }
            Value::Num(_) => out.push_str("null"),
            Value::Str(s) => write_str(out, s),
            Value::Arr(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    item.write(out);
                }
                out.push(']');
            }
            Value::Obj(fields) => {
                out.push('{');
                for (i, (k, v)) in fields.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write_str(out, k);
                    out.push(':');
                    v.write(out);
                }
                out.push('}');
            }
        }
    }
}

impl std::fmt::Display for Value {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut s = String::new();
        self.write(&mut s);
        f.write_str(&s)
    }
}

pub fn parse(input: &str) -> Result<Value, String> {
    let mut p = Parser { b: input.as_bytes(), i: 0 };
    let v = p.value()?;
    p.ws();
    if p.i != p.b.len() {
        return Err(format!("trailing characters at {}", p.i));
    }
    Ok(v)
}

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
}

impl Parser<'_> {
    fn ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }
    fn eat(&mut self, lit: &str) -> Result<(), String> {
        if self.b[self.i..].starts_with(lit.as_bytes()) {
            self.i += lit.len();
            Ok(())
        } else {
            Err(format!("expected {lit} at {}", self.i))
        }
    }
    fn value(&mut self) -> Result<Value, String> {
        self.ws();
        match self.b.get(self.i) {
            None => Err("unexpected end".into()),
            Some(b'n') => self.eat("null").map(|_| Value::Null),
            Some(b't') => self.eat("true").map(|_| Value::Bool(true)),
            Some(b'f') => self.eat("false").map(|_| Value::Bool(false)),
            Some(b'"') => self.string().map(Value::Str),
            Some(b'[') => {
                self.i += 1;
                let mut items = Vec::new();
                self.ws();
                if self.b.get(self.i) == Some(&b']') {
                    self.i += 1;
                    return Ok(Value::Arr(items));
                }
                loop {
                    items.push(self.value()?);
                    self.ws();
                    match self.b.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b']') => {
                            self.i += 1;
                            return Ok(Value::Arr(items));
                        }
                        _ => return Err(format!("expected , or ] at {}", self.i)),
                    }
                }
            }
            Some(b'{') => {
                self.i += 1;
                let mut fields = Vec::new();
                self.ws();
                if self.b.get(self.i) == Some(&b'}') {
                    self.i += 1;
                    return Ok(Value::Obj(fields));
                }
                loop {
                    self.ws();
                    let key = self.string()?;
                    self.ws();
                    self.eat(":")?;
                    fields.push((key, self.value()?));
                    self.ws();
                    match self.b.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b'}') => {
                            self.i += 1;
                            return Ok(Value::Obj(fields));
                        }
                        _ => return Err(format!("expected , or }} at {}", self.i)),
                    }
                }
            }
            Some(_) => {
                let start = self.i;
                while self.i < self.b.len()
                    && matches!(self.b[self.i], b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9')
                {
                    self.i += 1;
                }
                std::str::from_utf8(&self.b[start..self.i])
                    .ok()
                    .and_then(|s| s.parse().ok())
                    .map(Value::Num)
                    .ok_or_else(|| format!("bad number at {start}"))
            }
        }
    }
    fn hex4(&mut self) -> Result<u32, String> {
        let s = self.b.get(self.i..self.i + 4).ok_or("short \\u escape")?;
        self.i += 4;
        u32::from_str_radix(std::str::from_utf8(s).map_err(|e| e.to_string())?, 16)
            .map_err(|e| e.to_string())
    }
    fn string(&mut self) -> Result<String, String> {
        self.eat("\"")?;
        let mut out = String::new();
        loop {
            let start = self.i;
            while self.i < self.b.len() && self.b[self.i] != b'"' && self.b[self.i] != b'\\' {
                self.i += 1;
            }
            out.push_str(std::str::from_utf8(&self.b[start..self.i]).map_err(|e| e.to_string())?);
            match self.b.get(self.i) {
                Some(b'"') => {
                    self.i += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    let esc = *self.b.get(self.i + 1).ok_or("bad escape")?;
                    self.i += 2;
                    match esc {
                        b'n' => out.push('\n'),
                        b't' => out.push('\t'),
                        b'r' => out.push('\r'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'u' => {
                            let mut cp = self.hex4()?;
                            if (0xd800..0xdc00).contains(&cp) && self.b[self.i..].starts_with(b"\\u") {
                                self.i += 2;
                                let lo = self.hex4()?;
                                cp = 0x10000 + ((cp - 0xd800) << 10) + (lo.wrapping_sub(0xdc00) & 0x3ff);
                            }
                            out.push(char::from_u32(cp).unwrap_or('\u{fffd}'));
                        }
                        c => out.push(c as char),
                    }
                }
                _ => return Err("unterminated string".into()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn round_trips() {
        let src = r#"{"a":[1,-2.5,true,null],"s":"x\"y\né😀"}"#;
        let v = parse(src).unwrap();
        assert_eq!(v.get("s").unwrap().str().unwrap(), "x\"y\né😀");
        assert_eq!(parse(&v.to_string()).unwrap(), v);
    }
}

use std::collections::BTreeMap;
use std::fmt;

const MAX_DEPTH: usize = 128;

#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Json>),
    Object(BTreeMap<String, Json>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsonError {
    pub offset: usize,
    pub message: String,
}

impl fmt::Display for JsonError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "JSON error at byte {}: {}", self.offset, self.message)
    }
}

impl std::error::Error for JsonError {}

impl Json {
    pub fn parse(input: &str) -> Result<Self, JsonError> {
        let mut parser = Parser::new(input);
        let value = parser.parse_value(0)?;
        parser.skip_ws();
        if parser.pos != parser.bytes.len() {
            return Err(parser.err("trailing characters after JSON value"));
        }
        Ok(value)
    }

    pub fn object<I, K>(entries: I) -> Self
    where
        I: IntoIterator<Item = (K, Json)>,
        K: Into<String>,
    {
        let mut map = BTreeMap::new();
        for (k, v) in entries {
            map.insert(k.into(), v);
        }
        Json::Object(map)
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Json::Null)
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Json::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Json::Number(n) => Some(*n),
            _ => None,
        }
    }

    pub fn as_i64(&self) -> Option<i64> {
        self.as_f64().and_then(|n| {
            if n.is_finite() && n.fract() == 0.0 && n >= i64::MIN as f64 && n <= i64::MAX as f64 {
                Some(n as i64)
            } else {
                None
            }
        })
    }

    pub fn as_u64(&self) -> Option<u64> {
        self.as_f64().and_then(|n| {
            if n.is_finite() && n.fract() == 0.0 && n >= 0.0 && n <= u64::MAX as f64 {
                Some(n as u64)
            } else {
                None
            }
        })
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::String(s) => Some(s.as_str()),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Json]> {
        match self {
            Json::Array(arr) => Some(arr.as_slice()),
            _ => None,
        }
    }

    pub fn as_object(&self) -> Option<&BTreeMap<String, Json>> {
        match self {
            Json::Object(map) => Some(map),
            _ => None,
        }
    }

    pub fn as_object_mut(&mut self) -> Option<&mut BTreeMap<String, Json>> {
        match self {
            Json::Object(map) => Some(map),
            _ => None,
        }
    }

    pub fn get(&self, key: &str) -> Option<&Json> {
        self.as_object().and_then(|map| map.get(key))
    }

    pub fn to_json_string(&self) -> String {
        let mut out = String::new();
        self.write_to(&mut out);
        out
    }

    pub fn write_to(&self, out: &mut String) {
        match self {
            Json::Null => out.push_str("null"),
            Json::Bool(true) => out.push_str("true"),
            Json::Bool(false) => out.push_str("false"),
            Json::Number(n) => {
                if !n.is_finite() {
                    out.push_str("null");
                } else if *n == 0.0 {
                    out.push('0');
                } else if n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 {
                    out.push_str(&format!("{}", *n as i64));
                } else {
                    out.push_str(&format!("{n}"));
                }
            }
            Json::String(s) => write_escaped_string(s, out),
            Json::Array(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    item.write_to(out);
                }
                out.push(']');
            }
            Json::Object(map) => {
                out.push('{');
                for (i, (k, v)) in map.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write_escaped_string(k, out);
                    out.push(':');
                    v.write_to(out);
                }
                out.push('}');
            }
        }
    }
}

impl fmt::Display for Json {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_json_string())
    }
}

impl From<bool> for Json {
    fn from(v: bool) -> Self {
        Json::Bool(v)
    }
}

impl From<i64> for Json {
    fn from(v: i64) -> Self {
        Json::Number(v as f64)
    }
}

impl From<u64> for Json {
    fn from(v: u64) -> Self {
        Json::Number(v as f64)
    }
}

impl From<usize> for Json {
    fn from(v: usize) -> Self {
        Json::Number(v as f64)
    }
}

impl From<f64> for Json {
    fn from(v: f64) -> Self {
        Json::Number(v)
    }
}

impl From<String> for Json {
    fn from(v: String) -> Self {
        Json::String(v)
    }
}

impl From<&str> for Json {
    fn from(v: &str) -> Self {
        Json::String(v.to_string())
    }
}

impl<T: Into<Json>> From<Option<T>> for Json {
    fn from(v: Option<T>) -> Self {
        match v {
            Some(inner) => inner.into(),
            None => Json::Null,
        }
    }
}

impl<T: Into<Json>> From<Vec<T>> for Json {
    fn from(v: Vec<T>) -> Self {
        Json::Array(v.into_iter().map(Into::into).collect())
    }
}

pub fn escape_json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    write_escaped_string(s, &mut out);
    out
}

fn write_escaped_string(s: &str, out: &mut String) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\x08' => out.push_str("\\b"),
            '\x0c' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            // Escape U+2028/U+2029 so serialized JSON is always safe to embed directly in JS.
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c => out.push(c),
        }
    }
    out.push('"');
}

struct Parser<'a> {
    src: &'a str,
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Parser<'a> {
    fn new(src: &'a str) -> Self {
        Self {
            src,
            bytes: src.as_bytes(),
            pos: 0,
        }
    }

    fn err(&self, message: impl Into<String>) -> JsonError {
        JsonError {
            offset: self.pos,
            message: message.into(),
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn skip_ws(&mut self) {
        while let Some(b) = self.peek() {
            if matches!(b, b' ' | b'\t' | b'\n' | b'\r') {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    fn parse_value(&mut self, depth: usize) -> Result<Json, JsonError> {
        if depth > MAX_DEPTH {
            return Err(self.err("maximum JSON nesting depth exceeded"));
        }
        self.skip_ws();
        match self.peek() {
            Some(b'n') => self.parse_literal(b"null", Json::Null),
            Some(b't') => self.parse_literal(b"true", Json::Bool(true)),
            Some(b'f') => self.parse_literal(b"false", Json::Bool(false)),
            Some(b'"') => self.parse_string().map(Json::String),
            Some(b'[') => self.parse_array(depth + 1),
            Some(b'{') => self.parse_object(depth + 1),
            Some(b'-' | b'0'..=b'9') => self.parse_number(),
            Some(_) => Err(self.err("unexpected token")),
            None => Err(self.err("unexpected end of input")),
        }
    }

    fn parse_literal(&mut self, expected: &[u8], value: Json) -> Result<Json, JsonError> {
        if self.bytes[self.pos..].starts_with(expected) {
            self.pos += expected.len();
            Ok(value)
        } else {
            Err(self.err("invalid literal"))
        }
    }

    fn parse_string(&mut self) -> Result<String, JsonError> {
        if self.peek() != Some(b'"') {
            return Err(self.err("expected '\"'"));
        }
        self.pos += 1;
        let mut out = String::new();
        let mut start = self.pos;

        while self.pos < self.bytes.len() {
            let b = self.bytes[self.pos];
            if b == b'"' {
                out.push_str(&self.src[start..self.pos]);
                self.pos += 1;
                return Ok(out);
            }
            if b == b'\\' {
                out.push_str(&self.src[start..self.pos]);
                self.pos += 1;
                let esc = self.peek().ok_or_else(|| self.err("unterminated escape"))?;
                self.pos += 1;
                match esc {
                    b'"' => out.push('"'),
                    b'\\' => out.push('\\'),
                    b'/' => out.push('/'),
                    b'b' => out.push('\x08'),
                    b'f' => out.push('\x0c'),
                    b'n' => out.push('\n'),
                    b'r' => out.push('\r'),
                    b't' => out.push('\t'),
                    b'u' => {
                        let code = self.parse_hex4()?;
                        if (0xD800..=0xDBFF).contains(&code) {
                            if !self.bytes[self.pos..].starts_with(b"\\u") {
                                return Err(self.err("unpaired UTF-16 high surrogate"));
                            }
                            self.pos += 2;
                            let low = self.parse_hex4()?;
                            if !(0xDC00..=0xDFFF).contains(&low) {
                                return Err(self.err("invalid UTF-16 low surrogate"));
                            }
                            let scalar =
                                0x10000 + (((code as u32 - 0xD800) << 10) | (low as u32 - 0xDC00));
                            let ch = char::from_u32(scalar)
                                .ok_or_else(|| self.err("invalid unicode scalar"))?;
                            out.push(ch);
                        } else if (0xDC00..=0xDFFF).contains(&code) {
                            return Err(self.err("unexpected UTF-16 low surrogate"));
                        } else {
                            let ch = char::from_u32(code as u32)
                                .ok_or_else(|| self.err("invalid unicode escape"))?;
                            out.push(ch);
                        }
                    }
                    _ => return Err(self.err("invalid escape character")),
                }
                start = self.pos;
            } else if b < 0x20 {
                return Err(self.err("unescaped control character in string"));
            } else {
                self.pos += 1;
            }
        }
        Err(self.err("unterminated string"))
    }

    fn parse_hex4(&mut self) -> Result<u16, JsonError> {
        if self.pos + 4 > self.bytes.len() {
            return Err(self.err("truncated \\uXXXX escape"));
        }
        let hex = &self.src[self.pos..self.pos + 4];
        let val = u16::from_str_radix(hex, 16).map_err(|_| self.err("invalid hex escape"))?;
        self.pos += 4;
        Ok(val)
    }

    fn parse_number(&mut self) -> Result<Json, JsonError> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        match self.peek() {
            Some(b'0') => self.pos += 1,
            Some(b'1'..=b'9') => {
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.pos += 1;
                }
            }
            _ => return Err(self.err("invalid number")),
        }
        if self.peek() == Some(b'.') {
            self.pos += 1;
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(self.err("expected digit after decimal point"));
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.pos += 1;
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.pos += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.pos += 1;
            }
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(self.err("expected digit in exponent"));
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.pos += 1;
            }
        }
        let num = self.src[start..self.pos]
            .parse::<f64>()
            .map_err(|_| self.err("number out of range"))?;
        if !num.is_finite() {
            return Err(self.err("non-finite number"));
        }
        Ok(Json::Number(num))
    }

    fn parse_array(&mut self, depth: usize) -> Result<Json, JsonError> {
        self.pos += 1;
        let mut items = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b']') {
            self.pos += 1;
            return Ok(Json::Array(items));
        }
        loop {
            items.push(self.parse_value(depth)?);
            self.skip_ws();
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b']') => {
                    self.pos += 1;
                    return Ok(Json::Array(items));
                }
                _ => return Err(self.err("expected ',' or ']' in array")),
            }
        }
    }

    fn parse_object(&mut self, depth: usize) -> Result<Json, JsonError> {
        self.pos += 1;
        let mut map = BTreeMap::new();
        self.skip_ws();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(Json::Object(map));
        }
        loop {
            self.skip_ws();
            let key = self.parse_string()?;
            self.skip_ws();
            if self.peek() != Some(b':') {
                return Err(self.err("expected ':' after object key"));
            }
            self.pos += 1;
            let value = self.parse_value(depth)?;
            map.insert(key, value);
            self.skip_ws();
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b'}') => {
                    self.pos += 1;
                    return Ok(Json::Object(map));
                }
                _ => return Err(self.err("expected ',' or '}' in object")),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_complex_json() {
        let input = r#"{"a":1,"b":-2.5,"c":true,"d":null,"e":["hello\n\"world\"","\uD83D\uDE80"],"f":{"nested":false}}"#;
        let parsed = Json::parse(input).expect("parse should succeed");
        assert_eq!(parsed.get("a").and_then(Json::as_i64), Some(1));
        assert_eq!(parsed.get("b").and_then(Json::as_f64), Some(-2.5));
        assert_eq!(parsed.get("c").and_then(Json::as_bool), Some(true));
        assert!(parsed.get("d").is_some_and(Json::is_null));
        let arr = parsed.get("e").and_then(Json::as_array).unwrap();
        assert_eq!(arr[0].as_str(), Some("hello\n\"world\""));
        assert_eq!(arr[1].as_str(), Some("🚀"));

        let serialized = parsed.to_json_string();
        let reparsed = Json::parse(&serialized).expect("reparse should succeed");
        assert_eq!(parsed, reparsed);
    }

    #[test]
    fn rejects_invalid_json() {
        assert!(Json::parse("").is_err());
        assert!(Json::parse("{\"a\":1} trailing").is_err());
        assert!(Json::parse("[1, 2,]").is_err());
        assert!(Json::parse("\"unterminated").is_err());
        assert!(Json::parse("01").is_err());
        assert!(Json::parse("\"\\uD800\"").is_err());
    }
}

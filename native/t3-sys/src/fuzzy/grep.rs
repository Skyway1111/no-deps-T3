//! Line search over file bytes: literal (optionally ASCII case-folded) or regex.

use super::regex::{Cache, Regex};

pub const LINE_MAX: usize = 512;
const BINARY_PROBE: usize = 8 * 1024;
pub const FILE_MAX: u64 = 16 * 1024 * 1024;
/// Buffers past this size are freed after each file instead of kept for the next.
pub const KEEP_BUFFER: usize = 256 * 1024;

pub enum Matcher {
    Plain { needle: Vec<u8>, fold: bool },
    Regex(Regex),
}

#[derive(Debug, PartialEq)]
pub struct LineMatch {
    pub line_number: usize,
    pub content: String,
    pub ranges: Vec<(usize, usize)>,
}

pub fn escape(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if "\\.+*?()|[]{}^$#&-~".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Builds the matcher, falling back to a literal search when a regex does not parse.
pub fn matcher(query: &str, regex: bool, smart_case: bool) -> (Matcher, Option<String>) {
    if regex {
        return match Regex::new(query) {
            Ok(r) => (Matcher::Regex(r), None),
            Err(e) => (Matcher::Plain { needle: query.as_bytes().to_vec(), fold: false }, Some(e)),
        };
    }
    let insensitive = smart_case && !query.chars().any(char::is_uppercase);
    if insensitive
        && !query.is_ascii()
        && let Ok(r) = Regex::new(&format!("(?i){}", escape(query)))
    {
        return (Matcher::Regex(r), None);
    }
    let needle = if insensitive { query.to_ascii_lowercase() } else { query.to_owned() };
    (Matcher::Plain { needle: needle.into_bytes(), fold: insensitive }, None)
}

pub fn is_binary(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(BINARY_PROBE)].contains(&0)
}

fn find(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    let first = *needle.first()?;
    let mut i = from;
    while i + needle.len() <= hay.len() {
        let off = hay[i..=hay.len() - needle.len()].iter().position(|&b| b == first)?;
        i += off;
        if hay[i..].starts_with(needle) {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn line_match(line_number: usize, line: &[u8], ranges: Vec<(usize, usize)>) -> LineMatch {
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    let text = String::from_utf8_lossy(line);
    let mut cut = text.len().min(LINE_MAX);
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    let content = text[..cut].to_owned();
    let ranges = ranges.into_iter().filter(|&(_, e)| e <= content.len()).collect();
    LineMatch { line_number, content, ranges }
}

/// Per-worker buffers, reused from file to file.
pub struct Scratch {
    folded: Vec<u8>,
    cache: Option<Cache>,
}

impl Matcher {
    pub fn scratch(&self) -> Scratch {
        Scratch { folded: Vec::new(), cache: if let Matcher::Regex(r) = self { Some(r.cache()) } else { None } }
    }
}

pub fn search(m: &Matcher, bytes: &[u8], max_matches: usize, scratch: &mut Scratch) -> Vec<LineMatch> {
    let mut out = Vec::new();
    match m {
        Matcher::Plain { needle, fold } => {
            if needle.is_empty() {
                return out;
            }
            let hay = if *fold {
                scratch.folded.clear();
                scratch.folded.extend(bytes.iter().map(u8::to_ascii_lowercase));
                &scratch.folded[..]
            } else {
                bytes
            };
            let (mut pos, mut line_no, mut line_start) = (0, 1, 0);
            while out.len() < max_matches {
                let Some(hit) = find(hay, needle, pos) else { break };
                line_no += bytes[line_start..hit].iter().filter(|&&b| b == b'\n').count();
                line_start = bytes[..hit].iter().rposition(|&b| b == b'\n').map_or(0, |p| p + 1);
                let line_end = bytes[hit..].iter().position(|&b| b == b'\n').map_or(bytes.len(), |p| hit + p);
                let mut ranges = Vec::new();
                let mut at = hit;
                while at + needle.len() <= line_end {
                    ranges.push((at - line_start, at - line_start + needle.len()));
                    match find(&hay[..line_end], needle, at + needle.len()) {
                        Some(next) => at = next,
                        None => break,
                    }
                }
                out.push(line_match(line_no, &bytes[line_start..line_end], ranges));
                pos = line_end + 1;
                if pos >= bytes.len() {
                    break;
                }
            }
            if scratch.folded.capacity() > KEEP_BUFFER {
                scratch.folded = Vec::new();
            }
        }
        Matcher::Regex(re) => {
            let cache = scratch.cache.get_or_insert_with(|| re.cache());
            for (i, line) in bytes.split(|&b| b == b'\n').enumerate() {
                let line = line.strip_suffix(b"\r").unwrap_or(line);
                let text = String::from_utf8_lossy(line);
                let ranges = re.find_iter(cache, &text);
                if !ranges.is_empty() {
                    out.push(line_match(i + 1, line, ranges));
                    if out.len() >= max_matches {
                        break;
                    }
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn plain_and_regex_lines() {
        let text = b"Hello world\nsay hello hello\r\nnothing\n";
        let (m, _) = matcher("hello", false, true);
        let hits = search(&m, text, 10, &mut m.scratch());
        assert_eq!(hits.len(), 2);
        assert_eq!((hits[0].line_number, hits[0].ranges.clone()), (1, vec![(0, 5)]));
        assert_eq!((hits[1].line_number, hits[1].content.as_str()), (2, "say hello hello"));
        assert_eq!(hits[1].ranges, vec![(4, 9), (10, 15)]);
        let (m, _) = matcher("Hello", false, true);
        assert_eq!(search(&m, text, 10, &mut m.scratch()).len(), 1);
        let (m, err) = matcher("wor(ld", true, false);
        assert!(err.is_some() && search(&m, text, 10, &mut m.scratch()).is_empty());
        let (m, _) = matcher(r"h\w+o", true, false);
        assert_eq!(search(&m, text, 1, &mut m.scratch()).len(), 1);
        assert!(is_binary(b"ab\0c"));
    }
}

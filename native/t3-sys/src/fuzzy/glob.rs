//! Gitignore-style globs: `*` stays in one segment, `**/` spans folders, `?`, `[a-z]`, `[!x]`,
//! `\` escapes, and `{a,b}` alternatives (expanded up front).

/// Expands `{a,b}` alternatives, nested ones included.
pub fn expand_braces(pat: &str) -> Vec<String> {
    let b = pat.as_bytes();
    let mut depth = 0;
    let mut open = None;
    let mut commas = Vec::new();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 1,
            b'{' => {
                if depth == 0 {
                    open = Some(i);
                    commas.clear();
                }
                depth += 1;
            }
            b',' if depth == 1 => commas.push(i),
            b'}' if depth > 0 => {
                depth -= 1;
                if depth == 0 && !commas.is_empty() {
                    let start = open.unwrap_or(0);
                    let (head, tail) = (&pat[..start], &pat[i + 1..]);
                    let mut bounds = vec![start];
                    bounds.extend(&commas);
                    bounds.push(i);
                    return bounds
                        .windows(2)
                        .flat_map(|w| expand_braces(&format!("{head}{}{tail}", &pat[w[0] + 1..w[1]])))
                        .collect();
                }
            }
            _ => {}
        }
        i += 1;
    }
    vec![pat.to_owned()]
}

fn eq(a: u8, b: u8, ci: bool) -> bool {
    a == b || (ci && a.eq_ignore_ascii_case(&b))
}

/// Parses `[...]` at the start of `p`; returns whether `c` matches and the class length.
fn class(p: &[u8], c: u8, ci: bool) -> Option<(bool, usize)> {
    let mut i = 1;
    let negated = matches!(p.get(1), Some(b'!' | b'^'));
    if negated {
        i += 1;
    }
    let mut hit = false;
    let mut first = true;
    while i < p.len() && (p[i] != b']' || first) {
        first = false;
        let mut lo = p[i];
        if lo == b'\\' && i + 1 < p.len() {
            i += 1;
            lo = p[i];
        }
        if p.get(i + 1) == Some(&b'-') && p.get(i + 2).is_some_and(|&h| h != b']') {
            let hi = p[i + 2];
            let lc = c.to_ascii_lowercase();
            let uc = c.to_ascii_uppercase();
            hit |= (lo..=hi).contains(&c) || (ci && ((lo..=hi).contains(&lc) || (lo..=hi).contains(&uc)));
            i += 3;
        } else {
            hit |= eq(lo, c, ci);
            i += 1;
        }
    }
    (i < p.len()).then_some((hit != negated, i + 1))
}

/// Matches one brace-free pattern against a `/`-separated path.
pub fn matches(p: &[u8], t: &[u8], ci: bool) -> bool {
    if p.is_empty() {
        return t.is_empty();
    }
    if p.starts_with(b"**") {
        let rest = &p[2..];
        if let Some(after) = rest.strip_prefix(b"/") {
            return matches(after, t, ci)
                || t.iter().enumerate().any(|(i, &c)| c == b'/' && matches(after, &t[i + 1..], ci));
        }
        return (0..=t.len()).any(|i| matches(rest, &t[i..], ci));
    }
    match p[0] {
        b'*' => {
            let mut i = 0;
            loop {
                if matches(&p[1..], &t[i..], ci) {
                    return true;
                }
                if i >= t.len() || t[i] == b'/' {
                    return false;
                }
                i += 1;
            }
        }
        b'?' => !t.is_empty() && t[0] != b'/' && matches(&p[1..], &t[1..], ci),
        b'[' => match (t.first(), class(p, *t.first().unwrap_or(&0), ci)) {
            (Some(&c), Some((hit, len))) => c != b'/' && hit && matches(&p[len..], &t[1..], ci),
            (Some(&c), None) => eq(b'[', c, ci) && matches(&p[1..], &t[1..], ci),
            (None, _) => false,
        },
        b'\\' if p.len() > 1 => !t.is_empty() && eq(p[1], t[0], ci) && matches(&p[2..], &t[1..], ci),
        c => !t.is_empty() && eq(c, t[0], ci) && matches(&p[1..], &t[1..], ci),
    }
}

pub fn has_glob_chars(s: &str) -> bool {
    s.contains(['*', '?', '[', '{'])
}

/// A compiled glob: every brace alternative of one pattern.
#[derive(Debug, Clone)]
pub struct Glob {
    alternatives: Vec<Vec<u8>>,
    /// Without a `/`, a glob may match the file name alone.
    pub basename: bool,
}

impl Glob {
    pub fn new(pat: &str) -> Glob {
        Glob { alternatives: expand_braces(pat).into_iter().map(String::into_bytes).collect(), basename: !pat.contains('/') }
    }
    pub fn is_match(&self, path: &str, ci: bool) -> bool {
        let name = path.rsplit('/').next().unwrap_or(path);
        self.alternatives.iter().any(|alt| {
            matches(alt, path.as_bytes(), ci) || (self.basename && matches(alt, name.as_bytes(), ci))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn glob_semantics() {
        let m = |p: &str, t: &str| Glob::new(p).is_match(t, false);
        assert!(m("*.ts", "src/a.ts"));
        assert!(!m("src/*.ts", "src/x/a.ts"));
        assert!(m("src/**/*.ts", "src/x/y/a.ts"));
        assert!(m("src/**/*.ts", "src/a.ts"));
        assert!(m("**/*.{png,jp[eE]g}", "a/b.jpEg"));
        assert!(!m("**/*.{png,jpg}", "a/b.gif"));
        assert!(m("a?c", "abc") && !m("a?c", "a/c"));
        assert!(m("[!x]y", "ay") && !m("[!x]y", "xy"));
        assert!(Glob::new("**/*.[pP][nN][gG]").is_match("Icon.PNG", false));
        assert_eq!(expand_braces("a{b,c{d,e}}f"), vec!["abf", "acdf", "acef"]);
    }
}

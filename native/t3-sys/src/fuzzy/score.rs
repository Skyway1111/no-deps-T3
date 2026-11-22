//! fzy's fuzzy scorer: dynamic programming over gaps and consecutive runs, with bonuses for
//! matches after `/`, word separators, dots and camelCase humps.

const GAP_LEADING: f64 = -0.005;
const GAP_TRAILING: f64 = -0.005;
const GAP_INNER: f64 = -0.01;
const CONSECUTIVE: f64 = 1.0;
const MAX_LEN: usize = 1024;

fn bonus(prev: u8, cur: u8) -> f64 {
    match prev {
        b'/' => 0.9,
        b'-' | b'_' | b' ' => 0.8,
        b'.' => 0.6,
        p if p.is_ascii_lowercase() && cur.is_ascii_uppercase() => 0.7,
        _ => 0.0,
    }
}

/// Whether every byte of the lowercase `needle` appears in order in `hay`, ignoring ASCII case.
pub fn is_subsequence(needle: &[u8], hay: &[u8]) -> bool {
    let mut n = needle.iter().peekable();
    for &h in hay {
        if n.peek().is_some_and(|&&c| c == h.to_ascii_lowercase()) {
            n.next();
        }
    }
    n.peek().is_none()
}

/// Scores a lowercase `needle` against `hay`; callers check `is_subsequence` first.
pub fn score(needle: &[u8], hay: &[u8]) -> f64 {
    let (n, m) = (needle.len(), hay.len());
    if n == 0 || m > MAX_LEN || n > m {
        return 0.0;
    }
    if n == m {
        return f64::INFINITY;
    }
    let mut bonuses = vec![0.0; m];
    let mut prev = b'/';
    for (i, &c) in hay.iter().enumerate() {
        bonuses[i] = bonus(prev, c);
        prev = c;
    }
    let lower: Vec<u8> = hay.iter().map(u8::to_ascii_lowercase).collect();
    let mut d_prev = vec![f64::NEG_INFINITY; m];
    let mut m_prev = vec![f64::NEG_INFINITY; m];
    let mut d_cur = vec![f64::NEG_INFINITY; m];
    let mut m_cur = vec![f64::NEG_INFINITY; m];
    for (i, &nc) in needle.iter().enumerate() {
        let mut prev_score = f64::NEG_INFINITY;
        let gap = if i == n - 1 { GAP_TRAILING } else { GAP_INNER };
        for j in 0..m {
            if lower[j] == nc {
                let s = if i == 0 {
                    j as f64 * GAP_LEADING + bonuses[j]
                } else if j > 0 {
                    (m_prev[j - 1] + bonuses[j]).max(d_prev[j - 1] + CONSECUTIVE)
                } else {
                    f64::NEG_INFINITY
                };
                d_cur[j] = s;
                prev_score = s.max(prev_score + gap);
            } else {
                d_cur[j] = f64::NEG_INFINITY;
                prev_score += gap;
            }
            m_cur[j] = prev_score;
        }
        std::mem::swap(&mut d_prev, &mut d_cur);
        std::mem::swap(&mut m_prev, &mut m_cur);
    }
    m_prev[m - 1]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prefers_boundaries_and_runs() {
        assert!(is_subsequence(b"wsi", b"WorkspaceSearchIndex.ts"));
        assert!(!is_subsequence(b"xyz", b"abc"));
        assert!(score(b"wsi", b"src/WorkspaceSearchIndex.ts") > score(b"wsi", b"src/awsome-index.ts"));
        assert!(score(b"main", b"src/main.rs") > score(b"main", b"src/m_a_i_n.rs"));
        assert_eq!(score(b"abc", b"ABC"), f64::INFINITY);
    }
}

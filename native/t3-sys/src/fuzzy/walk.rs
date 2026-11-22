//! Parallel workspace walk honoring `.gitignore` and `.ignore` files the way git does: the
//! deepest file with a matching rule decides, the last matching rule in it wins, and an
//! ignored folder is never entered. `.git` folders and symlinks are skipped.

use super::glob;
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: u64,
}

#[derive(Debug)]
struct Rule {
    globs: Vec<Vec<u8>>,
    negate: bool,
    dir_only: bool,
    anchored: bool,
}

#[derive(Debug, Default)]
pub struct IgnoreFile {
    rules: Vec<Rule>,
}

impl IgnoreFile {
    pub fn parse(text: &str) -> IgnoreFile {
        let mut rules = Vec::new();
        for raw in text.lines() {
            let mut line = raw.trim_end_matches('\r');
            if !line.ends_with("\\ ") {
                line = line.trim_end();
            }
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let negate = line.starts_with('!');
            let mut pat = if negate { &line[1..] } else { line };
            if let Some(rest) = pat.strip_prefix('\\') {
                pat = rest;
            }
            let dir_only = pat.ends_with('/');
            let pat = pat.trim_end_matches('/');
            let anchored = pat.contains('/');
            let pat = pat.trim_start_matches('/');
            if pat.is_empty() {
                continue;
            }
            rules.push(Rule { globs: vec![pat.as_bytes().to_vec()], negate, dir_only, anchored });
        }
        IgnoreFile { rules }
    }

    /// `Some(true)` when ignored, `Some(false)` when re-included, `None` when no rule matches.
    pub fn decide(&self, rel: &str, is_dir: bool) -> Option<bool> {
        let name = rel.rsplit('/').next().unwrap_or(rel);
        self.rules.iter().rev().find_map(|rule| {
            if rule.dir_only && !is_dir {
                return None;
            }
            let target = if rule.anchored { rel } else { name };
            rule.globs
                .iter()
                .any(|g| glob::matches(g, target.as_bytes(), false))
                .then_some(!rule.negate)
        })
    }
}

/// Ignore files from the root down to one folder, deepest last.
#[derive(Default)]
pub struct IgnoreStack {
    files: Vec<(String, Arc<IgnoreFile>)>,
}

impl IgnoreStack {
    fn with(&self, dir: &str, file: IgnoreFile) -> IgnoreStack {
        let mut files = self.files.clone();
        files.push((dir.to_owned(), Arc::new(file)));
        IgnoreStack { files }
    }
    pub fn is_ignored(&self, path: &str, is_dir: bool) -> bool {
        self.files
            .iter()
            .rev()
            .find_map(|(dir, file)| {
                let rel = if dir.is_empty() { path } else { path.strip_prefix(dir.as_str())?.strip_prefix('/')? };
                file.decide(rel, is_dir)
            })
            .unwrap_or(false)
    }
}

fn read_ignores(abs: &Path) -> Option<IgnoreFile> {
    let mut text = String::new();
    for name in [".gitignore", ".ignore"] {
        if let Ok(t) = std::fs::read_to_string(abs.join(name)) {
            text.push_str(&t);
            text.push('\n');
        }
    }
    (!text.is_empty()).then(|| IgnoreFile::parse(&text))
}

fn mtime(meta: &std::fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs())
}

fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() { name.to_owned() } else { format!("{dir}/{name}") }
}

struct Queue {
    jobs: Vec<(String, Arc<IgnoreStack>)>,
    active: usize,
}

/// Walks `root` with one worker per core; entries come back sorted by path.
pub fn walk(root: &Path) -> Vec<Entry> {
    let base = Arc::new(IgnoreStack::default());
    let state = Mutex::new(Queue { jobs: vec![(String::new(), base)], active: 0 });
    let ready = Condvar::new();
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(16);
    let mut all: Vec<Entry> = std::thread::scope(|s| {
        let workers: Vec<_> = (0..threads)
            .map(|_| {
                s.spawn(|| {
                    let mut out = Vec::new();
                    loop {
                        let job = {
                            let mut q = state.lock().unwrap_or_else(|e| e.into_inner());
                            loop {
                                if let Some(job) = q.jobs.pop() {
                                    q.active += 1;
                                    break Some(job);
                                }
                                if q.active == 0 {
                                    break None;
                                }
                                q = ready.wait(q).unwrap_or_else(|e| e.into_inner());
                            }
                        };
                        let Some((dir, stack)) = job else {
                            ready.notify_all();
                            return out;
                        };
                        let children = scan_dir(root, &dir, &stack, &mut out);
                        let mut q = state.lock().unwrap_or_else(|e| e.into_inner());
                        q.jobs.extend(children);
                        q.active -= 1;
                        ready.notify_all();
                    }
                })
            })
            .collect();
        workers.into_iter().flat_map(|w| w.join().unwrap_or_default()).collect()
    });
    all.sort_unstable_by(|a, b| a.path.cmp(&b.path));
    all
}

fn scan_dir(root: &Path, dir: &str, stack: &Arc<IgnoreStack>, out: &mut Vec<Entry>) -> Vec<(String, Arc<IgnoreStack>)> {
    let abs = root.join(dir);
    let Ok(read) = std::fs::read_dir(&abs) else { return Vec::new() };
    let stack = match read_ignores(&abs) {
        Some(file) => Arc::new(stack.with(dir, file)),
        None => stack.clone(),
    };
    let mut children = Vec::new();
    for entry in read.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        let Ok(name) = entry.file_name().into_string() else { continue };
        if kind.is_symlink() || name == ".git" {
            continue;
        }
        let path = join(dir, &name);
        let is_dir = kind.is_dir();
        if stack.is_ignored(&path, is_dir) {
            continue;
        }
        let meta = entry.metadata().ok();
        out.push(Entry {
            size: if is_dir { 0 } else { meta.as_ref().map_or(0, |m| m.len()) },
            mtime: meta.as_ref().map_or(0, mtime),
            path: path.clone(),
            is_dir,
        });
        if is_dir {
            children.push((path, stack.clone()));
        }
    }
    children
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gitignore_rules() {
        let f = IgnoreFile::parse("node_modules/\n*.log\n!keep.log\n/build\ndocs/**/*.tmp\n");
        assert_eq!(f.decide("node_modules", true), Some(true));
        assert_eq!(f.decide("node_modules", false), None);
        assert_eq!(f.decide("a/b.log", false), Some(true));
        assert_eq!(f.decide("a/keep.log", false), Some(false));
        assert_eq!(f.decide("build", true), Some(true));
        assert_eq!(f.decide("docs/x/y.tmp", false), Some(true));
    }

    #[test]
    fn walks_and_ignores() {
        let root = std::env::temp_dir().join(format!("t3-sys-walk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for p in ["src/deep", "node_modules/x", ".git", "sub"] {
            std::fs::create_dir_all(root.join(p)).unwrap();
        }
        for (p, c) in [
            (".gitignore", "node_modules\n*.log\n"),
            ("src/a.ts", ""),
            ("src/deep/b.ts", ""),
            ("node_modules/x/i.js", ""),
            ("x.log", ""),
            ("sub/.gitignore", "!*.log\n"),
            ("sub/y.log", ""),
        ] {
            std::fs::write(root.join(p), c).unwrap();
        }
        let paths: Vec<_> = walk(&root).into_iter().map(|e| e.path).collect();
        assert_eq!(paths, [".gitignore", "src", "src/a.ts", "src/deep", "src/deep/b.ts", "sub", "sub/.gitignore", "sub/y.log"]);
        let _ = std::fs::remove_dir_all(&root);
    }
}

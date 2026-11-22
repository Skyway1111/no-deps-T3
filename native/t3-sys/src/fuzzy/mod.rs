//! `t3-sys fuzzy serve ROOT`: a workspace path index answering JSON-line requests on stdin
//! (`{"id","method","params"}` → `{"id","ok","value"|"error"}`), with `{"event":"watch"}`
//! pushes once watched. It scans in the background, rescans when the tree changes, and keeps
//! answering from the previous index meanwhile.

pub mod glob;
pub mod grep;
pub mod regex;
pub mod score;
pub mod walk;
pub mod watch;

use crate::json::{self, Value, obj};
use glob::Glob;
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::{Duration, Instant};
use walk::Entry;

#[derive(Default)]
pub struct Index {
    pub entries: Vec<Entry>,
    pub files: usize,
}

impl Index {
    pub fn new(entries: Vec<Entry>) -> Index {
        let files = entries.iter().filter(|e| !e.is_dir).count();
        Index { entries, files }
    }
}

#[derive(Clone, Copy, PartialEq)]
pub enum Kind {
    File,
    Dir,
    Mixed,
}

/// A `folder/` word: matches when some segment run of the entry's folder starts with it.
#[derive(Debug)]
struct Folder {
    /// `name` + `/`
    prefix: String,
    name: String,
    /// `/name/`
    inner: String,
    /// `/name`
    tail: String,
}

impl Folder {
    /// Whether `base + "/"` starts with `prefix` or contains `/prefix`.
    fn matches(&self, base: &str) -> bool {
        base.starts_with(&self.prefix) || base == self.name || base.contains(&self.inner) || base.ends_with(&self.tail)
    }
}

#[derive(Default, Debug)]
pub struct Query {
    fuzzy: Vec<Vec<u8>>,
    globs: Vec<Glob>,
    extensions: Vec<Glob>,
    excludes: Vec<Glob>,
    excluded_words: Vec<String>,
    prefixes: Vec<String>,
    folders: Vec<Folder>,
    /// Some word was a glob only for braces without alternatives, like `foo{bar}.ts`.
    brace_words: bool,
}

fn strip_location(token: &str) -> &str {
    let mut t = token;
    for _ in 0..2 {
        if let Some((head, tail)) = t.rsplit_once(':')
            && !head.is_empty()
            && !tail.is_empty()
            && tail.bytes().all(|b| b.is_ascii_digit())
        {
            t = head;
        }
    }
    t
}


impl Query {
    /// Words are fuzzy terms except: globs (bare `*.ext` ones OR together), `!x` exclusions,
    /// `/x` root prefixes, `x/` folder names, and a trailing `:line[:col]`.
    pub fn parse(input: &str) -> Query {
        Query::parse_with(input, false)
    }

    /// `*`, `?` and `{` make a word a glob; `[` alone does not, so `[id].tsx` stays literal while
    /// `*.[jt]s` works. With `literal_braces`, words whose braces have no alternatives are literal.
    pub fn parse_with(input: &str, literal_braces: bool) -> Query {
        let mut q = Query::default();
        for raw in input.split_whitespace() {
            let token = strip_location(raw);
            let neg = token.strip_prefix('!').filter(|n| !n.is_empty());
            let word = neg.unwrap_or(token);
            let literal = word.contains('{') && glob::expand_braces(word).len() == 1;
            q.brace_words |= literal;
            let glob = word.contains(['*', '?']) || (word.contains('{') && !(literal_braces && literal));
            if let Some(neg) = neg {
                if glob {
                    q.excludes.push(Glob::new(neg));
                } else {
                    q.excluded_words.push(neg.to_lowercase());
                }
            } else if glob {
                let ext = token.strip_prefix("*.").is_some_and(|e| !e.is_empty() && !glob::has_glob_chars(e) && !e.contains('/'));
                if ext { q.extensions.push(Glob::new(token)) } else { q.globs.push(Glob::new(token)) }
            } else if let Some(prefix) = token.strip_prefix('/').filter(|p| !p.is_empty()) {
                q.prefixes.push(prefix.trim_end_matches('/').to_lowercase());
            } else if token.len() > 1 && token.ends_with('/') {
                let name = token[..token.len() - 1].to_lowercase();
                q.folders.push(Folder { prefix: format!("{name}/"), inner: format!("/{name}/"), tail: format!("/{name}"), name });
            } else if !token.is_empty() {
                q.fuzzy.push(token.to_lowercase().into_bytes());
            }
        }
        q
    }

    fn accepts(&self, e: &Entry) -> bool {
        let ext_ok = self.extensions.is_empty() || (!e.is_dir && self.extensions.iter().any(|g| g.is_match(&e.path, true)));
        if !(ext_ok && self.globs.iter().all(|g| g.is_match(&e.path, false)) && !self.excludes.iter().any(|g| g.is_match(&e.path, false))) {
            return false;
        }
        if self.excluded_words.is_empty() && self.prefixes.is_empty() && self.folders.is_empty() {
            return true;
        }
        let lower = e.path.to_lowercase();
        let folder = if e.is_dir { Some(lower.as_str()) } else { lower.rsplit_once('/').map(|(d, _)| d) };
        !self.excluded_words.iter().any(|w| lower.contains(w.as_str()))
            && self.prefixes.iter().all(|p| lower.starts_with(p.as_str()))
            && self.folders.iter().all(|f| folder.is_some_and(|d| f.matches(d)))
    }

    fn score(&self, e: &Entry, scratch: &mut score::Scratch) -> Option<f64> {
        let path = e.path.as_bytes();
        let name_len = e.path.rsplit('/').next().unwrap_or(&e.path).len();
        let mut total = 0.0;
        for (i, term) in self.fuzzy.iter().enumerate() {
            if !score::is_subsequence(term, path) {
                return None;
            }
            if i == 0 {
                scratch.load(path);
            }
            let mut s = scratch.score(term, path.len());
            if score::is_subsequence(term, &path[path.len() - name_len..]) {
                s = s.max(scratch.score(term, name_len) + 1.0);
            }
            total += s;
        }
        Some(total)
    }
}

/// Matches `kind` entries against `query`; returns the page and the match total.
pub fn search<'a>(index: &'a Index, query: &Query, kind: Kind, offset: usize, size: usize) -> (Vec<&'a Entry>, usize) {
    let wanted = |e: &Entry| match kind {
        Kind::File => !e.is_dir,
        Kind::Dir => e.is_dir,
        Kind::Mixed => true,
    };
    let matches = |part: &'a [Entry]| {
        let mut scratch = score::Scratch::default();
        part.iter().filter(|e| wanted(e) && query.accepts(e)).filter_map(|e| Some((query.score(e, &mut scratch)?, e))).collect::<Vec<_>>()
    };
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(16);
    let chunk = index.entries.len().div_ceil(threads).max(1024);
    let mut scored: Vec<(f64, &Entry)> = if index.entries.len() <= chunk {
        matches(&index.entries)
    } else {
        std::thread::scope(|s| {
            let parts: Vec<_> = index.entries.chunks(chunk).map(|part| s.spawn(move || matches(part))).collect();
            parts.into_iter().flat_map(|p| p.join().unwrap_or_default()).collect()
        })
    };
    let cmp: fn(&(f64, &Entry), &(f64, &Entry)) -> std::cmp::Ordering = if query.fuzzy.is_empty() {
        // No terms: recently modified files first, folders in path order.
        |(_, a), (_, b)| a.is_dir.cmp(&b.is_dir).then(if a.is_dir { a.path.cmp(&b.path) } else { b.mtime.cmp(&a.mtime).then(a.path.cmp(&b.path)) })
    } else {
        |(sa, a), (sb, b)| sb.total_cmp(sa).then(a.path.len().cmp(&b.path.len())).then(a.path.cmp(&b.path))
    };
    let total = scored.len();
    let end = offset.saturating_add(size).min(total);
    if end < total {
        scored.select_nth_unstable_by(end, cmp);
        scored.truncate(end);
    }
    scored.sort_unstable_by(cmp);
    (scored.into_iter().skip(offset).map(|(_, e)| e).collect(), total)
}

/// Searches `input`; when braces without alternatives made it match nothing, as in
/// `foo{bar}.ts`, searches again reading those words literally.
pub fn find<'a>(index: &'a Index, input: &str, kind: Kind, offset: usize, size: usize) -> (Vec<&'a Entry>, usize) {
    let query = Query::parse(input);
    let found = search(index, &query, kind, offset, size);
    if found.1 == 0 && query.brace_words { search(index, &Query::parse_with(input, true), kind, offset, size) } else { found }
}

fn name_of(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn file_json(e: &Entry) -> Value {
    obj([("relativePath", e.path.as_str().into()), ("fileName", name_of(&e.path).into()), ("size", e.size.into()), ("modified", e.mtime.into())])
}

fn dir_json(e: &Entry) -> Value {
    obj([("relativePath", e.path.as_str().into()), ("dirName", name_of(&e.path).into())])
}

/// Events between two sorted indexes: created, removed, and files whose size or mtime changed.
pub fn diff(root: &Path, old: &[Entry], new: &[Entry]) -> Vec<Value> {
    let (mut i, mut j, mut out) = (0, 0, Vec::new());
    let event = |kind: &str, e: &Entry| obj([("kind", kind.into()), ("path", root.join(&e.path).to_string_lossy().into_owned().into())]);
    while i < old.len() || j < new.len() {
        match (old.get(i), new.get(j)) {
            (Some(a), Some(b)) if a.path == b.path => {
                if !a.is_dir && (a.mtime != b.mtime || a.size != b.size) || a.is_dir != b.is_dir {
                    out.push(event("modified", b));
                }
                i += 1;
                j += 1;
            }
            (Some(a), Some(b)) if a.path < b.path => {
                out.push(event("removed", a));
                i += 1;
            }
            (Some(a), None) => {
                out.push(event("removed", a));
                i += 1;
            }
            (_, Some(b)) => {
                out.push(event("created", b));
                j += 1;
            }
            (None, None) => break,
        }
    }
    out
}

#[derive(Default)]
struct Scan {
    scanning: bool,
    rerun: bool,
    done_once: bool,
    last_duration: Duration,
}

struct Daemon {
    root: PathBuf,
    index: RwLock<Arc<Index>>,
    scan: Mutex<Scan>,
    scanned: Condvar,
    watching: AtomicBool,
    watcher: Mutex<Option<watch::Watcher>>,
    dirty: (Mutex<bool>, Condvar),
    out: Mutex<std::io::Stdout>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Daemon {
    fn send(&self, v: &Value) {
        let mut out = lock(&self.out);
        let _ = writeln!(out, "{v}");
        let _ = out.flush();
    }

    fn current(&self) -> Arc<Index> {
        self.index.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Runs a scan unless one is running, in which case that one runs again when done.
    fn rescan(self: &Arc<Self>) {
        {
            let mut scan = lock(&self.scan);
            if scan.scanning {
                scan.rerun = true;
                return;
            }
            scan.scanning = true;
        }
        loop {
            let started = Instant::now();
            let entries = walk::walk(&self.root);
            let old = self.current();
            if let Some(w) = lock(&self.watcher).as_ref() {
                w.watch_dirs(&self.root, entries.iter().filter(|e| e.is_dir).map(|e| e.path.as_str()));
            }
            let events = if self.watching.load(Ordering::SeqCst) { diff(&self.root, &old.entries, &entries) } else { Vec::new() };
            *self.index.write().unwrap_or_else(|e| e.into_inner()) = Arc::new(Index::new(entries));
            if !events.is_empty() {
                self.send(&obj([("event", "watch".into()), ("events", Value::Arr(events))]));
            }
            let mut scan = lock(&self.scan);
            scan.done_once = true;
            scan.last_duration = started.elapsed();
            if !std::mem::take(&mut scan.rerun) {
                scan.scanning = false;
                self.scanned.notify_all();
                return;
            }
        }
    }

    fn wait_ready(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut scan = lock(&self.scan);
        while scan.scanning || !scan.done_once {
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            scan = self.scanned.wait_timeout(scan, deadline - now).unwrap_or_else(|e| e.into_inner()).0;
        }
        true
    }

    /// Coalesces change bursts; waits a few scan lengths between rescans so churn stays cheap.
    fn rescan_loop(self: Arc<Self>) {
        loop {
            {
                let (flag, cv) = &self.dirty;
                let mut dirty = lock(flag);
                while !*dirty {
                    dirty = cv.wait(dirty).unwrap_or_else(|e| e.into_inner());
                }
            }
            let pause = (lock(&self.scan).last_duration * 4).clamp(Duration::from_millis(100), Duration::from_secs(5));
            std::thread::sleep(pause);
            *lock(&self.dirty.0) = false;
            self.rescan();
        }
    }

    fn handle(self: &Arc<Self>, method: &str, p: &Value) -> Result<Value, String> {
        let num = |k: &str, d: f64| p.get_num(k).unwrap_or(d).max(0.0) as usize;
        match method {
            "scanProgress" => {
                let scan = lock(&self.scan);
                let ready = !scan.scanning && scan.done_once;
                Ok(obj([
                    ("isScanning", (!ready).into()),
                    ("isWarmupComplete", ready.into()),
                    ("scannedFilesCount", self.current().files.into()),
                ]))
            }
            "waitForIndexReady" => Ok(self.wait_ready(Duration::from_millis(num("timeoutMs", 15_000.0) as u64)).into()),
            "scanFiles" => {
                let me = self.clone();
                std::thread::spawn(move || me.rescan());
                Ok(Value::Null)
            }
            "watch" => {
                self.watching.store(true, Ordering::SeqCst);
                Ok(lock(&self.watcher).is_some().into())
            }
            "unwatch" => {
                self.watching.store(false, Ordering::SeqCst);
                Ok(Value::Null)
            }
            "fileSearch" | "directorySearch" | "mixedSearch" => {
                let index = self.current();
                let kind = match method {
                    "fileSearch" => Kind::File,
                    "directorySearch" => Kind::Dir,
                    _ => Kind::Mixed,
                };
                let (items, total) = find(&index, p.get_str("query").unwrap_or(""), kind, num("pageIndex", 0.0), num("pageSize", 100.0));
                let items = items
                    .into_iter()
                    .map(|e| match kind {
                        Kind::File => file_json(e),
                        Kind::Dir => dir_json(e),
                        Kind::Mixed if e.is_dir => obj([("type", "directory".into()), ("item", dir_json(e))]),
                        Kind::Mixed => obj([("type", "file".into()), ("item", file_json(e))]),
                    })
                    .collect();
                let dirs = index.entries.len() - index.files;
                Ok(obj([
                    ("items", Value::Arr(items)),
                    ("scores", Value::Arr(Vec::new())),
                    ("totalMatched", total.into()),
                    ("totalFiles", index.files.into()),
                    ("totalDirs", dirs.into()),
                ]))
            }
            "listDirs" => Ok(Value::Arr(self.current().entries.iter().filter(|e| e.is_dir).map(|e| e.path.as_str().into()).collect())),
            "grep" => Ok(self.grep(p)),
            other => Err(format!("unknown method {other}")),
        }
    }

    fn grep(&self, p: &Value) -> Value {
        let index = self.current();
        let regex = p.get_str("mode") == Some("regex");
        let raw = p.get_str("query").unwrap_or("");
        // Plain searches read glob words as file constraints: `*.ts needle` greps `.ts` files.
        let words: Vec<&str> = raw.split_whitespace().collect();
        let (globs, rest): (Vec<&str>, Vec<&str>) = words.iter().partition(|w| w.contains(['*', '?']));
        let (needle, filter) =
            if regex || globs.is_empty() || rest.is_empty() { (raw.to_owned(), None) } else { (rest.join(" "), Some(Query::parse(&globs.join(" ")))) };
        let (matcher, fallback) = grep::matcher(&needle, regex, p.get_bool("smartCase").unwrap_or(true));
        let per_file = p.get_num("maxMatchesPerFile").unwrap_or(100.0).max(1.0) as usize;
        let page = p.get_num("pageSize").unwrap_or(50.0).max(1.0) as usize;
        let budget = Duration::from_millis(p.get_num("timeBudgetMs").unwrap_or(1000.0).max(1.0) as u64);
        let mut file = p.get("cursor").and_then(|c| c.get_num("file")).unwrap_or(0.0) as usize;
        let files: Vec<&Entry> =
            index.entries.iter().filter(|e| !e.is_dir && e.size <= grep::FILE_MAX && filter.as_ref().is_none_or(|f| f.accepts(e))).collect();
        let started = Instant::now();
        let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(16);
        let (mut items, mut searched) = (Vec::new(), 0);
        let next = AtomicUsize::new(file);
        let stop = AtomicBool::new(false);
        // Workers search ahead in parallel; results are taken in file order so a page ends on a
        // file boundary and the cursor is exact. Work past the cut is dropped.
        std::thread::scope(|s| {
            let (tx, rx) = mpsc::sync_channel::<(usize, Vec<grep::LineMatch>)>(threads * 64);
            for _ in 0..threads {
                let (tx, files, next, stop, matcher, root) = (tx.clone(), &files, &next, &stop, &matcher, &self.root);
                s.spawn(move || {
                    let (mut scratch, mut buf) = (matcher.scratch(), Vec::new());
                    while !stop.load(Ordering::Relaxed) {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        let Some(entry) = files.get(i) else { break };
                        buf.clear();
                        let read = std::fs::File::open(root.join(&entry.path)).and_then(|mut f| f.read_to_end(&mut buf));
                        let matches =
                            if read.is_ok() && !grep::is_binary(&buf) { grep::search(matcher, &buf, per_file, &mut scratch) } else { Vec::new() };
                        if buf.capacity() > grep::KEEP_BUFFER {
                            buf = Vec::new();
                        }
                        if tx.send((i, matches)).is_err() {
                            break;
                        }
                    }
                });
            }
            drop(tx);
            let mut ready = std::collections::BTreeMap::new();
            for (i, matches) in rx {
                ready.insert(i, matches);
                while let Some(matches) = ready.remove(&file) {
                    file += 1;
                    searched += 1;
                    for m in matches {
                        let ranges = m.ranges.iter().map(|&(s, e)| Value::Arr(vec![s.into(), e.into()])).collect();
                        items.push(obj([
                            ("relativePath", files[file - 1].path.as_str().into()),
                            ("lineNumber", m.line_number.into()),
                            ("lineContent", m.content.into()),
                            ("matchRanges", Value::Arr(ranges)),
                        ]));
                    }
                    if items.len() >= page {
                        break;
                    }
                }
                if items.len() >= page || started.elapsed() >= budget {
                    break;
                }
            }
            stop.store(true, Ordering::Relaxed);
        });
        let mut fields = vec![
            ("items".to_owned(), Value::Arr(items)),
            ("nextCursor".to_owned(), if file < files.len() { obj([("file", file.into())]) } else { Value::Null }),
            ("totalFilesSearched".to_owned(), searched.into()),
            ("totalFiles".to_owned(), files.len().into()),
        ];
        if let Some(error) = fallback {
            fields.push(("regexFallbackError".to_owned(), error.into()));
        }
        Value::Obj(fields)
    }
}

/// glibc otherwise raises its mmap threshold after big frees and keeps file buffers on the heap.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn bound_heap() {
    unsafe extern "C" {
        fn mallopt(param: i32, value: i32) -> i32;
    }
    const M_MMAP_THRESHOLD: i32 = -3;
    const M_ARENA_MAX: i32 = -8;
    unsafe {
        mallopt(M_MMAP_THRESHOLD, grep::KEEP_BUFFER as i32);
        mallopt(M_ARENA_MAX, 2);
    }
}
#[cfg(not(all(target_os = "linux", target_env = "gnu")))]
fn bound_heap() {}

pub fn run(args: &[String]) -> i32 {
    bound_heap();
    let (Some("serve"), Some(root)) = (args.first().map(String::as_str), args.get(1)) else {
        eprintln!("usage: t3-sys fuzzy serve ROOT");
        return 2;
    };
    let root = PathBuf::from(root);
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).and_then(|h| std::fs::canonicalize(h).ok());
    let error = if !root.is_dir() {
        Some(format!("{} is not a directory", root.display()))
    } else if home.is_some() && std::fs::canonicalize(&root).ok() == home {
        Some(format!("{} is the home directory, which is too large to index", root.display()))
    } else {
        None
    };
    if let Some(error) = error {
        println!("{}", obj([("event", "error".into()), ("error", error.into())]));
        return 1;
    }
    let daemon = Arc::new(Daemon {
        root: root.clone(),
        index: RwLock::new(Arc::new(Index::default())),
        scan: Mutex::new(Scan::default()),
        scanned: Condvar::new(),
        watching: AtomicBool::new(false),
        watcher: Mutex::new(None),
        dirty: (Mutex::new(false), Condvar::new()),
        out: Mutex::new(std::io::stdout()),
    });
    let notify = {
        let d = Arc::downgrade(&daemon);
        Arc::new(move || {
            if let Some(d) = d.upgrade() {
                *lock(&d.dirty.0) = true;
                d.dirty.1.notify_one();
            }
        })
    };
    *lock(&daemon.watcher) = watch::Watcher::start(&root, notify);
    {
        let d = daemon.clone();
        std::thread::spawn(move || d.rescan());
        let d = daemon.clone();
        std::thread::spawn(move || d.rescan_loop());
    }
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(req) = json::parse(&line) else { continue };
        let daemon = daemon.clone();
        std::thread::spawn(move || {
            let id = req.get("id").cloned().unwrap_or(Value::Null);
            let method = req.get_str("method").unwrap_or("");
            let params = req.get("params").cloned().unwrap_or(Value::Null);
            let reply = match daemon.handle(method, &params) {
                Ok(value) => obj([("id", id), ("ok", true.into()), ("value", value)]),
                Err(error) => obj([("id", id), ("ok", false.into()), ("error", error.into())]),
            };
            daemon.send(&reply);
        });
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    fn entry(path: &str, is_dir: bool, mtime: u64) -> Entry {
        Entry { path: path.into(), is_dir, size: 1, mtime }
    }
    fn paths(index: &Index, q: &str, kind: Kind) -> Vec<String> {
        find(index, q, kind, 0, 10).0.into_iter().map(|e| e.path.clone()).collect()
    }
    #[test]
    fn query_syntax() {
        let index = Index::new(vec![
            entry("src", true, 0),
            entry("src/main.rs", false, 1),
            entry("src/lib.rs", false, 2),
            entry("web/app.tsx", false, 3),
            entry("web/logo.PNG", false, 4),
            entry("docs/main.md", false, 5),
            entry("web/[id].tsx", false, 6),
            entry("web/a{b}.ts", false, 7),
        ]);
        assert_eq!(paths(&index, "main", Kind::File)[0], "src/main.rs");
        assert_eq!(paths(&index, "main *.md", Kind::File), ["docs/main.md"]);
        assert_eq!(paths(&index, "*.rs *.tsx", Kind::File).len(), 4);
        assert_eq!(paths(&index, "**/*.[pP][nN][gG]", Kind::File), ["web/logo.PNG"]);
        assert_eq!(paths(&index, "main !docs", Kind::File), ["src/main.rs"]);
        assert_eq!(paths(&index, "src/", Kind::File).len(), 2);
        assert_eq!(paths(&index, "/web", Kind::File).len(), 4);
        assert_eq!(paths(&index, "main.rs:12:3", Kind::File)[0], "src/main.rs");
        assert_eq!(paths(&index, "", Kind::File)[0], "web/a{b}.ts");
        assert_eq!(paths(&index, "sr", Kind::Dir), ["src"]);
        assert_eq!(paths(&index, "[id].tsx", Kind::File), ["web/[id].tsx"]);
        assert_eq!(paths(&index, "a{b}", Kind::File), ["web/a{b}.ts"]);
        assert_eq!(paths(&index, "*.{tsx,md}", Kind::File).len(), 3);
        assert_eq!(paths(&index, "src/{main}.rs", Kind::File), ["src/main.rs"]);
        assert_eq!(paths(&index, "*.{md}", Kind::File), ["docs/main.md"]);
        for q in ["", "a", "s"] {
            let all = paths(&index, q, Kind::Mixed);
            let page: Vec<_> = find(&index, q, Kind::Mixed, 1, 2).0.into_iter().map(|e| e.path.clone()).collect();
            assert_eq!(page, all[1..3]);
        }
        assert_eq!(search(&index, &Query::parse(""), Kind::Mixed, 2, 2).1, 8);
    }
    #[test]
    fn diffs_indexes() {
        let old = [entry("a", false, 1), entry("b", false, 1)];
        let new = [entry("b", false, 2), entry("c", false, 1)];
        let kinds: Vec<_> = diff(Path::new("/r"), &old, &new).iter().map(|e| e.get_str("kind").unwrap().to_owned()).collect();
        assert_eq!(kinds, ["removed", "modified", "created"]);
    }
}

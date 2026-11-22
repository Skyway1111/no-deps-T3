//! A Pike-VM regex engine (linear time, leftmost-first like Rust's `regex`): literals, `.`,
//! classes with ranges and `\d\w\s`, anchors, `\b`, groups, alternation, greedy and lazy
//! `* + ? {m,n}`, and the `i s m u` flags, scoped or inline (`(?i)`, `(?i-u:...)`).

#[derive(Clone, Copy, Debug)]
struct Flags {
    i: bool,
    s: bool,
    u: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Perl {
    Digit,
    Word,
    Space,
}

#[derive(Clone, Debug)]
enum Item {
    Range(char, char),
    Perl(Perl, bool),
}

#[derive(Clone, Debug)]
struct Class {
    items: Vec<Item>,
    negated: bool,
    i: bool,
    u: bool,
}

#[derive(Clone, Copy, Debug)]
enum Look {
    LineStart,
    LineEnd,
    Word(bool),
    NotWord(bool),
}

#[derive(Clone, Debug)]
enum Node {
    Empty,
    Char(char, Flags),
    Any(bool),
    Class(Class),
    Look(Look),
    Concat(Vec<Node>),
    Alt(Vec<Node>),
    Repeat(Box<Node>, u32, Option<u32>, bool),
}

#[derive(Clone, Debug)]
enum Inst {
    Char(char, Flags),
    Any(bool),
    Class(Box<Class>),
    Look(Look),
    Split(usize, usize),
    Jmp(usize),
    Match,
}

fn perl_match(kind: Perl, c: char, u: bool) -> bool {
    match (kind, u) {
        (Perl::Digit, true) => c.is_numeric(),
        (Perl::Digit, false) => c.is_ascii_digit(),
        (Perl::Word, true) => c.is_alphanumeric() || c == '_',
        (Perl::Word, false) => c.is_ascii_alphanumeric() || c == '_',
        (Perl::Space, true) => c.is_whitespace(),
        (Perl::Space, false) => c.is_ascii_whitespace(),
    }
}

fn fold(c: char, u: bool) -> char {
    if c.is_ascii() || !u {
        return c.to_ascii_lowercase();
    }
    let mut l = c.to_lowercase();
    match (l.next(), l.next()) {
        (Some(x), None) => x,
        _ => c,
    }
}

impl Class {
    fn raw(&self, c: char) -> bool {
        self.items.iter().any(|item| match *item {
            Item::Range(lo, hi) => (lo..=hi).contains(&c),
            Item::Perl(kind, neg) => perl_match(kind, c, self.u) != neg,
        })
    }
    fn is_match(&self, c: char) -> bool {
        let mut hit = self.raw(c);
        if !hit && self.i {
            let lower = fold(c, self.u);
            let upper = if c.is_ascii() || !self.u {
                c.to_ascii_uppercase()
            } else {
                c.to_uppercase().next().unwrap_or(c)
            };
            hit = self.raw(lower) || self.raw(upper);
        }
        hit != self.negated
    }
}

struct Parser<'a> {
    chars: Vec<char>,
    i: usize,
    _src: &'a str,
}

type PResult<T> = Result<T, String>;

impl Parser<'_> {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.i).copied()
    }
    fn next(&mut self) -> PResult<char> {
        let c = self.peek().ok_or("unexpected end of pattern")?;
        self.i += 1;
        Ok(c)
    }
    fn eat(&mut self, c: char) -> bool {
        if self.peek() == Some(c) {
            self.i += 1;
            true
        } else {
            false
        }
    }

    fn alternation(&mut self, flags: &mut Flags) -> PResult<Node> {
        let mut alts = vec![self.concat(flags)?];
        while self.eat('|') {
            alts.push(self.concat(flags)?);
        }
        Ok(if alts.len() == 1 { alts.pop().unwrap_or(Node::Empty) } else { Node::Alt(alts) })
    }

    fn concat(&mut self, flags: &mut Flags) -> PResult<Node> {
        let mut items = Vec::new();
        while let Some(c) = self.peek() {
            if c == '|' || c == ')' {
                break;
            }
            let atom = self.atom(flags)?;
            let atom = self.repeat(atom)?;
            items.push(atom);
        }
        Ok(Node::Concat(items))
    }

    fn number(&mut self) -> Option<u32> {
        let start = self.i;
        while self.peek().is_some_and(|c| c.is_ascii_digit()) {
            self.i += 1;
        }
        self.chars[start..self.i].iter().collect::<String>().parse().ok()
    }

    fn repeat(&mut self, mut atom: Node) -> PResult<Node> {
        loop {
            let (min, max) = match self.peek() {
                Some('*') => (0, None),
                Some('+') => (1, None),
                Some('?') => (0, Some(1)),
                Some('{') => {
                    let save = self.i;
                    self.i += 1;
                    let Some(min) = self.number() else {
                        self.i = save;
                        return Ok(atom);
                    };
                    let max = if self.eat(',') { self.number() } else { Some(min) };
                    if !self.eat('}') {
                        return Err("unclosed counted repetition".into());
                    }
                    self.i -= 1;
                    if max.is_some_and(|m| m < min) {
                        return Err("invalid repetition range".into());
                    }
                    (min, max)
                }
                _ => return Ok(atom),
            };
            if matches!(atom, Node::Look(_) | Node::Empty) {
                return Err("repetition operator missing expression".into());
            }
            self.i += 1;
            let greedy = !self.eat('?');
            atom = Node::Repeat(Box::new(atom), min, max, greedy);
        }
    }

    fn flags(&mut self, flags: &mut Flags) -> PResult<bool> {
        let mut on = true;
        loop {
            match self.next()? {
                'i' => flags.i = on,
                's' => flags.s = on,
                'u' => flags.u = on,
                'm' | 'x' | 'U' => {}
                '-' => on = false,
                ')' => return Ok(false),
                ':' => return Ok(true),
                c => return Err(format!("unrecognized flag {c}")),
            }
        }
    }

    fn atom(&mut self, flags: &mut Flags) -> PResult<Node> {
        match self.next()? {
            '(' => {
                let mut inner = *flags;
                if self.eat('?') {
                    if self.eat('P') || self.peek() == Some('<') {
                        self.eat('<');
                        while self.next()? != '>' {}
                    } else if !self.flags(&mut inner)? {
                        // `(?i)` applies to the rest of the enclosing group.
                        *flags = inner;
                        return Ok(Node::Empty);
                    }
                }
                let node = self.alternation(&mut inner)?;
                if !self.eat(')') {
                    return Err("unclosed group".into());
                }
                Ok(node)
            }
            '.' => Ok(Node::Any(flags.s)),
            '^' => Ok(Node::Look(Look::LineStart)),
            '$' => Ok(Node::Look(Look::LineEnd)),
            '[' => self.class(flags).map(Node::Class),
            '\\' => self.escape(flags),
            c @ ('*' | '+' | '?') => Err(format!("repetition operator {c} missing expression")),
            ')' => Err("unopened group".into()),
            c => Ok(Node::Char(c, *flags)),
        }
    }

    fn perl(c: char) -> Option<(Perl, bool)> {
        Some(match c {
            'd' => (Perl::Digit, false),
            'D' => (Perl::Digit, true),
            'w' => (Perl::Word, false),
            'W' => (Perl::Word, true),
            's' => (Perl::Space, false),
            'S' => (Perl::Space, true),
            _ => return None,
        })
    }

    fn hex(&mut self) -> PResult<char> {
        let digits: String = if self.eat('{') {
            let mut s = String::new();
            loop {
                match self.next()? {
                    '}' => break s,
                    c => s.push(c),
                }
            }
        } else {
            [self.next()?, self.next()?].iter().collect()
        };
        u32::from_str_radix(&digits, 16).ok().and_then(char::from_u32).ok_or_else(|| "invalid hex escape".into())
    }

    fn escape_char(&mut self, c: char) -> PResult<char> {
        Ok(match c {
            'n' => '\n',
            't' => '\t',
            'r' => '\r',
            'f' => '\u{c}',
            'v' => '\u{b}',
            '0' => '\0',
            'x' => self.hex()?,
            c if c.is_ascii_alphanumeric() => return Err(format!("unrecognized escape sequence \\{c}")),
            c => c,
        })
    }

    fn escape(&mut self, flags: &Flags) -> PResult<Node> {
        let c = self.next()?;
        if let Some((kind, neg)) = Self::perl(c) {
            return Ok(Node::Class(Class { items: vec![Item::Perl(kind, neg)], negated: false, i: false, u: flags.u }));
        }
        Ok(match c {
            'b' => Node::Look(Look::Word(flags.u)),
            'B' => Node::Look(Look::NotWord(flags.u)),
            'A' => Node::Look(Look::LineStart),
            'z' => Node::Look(Look::LineEnd),
            c => Node::Char(self.escape_char(c)?, *flags),
        })
    }

    fn class(&mut self, flags: &Flags) -> PResult<Class> {
        let mut class = Class { items: Vec::new(), negated: self.eat('^'), i: flags.i, u: flags.u };
        let mut first = true;
        loop {
            let c = self.next().map_err(|_| "unclosed character class".to_string())?;
            if c == ']' && !first {
                return Ok(class);
            }
            first = false;
            if c == '[' && self.eat(':') {
                let mut name = String::new();
                while !self.eat(':') {
                    name.push(self.next()?);
                }
                if !self.eat(']') {
                    return Err("bad POSIX class".into());
                }
                let ranges: &[(char, char)] = match name.as_str() {
                    "alpha" => &[('a', 'z'), ('A', 'Z')],
                    "digit" => &[('0', '9')],
                    "alnum" => &[('a', 'z'), ('A', 'Z'), ('0', '9')],
                    "upper" => &[('A', 'Z')],
                    "lower" => &[('a', 'z')],
                    "space" => &[(' ', ' '), ('\t', '\r')],
                    "xdigit" => &[('0', '9'), ('a', 'f'), ('A', 'F')],
                    "punct" => &[('!', '/'), (':', '@'), ('[', '`'), ('{', '~')],
                    _ => return Err(format!("unknown POSIX class {name}")),
                };
                class.items.extend(ranges.iter().map(|&(a, b)| Item::Range(a, b)));
                continue;
            }
            let lo = if c == '\\' {
                let e = self.next()?;
                if let Some((kind, neg)) = Self::perl(e) {
                    class.items.push(Item::Perl(kind, neg));
                    continue;
                }
                self.escape_char(e)?
            } else {
                c
            };
            if self.peek() == Some('-') && self.chars.get(self.i + 1).is_some_and(|&n| n != ']') {
                self.i += 1;
                let mut hi = self.next()?;
                if hi == '\\' {
                    let e = self.next()?;
                    hi = self.escape_char(e)?;
                }
                if hi < lo {
                    return Err("invalid character class range".into());
                }
                class.items.push(Item::Range(lo, hi));
            } else {
                class.items.push(Item::Range(lo, lo));
            }
        }
    }
}

const MAX_INSTS: usize = 200_000;

struct Compiler {
    prog: Vec<Inst>,
}

impl Compiler {
    fn emit(&mut self, inst: Inst) -> PResult<usize> {
        if self.prog.len() >= MAX_INSTS {
            return Err("pattern too large".into());
        }
        self.prog.push(inst);
        Ok(self.prog.len() - 1)
    }
    fn split(&mut self, greedy: bool, body: usize, next: usize, at: usize) {
        self.prog[at] = if greedy { Inst::Split(body, next) } else { Inst::Split(next, body) };
    }
    fn node(&mut self, node: &Node) -> PResult<()> {
        match node {
            Node::Empty => {}
            Node::Char(c, f) => {
                self.emit(Inst::Char(*c, *f))?;
            }
            Node::Any(s) => {
                self.emit(Inst::Any(*s))?;
            }
            Node::Class(c) => {
                self.emit(Inst::Class(Box::new(c.clone())))?;
            }
            Node::Look(l) => {
                self.emit(Inst::Look(*l))?;
            }
            Node::Concat(items) => {
                for item in items {
                    self.node(item)?;
                }
            }
            Node::Alt(alts) => {
                let mut jumps = Vec::new();
                for (k, alt) in alts.iter().enumerate() {
                    if k + 1 < alts.len() {
                        let split = self.emit(Inst::Jmp(0))?;
                        self.node(alt)?;
                        jumps.push(self.emit(Inst::Jmp(0))?);
                        let next = self.prog.len();
                        self.prog[split] = Inst::Split(split + 1, next);
                    } else {
                        self.node(alt)?;
                    }
                }
                let end = self.prog.len();
                for j in jumps {
                    self.prog[j] = Inst::Jmp(end);
                }
            }
            Node::Repeat(body, min, max, greedy) => {
                for _ in 0..*min {
                    self.node(body)?;
                }
                match max {
                    None => {
                        let split = self.emit(Inst::Jmp(0))?;
                        self.node(body)?;
                        self.emit(Inst::Jmp(split))?;
                        let next = self.prog.len();
                        self.split(*greedy, split + 1, next, split);
                    }
                    Some(max) => {
                        let mut splits = Vec::new();
                        for _ in *min..*max {
                            splits.push(self.emit(Inst::Jmp(0))?);
                            self.node(body)?;
                        }
                        let end = self.prog.len();
                        for s in splits {
                            self.split(*greedy, s + 1, end, s);
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct Regex {
    prog: Vec<Inst>,
}

/// Reusable VM state, so matching line after line does not allocate.
pub struct Cache {
    clist: List,
    nlist: List,
    stack: Vec<usize>,
}

struct List {
    threads: Vec<(usize, usize)>,
    seen: Vec<u32>,
    generation: u32,
}

impl List {
    fn new(n: usize) -> List {
        List { threads: Vec::new(), seen: vec![0; n], generation: 1 }
    }
    fn clear(&mut self) {
        self.threads.clear();
        if self.generation == u32::MAX {
            self.seen.fill(0);
            self.generation = 0;
        }
        self.generation += 1;
    }
}

fn is_word(c: Option<char>, u: bool) -> bool {
    c.is_some_and(|c| perl_match(Perl::Word, c, u))
}

impl Regex {
    pub fn new(pattern: &str) -> Result<Regex, String> {
        let mut parser = Parser { chars: pattern.chars().collect(), i: 0, _src: pattern };
        let mut flags = Flags { i: false, s: false, u: true };
        let ast = parser.alternation(&mut flags)?;
        if parser.i < parser.chars.len() {
            return Err("unopened group".into());
        }
        let mut c = Compiler { prog: Vec::new() };
        c.node(&ast)?;
        c.emit(Inst::Match)?;
        Ok(Regex { prog: c.prog })
    }

    /// Adds `pc`'s epsilon closure at byte `pos` in priority order.
    fn add(&self, list: &mut List, stack: &mut Vec<usize>, pc: usize, start: usize, hay: &str, pos: usize) {
        stack.push(pc);
        while let Some(pc) = stack.pop() {
            if list.seen[pc] == list.generation {
                continue;
            }
            list.seen[pc] = list.generation;
            match &self.prog[pc] {
                Inst::Jmp(t) => stack.push(*t),
                Inst::Split(a, b) => {
                    stack.push(*b);
                    stack.push(*a);
                }
                Inst::Look(look) => {
                    let prev = hay[..pos].chars().next_back();
                    let next = hay[pos..].chars().next();
                    let holds = match *look {
                        Look::LineStart => pos == 0,
                        Look::LineEnd => pos == hay.len(),
                        Look::Word(u) => is_word(prev, u) != is_word(next, u),
                        Look::NotWord(u) => is_word(prev, u) == is_word(next, u),
                    };
                    if holds {
                        stack.push(pc + 1);
                    }
                }
                _ => list.threads.push((pc, start)),
            }
        }
    }

    pub fn cache(&self) -> Cache {
        let n = self.prog.len();
        Cache { clist: List::new(n), nlist: List::new(n), stack: Vec::new() }
    }

    /// The leftmost-first match starting at or after byte `from`.
    pub fn find_at(&self, cache: &mut Cache, hay: &str, from: usize) -> Option<(usize, usize)> {
        let Cache { clist, nlist, stack } = cache;
        clist.clear();
        nlist.clear();
        let mut matched = None;
        let mut pos = from;
        loop {
            if matched.is_none() {
                self.add(clist, stack, 0, pos, hay, pos);
            }
            if clist.threads.is_empty() && matched.is_some() {
                break;
            }
            let c = hay[pos..].chars().next();
            let next_pos = pos + c.map_or(0, char::len_utf8);
            let mut threads = std::mem::take(&mut clist.threads);
            for &(pc, start) in &threads {
                let ok = match (&self.prog[pc], c) {
                    (Inst::Match, _) => {
                        matched = Some((start, pos));
                        break;
                    }
                    (_, None) => false,
                    (Inst::Char(l, f), Some(c)) => *l == c || (f.i && fold(*l, f.u) == fold(c, f.u)),
                    (Inst::Any(s), Some(c)) => *s || c != '\n',
                    (Inst::Class(class), Some(c)) => class.is_match(c),
                    _ => false,
                };
                if ok {
                    self.add(nlist, stack, pc + 1, start, hay, next_pos);
                }
            }
            threads.clear();
            clist.threads = threads;
            if c.is_none() {
                break;
            }
            pos = next_pos;
            std::mem::swap(clist, nlist);
            nlist.clear();
        }
        matched
    }

    /// Every non-overlapping, non-empty match, as byte ranges.
    pub fn find_iter(&self, cache: &mut Cache, hay: &str) -> Vec<(usize, usize)> {
        let mut out = Vec::new();
        let mut pos = 0;
        while pos <= hay.len() {
            let Some((s, e)) = self.find_at(cache, hay, pos) else { break };
            if e > s {
                out.push((s, e));
                pos = e;
            } else {
                pos = e + hay[e..].chars().next().map_or(1, char::len_utf8);
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn all(p: &str, h: &str) -> Vec<(usize, usize)> {
        let re = Regex::new(p).unwrap();
        re.find_iter(&mut re.cache(), h)
    }
    #[test]
    fn matches_like_rust_regex() {
        assert_eq!(all("ab+c", "xabbbc abc"), vec![(1, 6), (7, 10)]);
        assert_eq!(all("(?i)hello", "HeLLo hello"), vec![(0, 5), (6, 11)]);
        assert_eq!(all(r"(?i-u)\bfoo\b", "foo food Foo"), vec![(0, 3), (9, 12)]);
        assert_eq!(all("a|ab", "ab"), vec![(0, 1)]);
        assert_eq!(all("a+?", "aaa"), vec![(0, 1), (1, 2), (2, 3)]);
        assert_eq!(all(r"\d{2,3}", "1 12 1234"), vec![(2, 4), (5, 8)]);
        assert_eq!(all("^fn", "fn x fn"), vec![(0, 2)]);
        assert_eq!(all("[^a-c]+", "abxyzc"), vec![(2, 5)]);
        assert_eq!(all(r"é+", "aéé"), vec![(1, 5)]);
        assert_eq!(all("x*", "ab").len(), 0);
        assert_eq!(all("(?:ab)*c$", "ababc"), vec![(0, 5)]);
        assert_eq!(all(r"\w+@\w+\.com", "mail: a@b.com!"), vec![(6, 13)]);
        assert!(Regex::new("(a").is_err() && Regex::new("*a").is_err() && Regex::new(r"\q").is_err());
        // Linear time: classic catastrophic backtracking pattern stays fast.
        let hay = "a".repeat(5000);
        assert!(all("(a*)*b", &hay).is_empty());
    }
}

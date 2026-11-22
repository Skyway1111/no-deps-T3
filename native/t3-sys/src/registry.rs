//! `t3-sys reg-read SUBKEY [DEPTH]`: HKLM\SUBKEY in the 64-bit view and its subkeys up to DEPTH
//! (default 16) levels down, as `{"values":[...],"subkeys":{"name":{...}}}`. Exit 2 means the key
//! is absent, 1 prints `{"error":WIN32_CODE}` to stderr, and 3 means not Windows.

pub fn run(args: &[String]) -> i32 {
    let Some(subkey) = args.first() else {
        eprintln!("usage: t3-sys reg-read SUBKEY [DEPTH]");
        return 1;
    };
    let depth = args.get(1).and_then(|d| d.parse().ok()).unwrap_or(16);
    match os::read_machine_tree(subkey, depth) {
        Some(Ok(Some(tree))) => {
            println!("{tree}");
            0
        }
        Some(Ok(None)) => 2,
        Some(Err(code)) => {
            eprintln!("{}", crate::json::obj([("error", code.into())]));
            1
        }
        None => 3,
    }
}

#[cfg(windows)]
mod os {
    use crate::json::{Value, obj};
    use std::ffi::c_void;

    type Hkey = *mut c_void;

    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn RegOpenKeyExW(key: Hkey, subkey: *const u16, options: u32, sam: u32, out: *mut Hkey) -> i32;
        fn RegEnumValueW(
            key: Hkey,
            index: u32,
            name: *mut u16,
            name_chars: *mut u32,
            reserved: *mut u32,
            kind: *mut u32,
            data: *mut u8,
            data_bytes: *mut u32,
        ) -> i32;
        fn RegEnumKeyExW(
            key: Hkey,
            index: u32,
            name: *mut u16,
            name_chars: *mut u32,
            reserved: *mut u32,
            class: *mut u16,
            class_chars: *mut u32,
            written: *mut u64,
        ) -> i32;
        fn RegCloseKey(key: Hkey) -> i32;
    }

    const HKEY_LOCAL_MACHINE: Hkey = 0x8000_0002u32 as i32 as isize as Hkey;
    const KEY_READ: u32 = 0x20019;
    const KEY_WOW64_64KEY: u32 = 0x0100;
    const REG_SZ: u32 = 1;
    const REG_DWORD: u32 = 4;
    const ERROR_FILE_NOT_FOUND: i32 = 2;
    const ERROR_MORE_DATA: i32 = 234;
    const ERROR_NO_MORE_ITEMS: i32 = 259;
    // Value and key names are at most 16,383 characters.
    const MAX_NAME_CHARS: u32 = 16_384;

    struct Key(Hkey);
    impl Drop for Key {
        fn drop(&mut self) {
            unsafe { RegCloseKey(self.0) };
        }
    }

    fn open(parent: Hkey, subkey: &str) -> Result<Option<Key>, i32> {
        let wide: Vec<u16> = subkey.encode_utf16().chain([0]).collect();
        let mut key = std::ptr::null_mut();
        match unsafe { RegOpenKeyExW(parent, wide.as_ptr(), 0, KEY_READ | KEY_WOW64_64KEY, &mut key) } {
            0 => Ok(Some(Key(key))),
            ERROR_FILE_NOT_FOUND => Ok(None),
            code => Err(code),
        }
    }

    fn values(key: &Key) -> Result<Vec<Value>, i32> {
        let mut name = vec![0u16; MAX_NAME_CHARS as usize];
        let mut data = vec![0u8; 64 * 1024];
        let mut out = Vec::new();
        for index in 0.. {
            let (mut chars, mut kind, mut bytes) = (MAX_NAME_CHARS, 0u32, data.len() as u32);
            let null = std::ptr::null_mut();
            let mut call = |data: &mut Vec<u8>, chars: &mut u32, bytes: &mut u32| unsafe {
                RegEnumValueW(key.0, index, name.as_mut_ptr(), chars, null, &mut kind, data.as_mut_ptr(), bytes)
            };
            let mut code = call(&mut data, &mut chars, &mut bytes);
            // The value outgrew the buffer; the API reported the size it needs.
            if code == ERROR_MORE_DATA {
                data.resize(bytes as usize, 0);
                (chars, bytes) = (MAX_NAME_CHARS, data.len() as u32);
                code = call(&mut data, &mut chars, &mut bytes);
            }
            match code {
                0 => {}
                ERROR_NO_MORE_ITEMS => break,
                code => return Err(code),
            }
            let value_name = String::from_utf16_lossy(&name[..chars as usize]);
            let stored = &data[..bytes as usize];
            out.push(match kind {
                REG_SZ => {
                    let units: Vec<u16> = stored.as_chunks::<2>().0.iter().map(|&b| u16::from_le_bytes(b)).collect();
                    let end = units.iter().rposition(|&u| u != 0).map_or(0, |i| i + 1);
                    let text = String::from_utf16_lossy(&units[..end]);
                    obj([("name", value_name.into()), ("type", "REG_SZ".into()), ("data", text.into())])
                }
                REG_DWORD if stored.len() == 4 => {
                    let n = u32::from_le_bytes([stored[0], stored[1], stored[2], stored[3]]);
                    obj([("name", value_name.into()), ("type", "REG_DWORD".into()), ("data", n.into())])
                }
                _ => obj([("name", value_name.into()), ("type", "other".into())]),
            });
        }
        Ok(out)
    }

    fn subkey_names(key: &Key) -> Result<Vec<String>, i32> {
        let mut name = vec![0u16; MAX_NAME_CHARS as usize];
        let mut out = Vec::new();
        for index in 0.. {
            let mut chars = MAX_NAME_CHARS;
            let null = std::ptr::null_mut();
            match unsafe { RegEnumKeyExW(key.0, index, name.as_mut_ptr(), &mut chars, null, null.cast(), null, null.cast()) } {
                0 => out.push(String::from_utf16_lossy(&name[..chars as usize])),
                ERROR_NO_MORE_ITEMS => break,
                code => return Err(code),
            }
        }
        Ok(out)
    }

    fn tree(key: &Key, depth: u32) -> Result<Value, i32> {
        let mut subkeys = Vec::new();
        if depth > 0 {
            for name in subkey_names(key)? {
                // A subkey deleted since it was listed is simply gone.
                if let Some(child) = open(key.0, &name)? {
                    subkeys.push((name, tree(&child, depth - 1)?));
                }
            }
        }
        Ok(obj([("values", Value::Arr(values(key)?)), ("subkeys", Value::Obj(subkeys))]))
    }

    pub fn read_machine_tree(subkey: &str, depth: u32) -> Option<Result<Option<Value>, i32>> {
        Some(open(HKEY_LOCAL_MACHINE, subkey).and_then(|key| key.map(|key| tree(&key, depth)).transpose()))
    }
}

#[cfg(not(windows))]
mod os {
    pub fn read_machine_tree(_: &str, _: u32) -> Option<Result<Option<crate::json::Value>, i32>> {
        None
    }
}

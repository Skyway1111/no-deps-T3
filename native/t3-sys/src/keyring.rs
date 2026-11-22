//! `t3-sys keyring get|set|delete SERVICE ACCOUNT`: the macOS login keychain (generic
//! passwords) and Windows Credential Manager (generic credential `SERVICE:ACCOUNT`, the
//! go-keyring target). `set` reads the secret from stdin; `get` writes it raw to stdout.
//! Exit 2 means no such item, 3 that the user must approve access. Linux secrets go
//! through the Secret Service over D-Bus from Node, not this binary.

use std::io::{Read, Write};

pub const NOT_FOUND: i32 = 2;
pub const DENIED: i32 = 3;

#[derive(Debug)]
pub enum Error {
    NotFound,
    Denied(String),
    Other(String),
}

pub fn run(args: &[String]) -> i32 {
    let (Some(op), Some(service), Some(account)) = (args.first(), args.get(1), args.get(2)) else {
        eprintln!("usage: t3-sys keyring get|set|delete SERVICE ACCOUNT");
        return 2;
    };
    let result = match op.as_str() {
        "get" => os::get(service, account).map(|secret| {
            let _ = std::io::stdout().write_all(&secret);
        }),
        "set" => {
            let mut secret = Vec::new();
            let _ = std::io::stdin().read_to_end(&mut secret);
            os::set(service, account, &secret)
        }
        "delete" => os::delete(service, account),
        other => Err(Error::Other(format!("unknown keyring operation {other}"))),
    };
    match result {
        Ok(()) => 0,
        Err(Error::NotFound) => NOT_FOUND,
        Err(Error::Denied(m)) => {
            eprintln!("{m}");
            DENIED
        }
        Err(Error::Other(m)) => {
            eprintln!("{m}");
            1
        }
    }
}

#[cfg(target_os = "macos")]
mod os {
    use super::Error;
    use std::ffi::c_void;

    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        fn SecKeychainFindGenericPassword(
            kc: *const c_void,
            slen: u32,
            service: *const u8,
            alen: u32,
            account: *const u8,
            plen: *mut u32,
            pdata: *mut *mut c_void,
            item: *mut *mut c_void,
        ) -> i32;
        fn SecKeychainAddGenericPassword(
            kc: *const c_void,
            slen: u32,
            service: *const u8,
            alen: u32,
            account: *const u8,
            plen: u32,
            pdata: *const u8,
            item: *mut *mut c_void,
        ) -> i32;
        fn SecKeychainItemModifyAttributesAndData(item: *mut c_void, attrs: *const c_void, len: u32, data: *const u8) -> i32;
        fn SecKeychainItemDelete(item: *mut c_void) -> i32;
        fn SecKeychainItemFreeContent(attrs: *const c_void, data: *mut c_void) -> i32;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(obj: *const c_void);
    }

    fn status(code: i32) -> Result<(), Error> {
        match code {
            0 => Ok(()),
            -25300 => Err(Error::NotFound),
            -128 | -25293 | -25308 => Err(Error::Denied(format!("keychain access denied ({code})"))),
            code => Err(Error::Other(format!("keychain error {code}"))),
        }
    }

    fn find(service: &str, account: &str, want_data: bool) -> Result<(*mut c_void, Vec<u8>), Error> {
        let (mut len, mut data, mut item) = (0u32, std::ptr::null_mut(), std::ptr::null_mut());
        let code = unsafe {
            SecKeychainFindGenericPassword(
                std::ptr::null(),
                service.len() as u32,
                service.as_ptr(),
                account.len() as u32,
                account.as_ptr(),
                &mut len,
                if want_data { &mut data } else { std::ptr::null_mut() },
                &mut item,
            )
        };
        status(code)?;
        let mut secret = Vec::new();
        if !data.is_null() {
            secret = unsafe { std::slice::from_raw_parts(data as *const u8, len as usize) }.to_vec();
            unsafe { SecKeychainItemFreeContent(std::ptr::null(), data) };
        }
        Ok((item, secret))
    }

    pub fn get(service: &str, account: &str) -> Result<Vec<u8>, Error> {
        let (item, secret) = find(service, account, true)?;
        unsafe { CFRelease(item) };
        Ok(secret)
    }

    pub fn set(service: &str, account: &str, secret: &[u8]) -> Result<(), Error> {
        match find(service, account, false) {
            Ok((item, _)) => {
                let code = unsafe { SecKeychainItemModifyAttributesAndData(item, std::ptr::null(), secret.len() as u32, secret.as_ptr()) };
                unsafe { CFRelease(item) };
                status(code)
            }
            Err(Error::NotFound) => status(unsafe {
                SecKeychainAddGenericPassword(
                    std::ptr::null(),
                    service.len() as u32,
                    service.as_ptr(),
                    account.len() as u32,
                    account.as_ptr(),
                    secret.len() as u32,
                    secret.as_ptr(),
                    std::ptr::null_mut(),
                )
            }),
            Err(e) => Err(e),
        }
    }

    pub fn delete(service: &str, account: &str) -> Result<(), Error> {
        let (item, _) = find(service, account, false)?;
        let code = unsafe { SecKeychainItemDelete(item) };
        unsafe { CFRelease(item) };
        status(code)
    }
}

#[cfg(windows)]
mod os {
    use super::Error;
    use std::ffi::c_void;

    #[repr(C)]
    struct Credential {
        flags: u32,
        kind: u32,
        target: *const u16,
        comment: *const u16,
        last_written: [u32; 2],
        blob_size: u32,
        blob: *const u8,
        persist: u32,
        attribute_count: u32,
        attributes: *const c_void,
        alias: *const u16,
        user: *const u16,
    }

    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn CredReadW(target: *const u16, kind: u32, flags: u32, out: *mut *mut Credential) -> i32;
        fn CredWriteW(cred: *const Credential, flags: u32) -> i32;
        fn CredDeleteW(target: *const u16, kind: u32, flags: u32) -> i32;
        fn CredFree(buf: *mut c_void);
    }
    const GENERIC: u32 = 1;
    const PERSIST_LOCAL_MACHINE: u32 = 2;
    const ERROR_NOT_FOUND: i32 = 1168;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }
    fn target(service: &str, account: &str) -> Vec<u16> {
        wide(&format!("{service}:{account}"))
    }
    fn last_error() -> Error {
        let e = std::io::Error::last_os_error();
        if e.raw_os_error() == Some(ERROR_NOT_FOUND) { Error::NotFound } else { Error::Other(e.to_string()) }
    }

    pub fn get(service: &str, account: &str) -> Result<Vec<u8>, Error> {
        let mut cred = std::ptr::null_mut();
        if unsafe { CredReadW(target(service, account).as_ptr(), GENERIC, 0, &mut cred) } == 0 {
            return Err(last_error());
        }
        let secret = unsafe {
            let c = &*cred;
            let s = if c.blob.is_null() { Vec::new() } else { std::slice::from_raw_parts(c.blob, c.blob_size as usize).to_vec() };
            CredFree(cred.cast());
            s
        };
        Ok(secret)
    }

    pub fn set(service: &str, account: &str, secret: &[u8]) -> Result<(), Error> {
        let (t, user) = (target(service, account), wide(account));
        let cred = Credential {
            flags: 0,
            kind: GENERIC,
            target: t.as_ptr(),
            comment: std::ptr::null(),
            last_written: [0; 2],
            blob_size: secret.len() as u32,
            blob: secret.as_ptr(),
            persist: PERSIST_LOCAL_MACHINE,
            attribute_count: 0,
            attributes: std::ptr::null(),
            alias: std::ptr::null(),
            user: user.as_ptr(),
        };
        if unsafe { CredWriteW(&cred, 0) } == 0 { Err(last_error()) } else { Ok(()) }
    }

    pub fn delete(service: &str, account: &str) -> Result<(), Error> {
        if unsafe { CredDeleteW(target(service, account).as_ptr(), GENERIC, 0) } == 0 { Err(last_error()) } else { Ok(()) }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod os {
    use super::Error;
    const MESSAGE: &str = "this platform's secrets are read through the Secret Service from Node";
    pub fn get(_: &str, _: &str) -> Result<Vec<u8>, Error> {
        Err(Error::Other(MESSAGE.into()))
    }
    pub fn set(_: &str, _: &str, _: &[u8]) -> Result<(), Error> {
        Err(Error::Other(MESSAGE.into()))
    }
    pub fn delete(_: &str, _: &str) -> Result<(), Error> {
        Err(Error::Other(MESSAGE.into()))
    }
}

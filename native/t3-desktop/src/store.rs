use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use crate::json::Json;
use crate::lock::FileLock;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Atomic, owner-only (`0600`) JSON file store.
///
/// Writes go to a sibling temporary file with mode `0600`, `fsync` the file,
/// atomically `rename` onto the target path, and `fsync` the parent directory.
pub struct AtomicJsonStore {
    path: PathBuf,
    lock_path: PathBuf,
    mutex: Mutex<()>,
}

impl AtomicJsonStore {
    pub fn new(path: impl AsRef<Path>) -> Self {
        let path = path.as_ref().to_path_buf();
        let mut lock_name = path
            .file_name()
            .map(|n| n.to_os_string())
            .unwrap_or_else(|| "store.json".into());
        lock_name.push(".lock");
        let lock_path = path.with_file_name(lock_name);
        Self {
            path,
            lock_path,
            mutex: Mutex::new(()),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load_json(&self) -> io::Result<Option<Json>> {
        let _guard = self.mutex.lock().unwrap_or_else(|e| e.into_inner());
        self.load_json_unlocked()
    }

    pub fn save_json(&self, value: &Json) -> io::Result<()> {
        let _guard = self.mutex.lock().unwrap_or_else(|e| e.into_inner());
        let _flock = FileLock::lock_exclusive(&self.lock_path)?;
        self.write_json_unlocked(value)
    }

    pub fn get_key(&self, key: &str) -> io::Result<Option<Json>> {
        let _guard = self.mutex.lock().unwrap_or_else(|e| e.into_inner());
        let Some(root) = self.load_json_unlocked()? else {
            return Ok(None);
        };
        Ok(root.get(key).cloned())
    }

    pub fn set_key(&self, key: impl Into<String>, value: Json) -> io::Result<()> {
        let _guard = self.mutex.lock().unwrap_or_else(|e| e.into_inner());
        let _flock = FileLock::lock_exclusive(&self.lock_path)?;
        let mut map = match self.load_json_unlocked()? {
            Some(Json::Object(map)) => map,
            _ => BTreeMap::new(),
        };
        map.insert(key.into(), value);
        self.write_json_unlocked(&Json::Object(map))
    }

    pub fn remove_key(&self, key: &str) -> io::Result<bool> {
        let _guard = self.mutex.lock().unwrap_or_else(|e| e.into_inner());
        let _flock = FileLock::lock_exclusive(&self.lock_path)?;
        let mut map = match self.load_json_unlocked()? {
            Some(Json::Object(map)) => map,
            _ => return Ok(false),
        };
        let existed = map.remove(key).is_some();
        if existed {
            self.write_json_unlocked(&Json::Object(map))?;
        }
        Ok(existed)
    }

    fn load_json_unlocked(&self) -> io::Result<Option<Json>> {
        match fs::symlink_metadata(&self.path) {
            Ok(meta) => {
                if meta.file_type().is_symlink() || !meta.file_type().is_file() {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!(
                            "store path `{}` must be a regular file",
                            self.path.display()
                        ),
                    ));
                }
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(err),
        }

        let contents = fs::read_to_string(&self.path)?;
        let trimmed = contents.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }
        Json::parse(trimmed)
            .map(Some)
            .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err.to_string()))
    }

    fn write_json_unlocked(&self, value: &Json) -> io::Result<()> {
        let parent = self.path.parent().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "store path `{}` has no parent directory",
                    self.path.display()
                ),
            )
        })?;
        ensure_private_dir(parent)?;

        if let Ok(meta) = fs::symlink_metadata(&self.path) {
            if meta.file_type().is_symlink() || !meta.file_type().is_file() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!(
                        "store path `{}` must be a regular file",
                        self.path.display()
                    ),
                ));
            }
        }

        let seq = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let temp_path = parent.join(format!(
            ".{}.tmp-{}-{}",
            self.path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("store.json"),
            std::process::id(),
            seq
        ));

        let write_result = (|| -> io::Result<()> {
            let mut opts = OpenOptions::new();
            opts.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            let mut file = opts.open(&temp_path)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                file.set_permissions(fs::Permissions::from_mode(0o600))?;
            }
            let mut serialized = value.to_json_string();
            serialized.push('\n');
            file.write_all(serialized.as_bytes())?;
            file.sync_all()?;
            drop(file);

            fs::rename(&temp_path, &self.path)?;
            sync_directory(parent);
            Ok(())
        })();

        if write_result.is_err() {
            let _ = fs::remove_file(&temp_path);
        }
        write_result
    }
}

fn ensure_private_dir(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let meta = fs::symlink_metadata(dir)?;
    if meta.file_type().is_symlink() || !meta.file_type().is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("directory `{}` must be a real directory", dir.display()),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

fn sync_directory(dir: &Path) {
    if let Ok(handle) = File::open(dir) {
        let _ = handle.sync_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_store_path(name: &str) -> (PathBuf, PathBuf) {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("t3-store-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("private").join(name);
        (dir, path)
    }

    #[test]
    fn atomic_store_persists_with_0600_mode() {
        let (root, path) = temp_store_path("tokens.json");
        let store = AtomicJsonStore::new(&path);

        assert_eq!(store.get_key("token").unwrap(), None);
        store.set_key("token", Json::from("secret-123")).unwrap();
        store.set_key("theme", Json::from("dark")).unwrap();

        assert_eq!(
            store.get_key("token").unwrap(),
            Some(Json::from("secret-123"))
        );
        assert_eq!(store.get_key("theme").unwrap(), Some(Json::from("dark")));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let file_mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            let dir_mode = fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(file_mode, 0o600);
            assert_eq!(dir_mode, 0o700);
        }

        assert!(store.remove_key("token").unwrap());
        assert_eq!(store.get_key("token").unwrap(), None);
        assert!(!store.remove_key("token").unwrap());

        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_store_rejects_symlink_target() {
        let (root, path) = temp_store_path("tokens.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let outside = root.join("outside.json");
        fs::write(&outside, "{}\n").unwrap();
        std::os::unix::fs::symlink(&outside, &path).unwrap();

        let store = AtomicJsonStore::new(&path);
        assert!(store.set_key("k", Json::from("v")).is_err());
        assert!(store.load_json().is_err());

        let _ = fs::remove_dir_all(&root);
    }
}

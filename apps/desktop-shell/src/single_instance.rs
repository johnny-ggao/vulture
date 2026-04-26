use std::{
    fs::{File, OpenOptions},
    io,
    path::{Path, PathBuf},
};

use anyhow::{anyhow, Context, Result};
use fs2::FileExt;

/// Holds an exclusive flock on a lock file. Drop releases the lock.
#[derive(Debug)]
pub struct InstanceLock {
    _file: File,
    #[allow(dead_code)]
    path: PathBuf,
}

impl InstanceLock {
    /// Try to acquire. Returns Err if already locked by another live process.
    #[allow(dead_code)]
    pub fn acquire(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).with_context(|| {
                format!("failed to ensure lock dir {}", parent.display())
            })?;
        }

        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)
            .with_context(|| format!("failed to open lock file {}", path.display()))?;

        match file.try_lock_exclusive() {
            Ok(()) => Ok(Self { _file: file, path }),
            Err(err) if err.kind() == io::ErrorKind::WouldBlock => {
                Err(anyhow!("another instance holds the lock"))
            }
            Err(err) => Err(err).context("flock failed"),
        }
    }

    #[allow(dead_code)]
    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_lock_path() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "vulture-instance-lock-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn acquires_then_releases() {
        let path = temp_lock_path();
        {
            let _lock = InstanceLock::acquire(&path).expect("first acquire works");
        }
        let _lock2 = InstanceLock::acquire(&path).expect("re-acquire after drop works");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn second_acquire_while_held_fails() {
        let path = temp_lock_path();
        let _lock = InstanceLock::acquire(&path).expect("first works");
        let err = InstanceLock::acquire(&path).expect_err("second should fail");
        assert!(err.to_string().contains("another instance"));
        std::fs::remove_file(&path).ok();
    }
}

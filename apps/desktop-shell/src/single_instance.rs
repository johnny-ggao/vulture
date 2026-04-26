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
    #[allow(dead_code)] // retained for diagnostic logs / future "where is the lock?" UX
    path: PathBuf,
}

impl InstanceLock {
    /// Try to acquire. Returns Err if already locked by another live process.
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

    #[allow(dead_code)] // public diagnostic helper
    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn temp_lock_path() -> PathBuf {
        // Per-test UUID avoids the parallel-test collision that would happen
        // if two tests sampled `SystemTime::now()` in the same nanosecond.
        std::env::temp_dir().join(format!(
            "vulture-instance-lock-{}-{}",
            std::process::id(),
            Uuid::new_v4()
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

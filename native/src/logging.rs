use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

/// Per-user data directory shared with the Lua backend.
pub fn data_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("TEMP"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("SteamWindowsToastNotification")
}

fn log_path() -> PathBuf {
    data_dir().join("helper.log")
}

pub fn error(message: &str) {
    write("ERROR", message);
}

pub fn info(message: &str) {
    if std::env::var_os("STEAM_NATIVE_TOASTS_DEBUG").is_some() {
        write("INFO", message);
    }
}

fn write(level: &str, message: &str) {
    let path = log_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(metadata) = fs::metadata(&path) {
        if metadata.len() > 256 * 1024 {
            let _ = fs::rename(&path, path.with_extension("log.1"));
        }
    }

    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);

    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "[{seconds}] {level} {message}");
    }
}

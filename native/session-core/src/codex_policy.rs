use crate::file_policy::{self, text};
use crate::sqlite_policy;
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use session_core::SourceSpec;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const INDEX_FILE: &str = "session_index.jsonl";
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

pub struct CodexDeleteGuard {
    databases: Vec<Connection>,
    _index_lease: Vec<File>,
    temporary: Option<PathBuf>,
    index: PathBuf,
}

pub struct ScanRevisions {
    databases: Vec<(PathBuf, Connection)>,
    records: HashMap<String, Vec<String>>,
}

impl ScanRevisions {
    pub fn load(source: &SourceSpec) -> Result<Self, String> {
        let (config, paths) = configuration(source)?;
        let mut databases = Vec::new();
        for path in paths.into_iter().filter(|path| path.is_file()) {
            let connection = sqlite_policy::open_readonly(&path)?;
            databases.push((path, connection));
        }
        let mut records: HashMap<String, Vec<String>> = HashMap::new();
        for line in read_index(&config.join(INDEX_FILE))?.lines() {
            let Ok(record) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            if let Some(id) = record.get("id").and_then(Value::as_str) {
                records
                    .entry(id.to_string())
                    .or_default()
                    .push(line.to_string());
            }
        }
        Ok(Self { databases, records })
    }

    pub fn revision(&self, id: &str) -> Result<String, String> {
        let mut digest = Sha256::new();
        for (path, connection) in &self.databases {
            digest.update(path.to_string_lossy().as_bytes());
            digest.update(sqlite_policy::fingerprint(connection, id)?.as_bytes());
        }
        let records = self
            .records
            .get(id)
            .map(|lines| lines.join("\n"))
            .unwrap_or_default();
        digest.update(records.as_bytes());
        Ok(format!("{:x}", digest.finalize()))
    }
}

pub fn revision(source: &SourceSpec, id: &str) -> Result<String, String> {
    // 扫描只共享本次快照；执行前复核始终重新读取，不能沿用旧索引。
    ScanRevisions::load(source)?.revision(id)
}

pub fn prepare(source: &SourceSpec, id: &str, expected: &str) -> Result<CodexDeleteGuard, String> {
    let (config, paths) = configuration(source)?;
    let index = config.join(INDEX_FILE);
    let index_lease = if index.is_file() {
        if fs::metadata(&index).map_err(text)?.permissions().readonly() {
            return Err("会话索引为只读，尚未删除会话".to_string());
        }
        file_policy::acquire_leases(std::slice::from_ref(&index))?
    } else {
        Vec::new()
    };
    let mut guard = CodexDeleteGuard {
        databases: Vec::new(),
        _index_lease: index_lease,
        temporary: None,
        index,
    };
    let original = read_index(&guard.index)?;
    let mut digest = Sha256::new();
    for database in paths.iter().filter(|path| path.is_file()) {
        let connection = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(text)?;
        connection.busy_timeout(BUSY_TIMEOUT).map_err(text)?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(text)?;
        connection.execute_batch("BEGIN IMMEDIATE").map_err(text)?;
        digest.update(database.to_string_lossy().as_bytes());
        digest.update(sqlite_policy::fingerprint(&connection, id)?.as_bytes());
        guard.databases.push(connection);
    }
    digest.update(index_records(&original, id).as_bytes());
    if format!("{:x}", digest.finalize()) != expected {
        return Err("Codex 状态索引已变化，请重新扫描".to_string());
    }
    // 在移除正文前验证 SQL、外键与索引写入；失败时事务回滚，正文仍保留。
    for connection in &guard.databases {
        sqlite_policy::delete_matching(connection, "threads", "id", id)?;
    }
    if guard.index.is_file() {
        guard.temporary = Some(prepare_index(&guard.index, &original, id)?);
    }
    Ok(guard)
}

impl CodexDeleteGuard {
    pub fn finish(mut self) -> Result<(), String> {
        for connection in &self.databases {
            connection.execute_batch("COMMIT").map_err(text)?;
        }
        if let Some(temporary) = self.temporary.take() {
            if let Err(error) = replace_index(&temporary, &self.index) {
                self.temporary = Some(temporary);
                return Err(error);
            }
        }
        Ok(())
    }
}

impl Drop for CodexDeleteGuard {
    fn drop(&mut self) {
        for connection in &self.databases {
            if !connection.is_autocommit() {
                let _ = connection.execute_batch("ROLLBACK");
            }
        }
        if let Some(temporary) = &self.temporary {
            let _ = fs::remove_file(temporary);
        }
    }
}

fn configuration(source: &SourceSpec) -> Result<(PathBuf, Vec<PathBuf>), String> {
    let config = session_core::context::codex_config_root(source);
    let content = match fs::read_to_string(config.join("config.toml")) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(text(error)),
    };
    let paths = session_core::with_source(source, || {
        session_core::codex_state_db::codex_state_db_paths(&config, &content)
    });
    Ok((config, paths))
}

fn read_index(path: &Path) -> Result<String, String> {
    match fs::read_to_string(path) {
        Ok(content) => Ok(content),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(text(error)),
    }
}

fn is_selected(line: &str, id: &str) -> bool {
    serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|value| {
            value
                .get("id")
                .and_then(Value::as_str)
                .map(|value| value == id)
        })
        .unwrap_or(false)
}

fn index_records(content: &str, id: &str) -> String {
    content
        .lines()
        .filter(|line| is_selected(line, id))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod scan_revision_tests {
    use super::*;

    #[test]
    fn scan_index_snapshot_preserves_raw_lines_and_fresh_checks_reload() {
        let directory = tempfile::tempdir().unwrap();
        let source: SourceSpec = serde_json::from_value(serde_json::json!({
            "id":"fixture", "kind":"codex", "path":directory.path().join("sessions"),
            "configPath":directory.path(), "home":directory.path()
        }))
        .unwrap();
        let index = directory.path().join(INDEX_FILE);
        let content = "{\"id\":\"a\",\"thread_name\":\"中文\"}\r\ninvalid\n{\"id\":\"b\"}\n{ \"id\": \"a\" }\n";
        fs::write(&index, content).unwrap();
        let snapshot = ScanRevisions::load(&source).unwrap();
        for id in ["a", "b", "missing"] {
            let expected = format!(
                "{:x}",
                Sha256::digest(index_records(content, id).as_bytes())
            );
            assert_eq!(snapshot.revision(id).unwrap(), expected);
            assert_eq!(revision(&source, id).unwrap(), expected);
        }
        let before = snapshot.revision("a").unwrap();
        fs::write(&index, "{\"id\":\"a\",\"thread_name\":\"changed\"}\n").unwrap();
        assert_eq!(snapshot.revision("a").unwrap(), before);
        assert_ne!(revision(&source, "a").unwrap(), before);
    }
}

fn prepare_index(path: &Path, original: &str, id: &str) -> Result<PathBuf, String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(text)?
        .as_nanos();
    let temporary =
        path.with_file_name(format!(".session-index-{}-{stamp}.tmp", std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(text)?;
    let retained: String = original
        .split_inclusive('\n')
        .filter(|line| !is_selected(line, id))
        .collect();
    if let Err(error) = file
        .write_all(retained.as_bytes())
        .and_then(|_| file.sync_all())
    {
        let _ = fs::remove_file(&temporary);
        return Err(text(error));
    }
    Ok(temporary)
}

#[cfg(not(windows))]
fn replace_index(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(text)
}

#[cfg(windows)]
fn replace_index(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn ReplaceFileW(
            replaced: *const u16,
            replacement: *const u16,
            backup: *const u16,
            flags: u32,
            exclude: *mut std::ffi::c_void,
            reserved: *mut std::ffi::c_void,
        ) -> i32;
    }
    let existing: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let new: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let result = unsafe {
        ReplaceFileW(
            new.as_ptr(),
            existing.as_ptr(),
            std::ptr::null(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}

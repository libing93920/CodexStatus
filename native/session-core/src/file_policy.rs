use serde_json::Value;
use session_core::SourceSpec;
use sha2::{Digest, Sha256};
use std::fs::{self, File, Metadata};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const HASH_CHUNK_BYTES: usize = 64 * 1024;
#[cfg(windows)]
const REPARSE_POINT_ATTRIBUTE: u32 = 0x400;
#[cfg(windows)]
const READ_AND_DELETE_SHARING: u32 = 0x1 | 0x4;

pub fn root(source: &SourceSpec) -> PathBuf {
    if source.path.is_file() {
        source.path.parent().unwrap_or(&source.path).to_path_buf()
    } else {
        source.path.clone()
    }
}

pub fn database_path(reference: &str, session_id: &str, provider: &str) -> Result<PathBuf, String> {
    let delimiter = match provider {
        "opencode" => ":",
        "hermes" => "#",
        _ => return Err("未识别的数据库引用格式".to_string()),
    };
    reference
        .strip_prefix("sqlite:")
        .and_then(|value| value.strip_suffix(&format!("{delimiter}{session_id}")))
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "数据库会话引用无效".to_string())
}

pub fn validate_database(source: &SourceSpec, database: &Path) -> Result<(), String> {
    let expected = if source.kind == "opencode" {
        session_core::context::opencode_database(source)
    } else {
        source.database_path.clone().unwrap_or_else(|| {
            if source.path.is_file() {
                source.path.clone()
            } else {
                source.path.join(match source.kind.as_str() {
                    "hermes" => "state.db",
                    "mcode" => "v2/sqlite/runtime-state.sqlite",
                    _ => "opencode.db",
                })
            }
        })
    };
    if canonical(database)? != canonical(&expected)? {
        return Err("数据库不属于登记来源".to_string());
    }
    reject_link(&fs::symlink_metadata(database).map_err(text)?)
}

pub fn collect(root: &Path, target: &Path, output: &mut Vec<PathBuf>) -> Result<(), String> {
    let information = match fs::symlink_metadata(target) {
        Ok(information) => information,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(text(error)),
    };
    validate_owned(root, target)?;
    reject_link(&information)?;
    if information.is_file() {
        output.push(target.to_path_buf());
    } else if information.is_dir() {
        let mut entries = fs::read_dir(target)
            .map_err(text)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(text)?;
        entries.sort_by_key(|entry| entry.path());
        for entry in entries {
            collect(root, &entry.path(), output)?;
        }
    } else {
        return Err("会话包含特殊文件，不能直接删除".to_string());
    }
    Ok(())
}

pub fn validate_owned(root: &Path, target: &Path) -> Result<(), String> {
    let canonical_root = canonical(root)?;
    reject_link(&fs::symlink_metadata(root).map_err(text)?)?;
    let canonical_target = canonical(target)?;
    if canonical_target == canonical_root || !canonical_target.starts_with(&canonical_root) {
        return Err("会话资源越过登记目录或等于整个来源目录".to_string());
    }
    let root_path = lexical_path(root);
    let target_path = lexical_path(target);
    let relative = target_path
        .strip_prefix(&root_path)
        .map_err(|_| "资源路径不在来源目录中")?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        reject_link(&fs::symlink_metadata(&current).map_err(text)?)?;
    }
    Ok(())
}

fn lexical_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let value = path.as_os_str().to_string_lossy();
        if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        if let Some(local) = value.strip_prefix(r"\\?\") {
            return PathBuf::from(local);
        }
    }
    path.to_path_buf()
}

pub fn fingerprint(files: &[PathBuf]) -> Result<(String, u64), String> {
    let mut sorted = files.to_vec();
    sorted.sort();
    sorted.dedup();
    let mut digest = Sha256::new();
    let mut bytes = 0;
    for file in sorted {
        let before = fs::symlink_metadata(&file).map_err(text)?;
        reject_link(&before)?;
        digest.update(file.to_string_lossy().as_bytes());
        digest.update(before.len().to_le_bytes());
        let modified = before
            .modified()
            .map_err(text)?
            .duration_since(UNIX_EPOCH)
            .map_err(text)?
            .as_nanos();
        digest.update(modified.to_le_bytes());
        let mut input = File::open(&file).map_err(text)?;
        let mut buffer = [0; HASH_CHUNK_BYTES];
        loop {
            let count = input.read(&mut buffer).map_err(text)?;
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
        }
        let after = fs::metadata(&file).map_err(text)?;
        if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
            return Err("资源在扫描期间发生变化，请重新扫描".to_string());
        }
        bytes += after.len();
    }
    Ok((format!("{:x}", digest.finalize()), bytes))
}

pub fn acquire_leases(files: &[PathBuf]) -> Result<Vec<File>, String> {
    let mut leases = Vec::new();
    for file in files {
        let mut options = fs::OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(READ_AND_DELETE_SHARING);
        }
        leases.push(
            options
                .open(file)
                .map_err(|_| "会话文件正在写入或无法独占核验".to_string())?,
        );
    }
    Ok(leases)
}

pub fn legacy_opencode_targets(source: &SourceSpec, id: &str) -> Result<Vec<PathBuf>, String> {
    safe_component(id)?;
    let base = root(source);
    let storage = session_core::context::opencode_storage_root(source);
    let mut session_files = Vec::new();
    collect(&base, &storage.join("session"), &mut session_files)?;
    let mut targets = Vec::new();
    for file in session_files {
        let expected = format!("{id}.json");
        if file.file_name().and_then(|value| value.to_str()) != Some(expected.as_str()) {
            continue;
        }
        let value: Value = serde_json::from_slice(&fs::read(&file).map_err(text)?).map_err(text)?;
        if value.get("id").and_then(Value::as_str) != Some(id) {
            return Err("旧会话副本的文件名与会话身份不匹配".to_string());
        }
        targets.push(file);
    }
    let messages = storage.join("message").join(id);
    let mut message_files = Vec::new();
    collect(&base, &messages, &mut message_files)?;
    for file in message_files {
        let value: Value = serde_json::from_slice(&fs::read(&file).map_err(text)?).map_err(text)?;
        if let Some(message_id) = value.get("id").and_then(Value::as_str) {
            safe_component(message_id)?;
            targets.push(storage.join("part").join(message_id));
        }
    }
    targets.push(messages);
    targets.push(storage.join("session_diff").join(format!("{id}.json")));
    targets.retain(|target| target.exists());
    targets.sort();
    targets.dedup();
    Ok(targets)
}

/** 旧 JSON 副本先暂存，SQL 失败时还原，避免回滚后丢失文件型副本。 */
pub struct StagedFiles {
    pub directory: Option<PathBuf>,
    entries: Vec<(PathBuf, PathBuf)>,
    root: PathBuf,
}

impl StagedFiles {
    pub fn stage(source: &SourceSpec, targets: &[PathBuf]) -> Result<Self, String> {
        let base = root(source);
        let mut staged = Self {
            directory: None,
            entries: Vec::new(),
            root: base.clone(),
        };
        if targets.is_empty() {
            return Ok(staged);
        }
        let stamp = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(text)?
            .as_nanos();
        let directory = base.join(format!(
            ".session-core-delete-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir(&directory).map_err(text)?;
        staged.directory = Some(directory.clone());
        for (index, original) in targets.iter().enumerate() {
            let target = directory.join(index.to_string());
            let moved = validate_owned(&base, original)
                .and_then(|_| fs::rename(original, &target).map_err(text));
            if let Err(error) = moved {
                return match staged.restore() {
                    Ok(()) => Err(format!("旧副本无法暂存，未删除数据库：{error}")),
                    Err(restore) => Err(format!("暂存失败：{error}；还原未完成：{restore}")),
                };
            }
            staged.entries.push((original.clone(), target));
        }
        Ok(staged)
    }

    pub fn restore(&mut self) -> Result<(), String> {
        let mut errors = Vec::new();
        for (original, target) in self.entries.iter().rev() {
            if !target.exists() {
                continue;
            }
            if original.exists() {
                errors.push(format!(
                    "原路径已有新数据，保留暂存副本 {}",
                    target.display()
                ));
                continue;
            }
            if let Err(error) = fs::rename(target, original) {
                errors.push(text(error));
            }
        }
        if errors.is_empty() {
            if let Some(directory) = &self.directory {
                fs::remove_dir(directory).map_err(text)?;
            }
            self.directory = None;
            Ok(())
        } else {
            Err(errors.join("；"))
        }
    }

    pub fn finish(&mut self) -> Result<(), String> {
        if let Some(directory) = &self.directory {
            let mut files = Vec::new();
            collect(&self.root, directory, &mut files)?;
            fs::remove_dir_all(directory).map_err(text)?;
        }
        self.directory = None;
        Ok(())
    }

    pub fn remaining_bytes(&self) -> Result<u64, String> {
        let Some(directory) = &self.directory else {
            return Ok(0);
        };
        let mut files = Vec::new();
        collect(&self.root, directory, &mut files)?;
        files
            .iter()
            .map(|file| fs::metadata(file).map(|info| info.len()).map_err(text))
            .sum()
    }
}

fn safe_component(value: &str) -> Result<(), String> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
    {
        return Err("会话或消息 ID 不能用作安全的资源路径".to_string());
    }
    Ok(())
}

fn reject_link(metadata: &Metadata) -> Result<(), String> {
    let mut link = metadata.file_type().is_symlink();
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        link |= metadata.file_attributes() & REPARSE_POINT_ATTRIBUTE != 0;
    }
    if link {
        Err("链接或 junction 不允许参与删除".to_string())
    } else {
        Ok(())
    }
}

pub fn canonical(path: &Path) -> Result<PathBuf, String> {
    path.canonicalize().map_err(text)
}
pub fn text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

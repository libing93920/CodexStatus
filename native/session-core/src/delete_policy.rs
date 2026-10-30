use crate::protocol::SessionRef;
use crate::sqlite_policy::{self, DeleteOptions};
use crate::{codex_policy, file_policy};
use serde_json::{json, Value};
use session_core::session_manager::{self, SessionMeta};
use session_core::{with_source, SourceSpec};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;

pub struct Inspection {
    pub revision: String,
    pub files: Vec<PathBuf>,
    pub targets: Vec<PathBuf>,
    pub bytes: u64,
    pub database_revision: Option<String>,
    pub index_revision: Option<String>,
    pub warnings: Vec<String>,
}

impl Inspection {
    pub fn preview(&self, session: &SessionRef) -> Value {
        json!({"session":session,"revision":self.revision,"files":self.files,
            "fileBytes":self.bytes,"warnings":self.warnings})
    }
}

pub fn supports_delete(provider: &str) -> bool {
    matches!(
        provider,
        "codex"
            | "claude"
            | "opencode"
            | "openclaw"
            | "gemini"
            | "hermes"
            | "grokbuild"
            | "pi"
            | "omp"
    )
}

pub fn inspect(source: &SourceSpec, meta: &SessionMeta) -> Result<Inspection, String> {
    let index_revision = if source.kind == "codex" {
        Some(codex_policy::revision(source, &meta.session_id)?)
    } else {
        None
    };
    inspect_with_index(source, meta, index_revision)
}

pub fn inspect_with_index(
    source: &SourceSpec,
    meta: &SessionMeta,
    index_revision: Option<String>,
) -> Result<Inspection, String> {
    let reference = meta.source_path.as_ref().ok_or("会话没有来源引用")?;
    let base = file_policy::root(source);
    let database = reference.starts_with("sqlite:") || source.kind == "mcode";
    let mut database_revision = None;
    let targets = if database {
        let path = if source.kind == "mcode" {
            source.path.join("v2/sqlite/runtime-state.sqlite")
        } else {
            file_policy::database_path(reference, &meta.session_id, &source.kind)?
        };
        file_policy::validate_database(source, &path)?;
        let connection = sqlite_policy::open_readonly(&path)?;
        database_revision = Some(sqlite_policy::fingerprint(&connection, &meta.session_id)?);
        if meta.provider_id == "opencode" {
            file_policy::legacy_opencode_targets(source, &meta.session_id)?
        } else if meta.provider_id == "hermes" {
            with_source(source, || {
                session_manager::providers::hermes::scan_sessions_jsonl()
            })
            .into_iter()
            .filter(|old| old.session_id == meta.session_id)
            .filter_map(|old| old.source_path.map(PathBuf::from))
            .collect()
        } else {
            Vec::new()
        }
    } else {
        file_targets(source, meta)?
    };
    let mut files = Vec::new();
    for target in &targets {
        file_policy::collect(&base, target, &mut files)?;
    }
    files.sort();
    files.dedup();
    let (file_revision, bytes) = file_policy::fingerprint(&files)?;
    let mut hash = Sha256::new();
    hash.update(reference.as_bytes());
    hash.update(meta.session_id.as_bytes());
    hash.update(file_revision.as_bytes());
    if let Some(revision) = &database_revision {
        hash.update(revision.as_bytes());
    }
    if let Some(revision) = &index_revision {
        hash.update(revision.as_bytes());
    }
    let warnings = if database {
        vec!["删除数据库记录不保证立即缩小数据库文件；可另行整理数据库".to_string()]
    } else {
        Vec::new()
    };
    Ok(Inspection {
        revision: format!("{:x}", hash.finalize()),
        files,
        targets,
        bytes,
        database_revision,
        index_revision,
        warnings,
    })
}

pub fn delete(
    source: &SourceSpec,
    meta: &SessionMeta,
    session: &SessionRef,
    expected: &str,
) -> Result<Value, String> {
    if !supports_delete(&meta.provider_id) {
        return Err("请在原工具中删除此会话，以保持索引和历史一致".to_string());
    }
    let inspected = inspect(source, meta)?;
    if inspected.revision != expected {
        return Err("会话已变化，请重新扫描".to_string());
    }
    let _leases = file_policy::acquire_leases(&inspected.files)?;
    if inspect(source, meta)?.revision != expected {
        return Err("会话资源在执行前发生变化，未删除".to_string());
    }
    let mut codex_guard = if source.kind == "codex" {
        Some(codex_policy::prepare(
            source,
            &session.session_id,
            inspected
                .index_revision
                .as_deref()
                .ok_or("缺少 Codex 索引版本")?,
        )?)
    } else {
        None
    };
    let mut residue = None;
    let mut residual_bytes = 0;
    let deleted = if source.kind == "codex" {
        // 正文先暂存；索引提交失败时仍可还原正文，不把失败变成丢失会话。
        let mut staged = file_policy::StagedFiles::stage(source, &inspected.targets)?;
        let committed = codex_guard.take().ok_or("缺少 Codex 索引保护")?.finish();
        if let Err(error) = committed {
            return match staged.restore() {
                Ok(()) => Err(format!(
                    "Codex 索引更新失败，正文已还原，请重新扫描核对：{error}"
                )),
                Err(restore) => Err(format!(
                    "Codex 索引更新失败：{error}；正文还原未完成：{restore}"
                )),
            };
        }
        if let Err(error) = staged.finish() {
            residual_bytes = staged.remaining_bytes().unwrap_or(inspected.bytes);
            residue = Some(format!(
                "会话已移除，正文暂存目录未清完 {:?}：{error}",
                staged.directory
            ));
        }
        true
    } else if session.source_path.starts_with("sqlite:")
        && matches!(source.kind.as_str(), "opencode" | "hermes")
    {
        let path =
            file_policy::database_path(&session.source_path, &session.session_id, &source.kind)?;
        let mut staged = file_policy::StagedFiles::stage(source, &inspected.targets)?;
        let options = DeleteOptions {
            path: &path,
            session_id: &session.session_id,
            expected_database_revision: inspected
                .database_revision
                .as_deref()
                .ok_or("缺少数据库版本")?,
        };
        let deletion = if source.kind == "opencode" {
            sqlite_policy::delete_opencode(options)
        } else {
            sqlite_policy::delete_hermes(options)
        };
        let deleted = match deletion {
            Ok(deleted) => deleted,
            Err(error) => {
                return match staged.restore() {
                    Ok(()) => Err(error),
                    Err(restore) => Err(format!("{error}；旧副本还原未完成：{restore}")),
                };
            }
        };
        if let Err(error) = staged.finish() {
            residual_bytes = staged.remaining_bytes().unwrap_or(inspected.bytes);
            residue = Some(format!(
                "会话已删除，旧副本暂存目录未清完 {:?}：{error}",
                staged.directory
            ));
        }
        deleted
    } else {
        with_source(source, || {
            session_manager::delete_session(
                &session.provider_id,
                &session.session_id,
                &session.source_path,
            )
        })?
    };
    if !deleted {
        return Err("原工具未确认会话已删除".to_string());
    }
    session_manager::cache::global().remove(&session.provider_id, &session.source_path);
    let after = inspected
        .files
        .iter()
        .filter_map(|file| fs::metadata(file).ok())
        .map(|information| information.len())
        .sum::<u64>()
        + residual_bytes;
    Ok(
        json!({"session":session,"deleted":true,"fileBytesBefore":inspected.bytes,
        "fileBytesAfter":after,"reason":residue}),
    )
}

fn file_targets(source: &SourceSpec, meta: &SessionMeta) -> Result<Vec<PathBuf>, String> {
    let reference = meta.source_path.as_ref().ok_or("缺少会话文件")?;
    let path = PathBuf::from(reference);
    let mut targets = vec![path.clone()];
    match source.kind.as_str() {
        "codex" => {
            if let Some(sibling) = session_core::codex_rollout_file::sibling(&path) {
                if sibling.exists() {
                    targets.push(sibling);
                }
            }
        }
        "claude" => {
            let sidecar = path.with_extension("");
            if sidecar.exists() {
                targets.push(sidecar);
            }
        }
        "gemini" => {
            if path.extension().and_then(|extension| extension.to_str()) == Some("jsonl") {
                let legacy = path.with_extension("json");
                if legacy.exists() {
                    targets.push(legacy);
                }
            }
        }
        "omp" => {
            let artifacts = path.with_extension("");
            if artifacts.exists() {
                targets.push(artifacts);
            }
            let parent = path.parent().ok_or("OMP 会话没有目录")?;
            let prefix = format!(
                "{}.",
                path.file_name().ok_or("OMP 文件名无效")?.to_string_lossy()
            );
            for entry in fs::read_dir(parent).map_err(file_policy::text)? {
                let entry = entry.map_err(file_policy::text)?;
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with(&prefix) && name.ends_with(".bak") {
                    targets.push(entry.path());
                }
            }
        }
        "grokbuild" => targets = vec![path.parent().ok_or("会话没有目录")?.to_path_buf()],
        "opencode" => targets = file_policy::legacy_opencode_targets(source, &meta.session_id)?,
        _ => {}
    }
    // 读取元数据成功不能授权删除整个 Agent 数据目录。
    let base = file_policy::root(source);
    for target in &targets {
        if target.exists() {
            file_policy::validate_owned(&base, target)?;
        }
    }
    if targets.is_empty() && supports_delete(&source.kind) {
        return Err("未找到可以核验的独立会话资源".to_string());
    }
    Ok(targets)
}

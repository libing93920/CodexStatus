pub mod context;
pub use context::{with_source, ScanIssue, SourceSpec};

#[path = "upstream/session_manager/mod.rs"]
pub mod session_manager;
#[path = "upstream/codex_rollout_file.rs"]
pub mod codex_rollout_file;
#[path = "upstream/kimi_session.rs"]
pub(crate) mod kimi_session;
#[path = "upstream/codex_state_db.rs"]
pub mod codex_state_db;
pub(crate) mod services;

pub use session_manager::{DeleteSessionOutcome, DeleteSessionRequest, LoadedTranscript, SessionMeta, SessionMessage};
pub use session_manager::{delete_session, delete_sessions, load_messages, load_transcript, scan_sessions};

#[derive(Debug)]
pub struct ScanResult {
    pub sessions: Vec<SessionMeta>,
    pub issues: Vec<ScanIssue>,
}

pub fn scan_source(source: &SourceSpec) -> Result<Vec<SessionMeta>, String> {
    scan_source_with_issues(source).map(|result| result.sessions)
}

pub fn scan_source_with_issues(source: &SourceSpec) -> Result<ScanResult, String> {
    if source.path.as_os_str().is_empty() {
        return Err("来源目录不能为空".to_string());
    }
    match context::path_is_link(&source.path) {
        Ok(true) => {
            return Err(format!(
                "来源路径是符号链接或 Windows reparse point：{}",
                source.path.display()
            ));
        }
        Ok(false) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("无法检查来源路径：{error}")),
    }

    let (sessions, issues) = context::with_source_issues(source, || {
        let sessions = match source.kind.as_str() {
            "codex" => session_manager::providers::codex::scan_sessions(),
            "claude" => session_manager::providers::claude::scan_sessions(),
            "opencode" => session_manager::providers::opencode::scan_sessions(),
            "openclaw" => session_manager::providers::openclaw::scan_sessions(),
            "gemini" => session_manager::providers::gemini::scan_sessions(),
            "hermes" => session_manager::providers::hermes::scan_sessions(),
            "grokbuild" => session_manager::providers::grokbuild::scan_sessions(),
            "pi" => session_manager::providers::pi::scan_sessions(),
            "omp" => session_manager::providers::omp::scan_sessions(),
            "mcode" => session_manager::providers::mcode::scan_sessions(),
            "kimi" => session_manager::providers::kimi::scan_sessions(),
            "agy" => session_manager::providers::agy::scan_sessions(),
            kind => return Err(format!("不支持的会话来源：{kind}")),
        };
        Ok(sessions)
    });
    Ok(ScanResult {
        sessions: sessions?,
        issues,
    })
}

pub(crate) mod error {
    use std::fmt;
    use std::path::Path;

    #[derive(Debug)]
    pub struct AppError(String);

    impl AppError {
        pub(crate) fn io(path: &Path, error: std::io::Error) -> Self {
            Self(format!("{}: {error}", path.display()))
        }

        pub(crate) fn message(message: impl Into<String>) -> Self {
            Self(message.into())
        }
    }

    impl fmt::Display for AppError {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str(&self.0)
        }
    }

    impl std::error::Error for AppError {}
}

pub(crate) mod config {
    use std::path::{Path, PathBuf};

    use serde::Serialize;

    use crate::{context, error::AppError};

    pub(crate) fn get_home_dir() -> PathBuf {
        context::home_dir().unwrap_or_else(context::missing_source_path)
    }

    pub(crate) fn is_wsl_path(path: &Path) -> bool {
        let path = path.to_string_lossy().to_ascii_lowercase();
        path.starts_with("\\\\wsl$\\") || path.starts_with("\\\\wsl.localhost\\")
    }

    pub(crate) fn get_claude_config_dir() -> PathBuf {
        context::provider_config_dir("claude", &["projects"])
            .unwrap_or_else(context::missing_source_path)
    }

    pub(crate) fn sqlite_unsupported_in_temp_dir() -> bool {
        false
    }

    pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
        if !context::path_is_within_source(path) {
            return Err(AppError::message("写入路径不属于当前显式来源"));
        }
        let parent = path
            .parent()
            .ok_or_else(|| AppError::message("写入路径缺少父目录"))?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)
            .map_err(|error| AppError::io(path, error))?;
        std::io::Write::write_all(&mut temporary, bytes)
            .map_err(|error| AppError::io(path, error))?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|error| AppError::io(path, error))?;
        temporary
            .persist(path)
            .map_err(|error| AppError::io(path, error.error))?;
        Ok(())
    }

    pub(crate) fn write_json_file<T: Serialize>(path: &Path, value: &T) -> Result<(), AppError> {
        let bytes = serde_json::to_vec_pretty(value)
            .map_err(|error| AppError::message(error.to_string()))?;
        atomic_write(path, &bytes)
    }

}

pub(crate) mod codex_config {
    use std::path::PathBuf;

    use crate::context;

    pub(crate) fn get_codex_config_dir() -> PathBuf {
        context::provider_config_dir(
            "codex",
            &["sessions", "archived_sessions", "archived_sources"],
        )
        .unwrap_or_else(context::missing_source_path)
    }

    pub(crate) fn read_codex_config_text() -> std::io::Result<String> {
        let path = get_codex_config_dir().join("config.toml");
        match context::safe_entry(&path) {
            Ok(true) => std::fs::read_to_string(path),
            Ok(false) => Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "Codex config is a link and was skipped",
            )),
            Err(error) => Err(error),
        }
    }
}

pub(crate) mod gemini_config {
    use std::path::PathBuf;

    use crate::context;

    pub(crate) fn get_gemini_dir() -> PathBuf {
        context::provider_config_dir("gemini", &["tmp"])
            .unwrap_or_else(context::missing_source_path)
    }
}

pub(crate) mod grok_config {
    use std::path::PathBuf;

    use crate::context;

    pub(crate) fn get_grok_config_dir() -> PathBuf {
        context::provider_config_dir("grokbuild", &["sessions", "archived_sessions"])
            .unwrap_or_else(context::missing_source_path)
    }
}

pub(crate) mod hermes_config {
    use std::path::PathBuf;

    use crate::context;

    pub(crate) fn get_hermes_dir() -> PathBuf {
        context::provider_config_dir("hermes", &["sessions"])
            .unwrap_or_else(context::missing_source_path)
    }
}

pub(crate) mod kimi_config {
    use std::path::PathBuf;

    use crate::context;

    pub(crate) fn data_dir() -> PathBuf {
        context::provider_config_dir("kimi", &["sessions"])
            .unwrap_or_else(context::missing_source_path)
    }
}

pub(crate) mod mcode_config {
    use std::path::PathBuf;

    use crate::context;

    pub(crate) fn data_dir() -> PathBuf {
        context::source_root("mcode").unwrap_or_else(context::missing_source_path)
    }
}

pub(crate) mod openclaw_config {
    use std::path::PathBuf;

    use crate::context;

    pub(crate) fn get_openclaw_dir() -> PathBuf {
        context::provider_config_dir("openclaw", &["agents"])
            .unwrap_or_else(context::missing_source_path)
    }
}

pub(crate) mod opencode_config {
    use std::path::PathBuf;

    use crate::context;

    pub(crate) fn get_opencode_db_path() -> PathBuf {
        context::opencode_database_path().unwrap_or_else(context::missing_source_path)
    }
}

pub(crate) mod omp_config {
    use std::io;
    use std::path::PathBuf;

    use crate::context;

    pub(crate) fn get_omp_data_dir() -> io::Result<PathBuf> {
        context::provider_config_dir("omp", &["sessions"])
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "未提供 Oh My Pi 来源"))
    }

    pub(crate) fn get_omp_agent_dir() -> io::Result<PathBuf> {
        context::provider_config_dir("omp", &["sessions"])
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "未提供 Oh My Pi 来源"))
    }

    pub(crate) fn get_omp_native_agent_dir() -> io::Result<PathBuf> {
        get_omp_agent_dir()
    }

    pub(crate) fn get_omp_active_profile() -> io::Result<Option<String>> {
        Ok(context::source_profile("omp"))
    }
}

pub(crate) mod pi_config {
    use std::io;
    use std::path::PathBuf;

    use crate::context;

    pub(crate) fn get_pi_agent_dir() -> io::Result<PathBuf> {
        context::provider_config_dir("pi", &["sessions"])
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "未提供 Pi 来源"))
    }
}

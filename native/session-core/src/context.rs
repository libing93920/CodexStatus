use std::cell::RefCell;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSpec {
    pub id: String,
    pub kind: String,
    pub path: PathBuf,
    #[serde(default)]
    pub database_path: Option<PathBuf>,
    #[serde(default)]
    pub config_path: Option<PathBuf>,
    #[serde(default)]
    pub layout: Option<String>,
    #[serde(default)]
    pub home: Option<PathBuf>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanIssue {
    pub path: String,
    pub message: String,
}

#[derive(Clone)]
struct RequestContext {
    source: SourceSpec,
    issues: Vec<ScanIssue>,
}

thread_local! {
    static CURRENT_CONTEXT: RefCell<Option<RequestContext>> = const { RefCell::new(None) };
}

struct RestoreContext(Option<RequestContext>);

impl Drop for RestoreContext {
    fn drop(&mut self) {
        CURRENT_CONTEXT.with(|current| {
            current.replace(self.0.take());
        });
    }
}

pub fn with_source<T>(source: &SourceSpec, run: impl FnOnce() -> T) -> T {
    with_source_issues(source, run).0
}

pub(crate) fn with_source_issues<T>(
    source: &SourceSpec,
    run: impl FnOnce() -> T,
) -> (T, Vec<ScanIssue>) {
    let previous = CURRENT_CONTEXT.with(|current| {
        current.replace(Some(RequestContext {
            source: source.clone(),
            issues: Vec::new(),
        }))
    });
    let _restore = RestoreContext(previous);
    let result = run();
    let issues = CURRENT_CONTEXT.with(|current| {
        current
            .borrow()
            .as_ref()
            .map(|context| context.issues.clone())
            .unwrap_or_default()
    });
    (result, issues)
}

pub(crate) fn current_source() -> Option<SourceSpec> {
    CURRENT_CONTEXT.with(|current| current.borrow().as_ref().map(|ctx| ctx.source.clone()))
}

pub(crate) fn source_root(kind: &str) -> Option<PathBuf> {
    current_source()
        .filter(|source| source.kind == kind)
        .map(|source| source.path)
}

pub(crate) fn source_layout(kind: &str) -> Option<String> {
    current_source()
        .filter(|source| source.kind == kind)
        .and_then(|source| source.layout)
}

pub(crate) fn source_database_path(kind: &str) -> Option<PathBuf> {
    let source = current_source().filter(|source| source.kind == kind)?;
    source
        .database_path
        .or_else(|| is_database_path(&source.path).then_some(source.path))
}

pub(crate) fn provider_config_dir(kind: &str, child_names: &[&str]) -> Option<PathBuf> {
    let source = current_source().filter(|source| source.kind == kind)?;
    if let Some(config) = source.config_path {
        return Some(config);
    }
    let path = source.path;
    if is_database_path(&path) {
        return path.parent().map(Path::to_path_buf);
    }
    if child_names.iter().any(|name| has_file_name(&path, name)) {
        return path.parent().map(Path::to_path_buf);
    }
    Some(path)
}

pub(crate) fn opencode_data_dir() -> Option<PathBuf> {
    let source = current_source().filter(|source| source.kind == "opencode")?;
    Some(opencode_storage_root(&source))
}

pub(crate) fn opencode_database_path() -> Option<PathBuf> {
    let source = current_source().filter(|source| source.kind == "opencode")?;
    Some(opencode_database(&source))
}

pub fn opencode_storage_root(source: &SourceSpec) -> PathBuf {
    if has_file_name(&source.path, "storage") {
        return source.path.clone();
    }
    let base = if is_database_path(&source.path) {
        source.path.parent().unwrap_or(&source.path)
    } else {
        &source.path
    };
    base.join("storage")
}

pub fn opencode_database(source: &SourceSpec) -> PathBuf {
    if let Some(database) = &source.database_path {
        return database.clone();
    }
    if is_database_path(&source.path) {
        return source.path.clone();
    }
    if has_file_name(&source.path, "storage") {
        return source
            .path
            .parent()
            .unwrap_or(&source.path)
            .join("opencode.db");
    }
    source.path.join("opencode.db")
}

pub fn codex_config_root(source: &SourceSpec) -> PathBuf {
    if let Some(config) = &source.config_path {
        return config.clone();
    }
    if ["sessions", "archived_sessions", "archived_sources"]
        .iter()
        .any(|name| has_file_name(&source.path, name))
    {
        return source.path.parent().unwrap_or(&source.path).to_path_buf();
    }
    source.path.clone()
}

pub(crate) fn home_dir() -> Option<PathBuf> {
    let source = current_source()?;
    source
        .home
        .or_else(|| {
            source
                .env
                .get("HOME")
                .or_else(|| source.env.get("USERPROFILE"))
                .map(|home| home.trim())
                .filter(|home| !home.is_empty())
                .map(PathBuf::from)
        })
        .or_else(|| {
            provider_config_dir(
                "codex",
                &["sessions", "archived_sessions", "archived_sources"],
            )?
            .parent()
            .map(Path::to_path_buf)
        })
}

pub(crate) fn source_profile(kind: &str) -> Option<String> {
    let source = current_source().filter(|source| source.kind == kind)?;
    let environment_profile = source
        .env
        .get("OMP_PROFILE")
        .or_else(|| source.env.get("PI_PROFILE"))
        .map(|profile| profile.trim().to_string())
        .filter(|profile| !profile.is_empty());
    if let Some(profile) = environment_profile {
        return (!profile.eq_ignore_ascii_case("default")).then_some(profile);
    }
    let mut components = source.path.components().peekable();
    while let Some(component) = components.next() {
        if component
            .as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case("profiles")
        {
            return components
                .next()
                .map(|profile| profile.as_os_str().to_string_lossy().into_owned())
                .filter(|profile| !profile.is_empty() && !profile.eq_ignore_ascii_case("default"));
        }
    }
    None
}

pub(crate) fn env_var(name: &str) -> Option<String> {
    current_source()?.env.get(name).cloned()
}

pub(crate) fn env_var_os(name: &str) -> Option<OsString> {
    env_var(name).map(OsString::from)
}

pub fn path_is_link(path: &Path) -> io::Result<bool> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Ok(true);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        Ok(metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

pub fn safe_entry(path: &Path) -> io::Result<bool> {
    if path_is_link(path)? {
        let issue = ScanIssue {
            path: path.to_string_lossy().into_owned(),
            message: "扫描跳过符号链接或 Windows reparse point".to_string(),
        };
        CURRENT_CONTEXT.with(|current| {
            if let Some(context) = current.borrow_mut().as_mut() {
                context.issues.push(issue.clone());
            }
        });
        log::warn!("{}: {}", issue.message, issue.path);
        return Ok(false);
    }
    Ok(true)
}

pub(crate) fn path_is_within_source(path: &Path) -> bool {
    let Some(source) = current_source() else {
        return false;
    };
    let Ok(root) = source.path.canonicalize() else {
        return false;
    };
    let Some(parent) = path.parent() else {
        return false;
    };
    let Ok(parent) = parent.canonicalize() else {
        return false;
    };
    parent.starts_with(root)
}

pub(crate) fn missing_source_path() -> PathBuf {
    PathBuf::from("\0")
}

fn is_database_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("db")
                || extension.eq_ignore_ascii_case("sqlite")
                || extension.eq_ignore_ascii_case("sqlite3")
        })
}

fn has_file_name(path: &Path, expected: &str) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case(expected))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(path: PathBuf) -> SourceSpec {
        SourceSpec {
            id: "source".into(),
            kind: "opencode".into(),
            path,
            database_path: None,
            config_path: None,
            layout: None,
            home: None,
            env: BTreeMap::new(),
        }
    }

    #[test]
    fn external_opencode_database_keeps_legacy_storage_under_source() {
        let mut source = source(PathBuf::from("C:/data/opencode"));
        source.database_path = Some(PathBuf::from("D:/external/opencode.db"));
        with_source(&source, || {
            assert_eq!(
                opencode_data_dir(),
                Some(PathBuf::from("C:/data/opencode/storage"))
            );
            assert_eq!(
                opencode_database_path(),
                Some(PathBuf::from("D:/external/opencode.db"))
            );
        });
    }

    #[test]
    fn request_environment_is_explicit_and_restored() {
        let mut source = source(PathBuf::from("C:/data/opencode"));
        source.env.insert("HOME".into(), "C:/request/home".into());
        with_source(&source, || {
            assert_eq!(env_var("HOME").as_deref(), Some("C:/request/home"));
        });
        assert_eq!(env_var("HOME"), None);
    }
}

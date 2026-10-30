use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use session_core::session_manager::{self, SessionMeta};
use session_core::{scan_source, scan_source_with_issues, with_source, SourceSpec};

use crate::{codex_policy, delete_policy, sqlite_policy};

const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRef {
    pub provider_id: String,
    pub source_id: String,
    pub session_id: String,
    pub source_path: String,
}

pub fn handle(line: &str) -> Value {
    if line.len() > MAX_REQUEST_BYTES {
        return json!({"id":null,"error":"请求超过安全上限"});
    }
    let request: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(_) => return json!({"id":null,"error":"无效的会话核心请求"}),
    };
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    match dispatch(&request) {
        Ok(value) => json!({"id":id,"result":value}),
        Err(error) => json!({"id":id,"error":error}),
    }
}

fn dispatch(request: &Value) -> Result<Value, String> {
    let source: SourceSpec = serde_json::from_value(request["source"].clone())
        .map_err(|_| "来源参数无效".to_string())?;
    let method = request["method"].as_str().ok_or("缺少操作名称")?;
    if method == "scan" {
        return scan(&source);
    }
    if method == "compact" {
        return sqlite_policy::compact(&source);
    }
    let session: SessionRef = serde_json::from_value(request["session"].clone())
        .map_err(|_| "会话参数无效".to_string())?;
    let meta = resolve_session(&source, &session)?;
    match method {
        "read" => read(&source, &session),
        "block" => block(&source, &session, request),
        "inspect" => {
            let inspected = delete_policy::inspect(&source, &meta)?;
            check_revision(request, &inspected.revision)?;
            Ok(inspected.preview(&session))
        }
        "delete" => {
            let expected = request["revision"]
                .as_str()
                .ok_or("缺少扫描版本，请重新扫描")?;
            delete_policy::delete(&source, &meta, &session, expected)
        }
        _ => Err("未知的会话核心操作".to_string()),
    }
}

fn scan(source: &SourceSpec) -> Result<Value, String> {
    let report = scan_source_with_issues(source)?;
    let metadata = report.sessions;
    let codex_revisions =
        (source.kind == "codex").then(|| codex_policy::ScanRevisions::load(source));
    let mut sessions = Vec::with_capacity(metadata.len());
    for meta in metadata {
        let Some(source_path) = meta.source_path.clone() else {
            continue;
        };
        let inspected = match &codex_revisions {
            Some(Ok(revisions)) => revisions.revision(&meta.session_id).and_then(|revision| {
                delete_policy::inspect_with_index(source, &meta, Some(revision))
            }),
            Some(Err(error)) => Err(error.clone()),
            None => delete_policy::inspect(source, &meta),
        };
        let allowed = delete_policy::supports_delete(&meta.provider_id);
        let reason = if !allowed {
            Some("此来源要求在原工具中删除，以保持索引和历史一致".to_string())
        } else {
            inspected.as_ref().err().cloned()
        };
        let revision = inspected
            .as_ref()
            .map(|item| item.revision.clone())
            .unwrap_or_default();
        let bytes = inspected.as_ref().map(|item| item.bytes).unwrap_or(0);
        let database = source_path.starts_with("sqlite:") || source.kind == "mcode";
        let storage_path = if source.kind == "mcode" {
            Some(source.path.join("v2/sqlite/runtime-state.sqlite"))
        } else {
            None
        };
        let mut value = json!({
            "providerId":meta.provider_id,"sourceId":source.id,
            "sessionId":meta.session_id,"sourcePath":source_path,
            "storagePath":storage_path,
            "title":meta.title,"summary":meta.summary,"projectDir":meta.project_dir,
            "createdAt":meta.created_at,"lastActiveAt":meta.last_active_at,
            "resumeCommand":meta.resume_command,
            "modelIds":[],"resourceIds":[],"revision":revision,
            "capabilities":{"read":true,"export":true,
                "delete":allowed && inspected.is_ok(),
                "resume":cfg!(windows) && meta.resume_command.is_some(),"deleteReason":reason},
            "storage":{"kind":if database {"sqlite"} else {"file"},
                "fileBytes":if database {0} else {bytes},"sharedBytes":0,
                "complete":inspected.is_ok()}
        });
        if let Some(object) = value.as_object_mut() {
            object.retain(|_, value| !value.is_null());
        }
        if let Some(capabilities) = value["capabilities"].as_object_mut() {
            capabilities.retain(|_, value| !value.is_null());
        }
        sessions.push(value);
    }
    Ok(json!({"sessions":sessions,"issues":report.issues}))
}

pub fn resolve_session(source: &SourceSpec, session: &SessionRef) -> Result<SessionMeta, String> {
    if source.id != session.source_id || source.kind != session.provider_id {
        return Err("会话与登记来源不匹配".to_string());
    }
    scan_source(source)?
        .into_iter()
        .find(|meta| {
            meta.provider_id == session.provider_id
                && meta.session_id == session.session_id
                && meta.source_path.as_deref() == Some(session.source_path.as_str())
        })
        .ok_or_else(|| "会话引用已失效或不属于登记来源，请重新扫描".to_string())
}

fn read(source: &SourceSpec, session: &SessionRef) -> Result<Value, String> {
    let messages = with_source(source, || {
        session_manager::content::validate_source(&session.provider_id, &session.source_path)?;
        session_manager::load_messages(&session.provider_id, &session.source_path)
    })?;
    let mut values = Vec::with_capacity(messages.len());
    for message in messages {
        let mut value = serde_json::to_value(&message).map_err(|error| error.to_string())?;
        // 上游在 blocks 存在时省略 content；这里明确提供可读文本投影给导出和搜索。
        value["content"] = Value::String(message.content);
        values.push(value);
    }
    Ok(json!({"messages":values,"resources":[]}))
}

fn block(source: &SourceSpec, session: &SessionRef, request: &Value) -> Result<Value, String> {
    let reference = serde_json::from_value(request["contentRef"].clone())
        .map_err(|_| "内容引用无效".to_string())?;
    let offset = request["offset"]
        .as_u64()
        .map(|value| u32::try_from(value))
        .transpose()
        .map_err(|_| "分页位置超出范围".to_string())?;
    with_source(source, || {
        let validated =
            session_manager::content::validate_source(&session.provider_id, &session.source_path)?;
        let full = session_manager::content::resolve_content_ref(&validated, &reference)?;
        serde_json::to_value(session_manager::content::paginate(&full, offset, None))
            .map_err(|error| error.to_string())
    })
}

pub fn check_revision(request: &Value, current: &str) -> Result<(), String> {
    let expected = request["revision"]
        .as_str()
        .ok_or("缺少扫描版本，请重新扫描")?;
    if expected != current {
        return Err("会话已变化，请重新扫描并生成删除预览".to_string());
    }
    Ok(())
}

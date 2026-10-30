use crate::file_policy::{self, text};
use rusqlite::{types::ValueRef, Connection, OpenFlags, TransactionBehavior};
use serde_json::{json, Value};
use session_core::SourceSpec;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::Duration;

const DATABASE_BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const SESSION_TABLES: &[(&str, &str)] = &[
    ("session", "id"),
    ("session_v2", "id"),
    ("message", "session_id"),
    ("part", "session_id"),
    ("session_message", "session_id"),
    ("todo", "session_id"),
    ("session_share", "session_id"),
    ("session_inbox", "session_id"),
    ("session_pending", "session_id"),
    ("instruction_entry", "session_id"),
    ("instruction_state", "session_id"),
    ("blob_ref", "session_id"),
    ("event", "aggregate_id"),
    ("event_sequence", "aggregate_id"),
    ("sessions", "id"),
    ("messages", "session_id"),
    ("threads", "id"),
    ("thread_dynamic_tools", "thread_id"),
    ("thread_attachments", "thread_id"),
    ("guardian_review_feedback", "thread_id"),
    ("local_runtime_sessions", "session_id"),
    ("local_runtime_messages", "session_id"),
    ("local_runtime_message_rows", "session_id"),
    ("local_runtime_message_row_migrations", "session_id"),
];

pub fn open_readonly(path: &Path) -> Result<Connection, String> {
    let connection =
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(text)?;
    connection
        .busy_timeout(DATABASE_BUSY_TIMEOUT)
        .map_err(text)?;
    Ok(connection)
}

pub fn fingerprint(connection: &Connection, session_id: &str) -> Result<String, String> {
    let mut digest = Sha256::new();
    for (table, key) in SESSION_TABLES {
        if !has_table(connection, table)? {
            continue;
        }
        let columns = columns(connection, table)?;
        if !columns.iter().any(|column| column == key) {
            continue;
        }
        digest.update(table.as_bytes());
        let mut statement = connection
            .prepare(&format!("SELECT * FROM \"{table}\" WHERE \"{key}\"=?1"))
            .map_err(text)?;
        let count = statement.column_count();
        let mut rows = statement.query([session_id]).map_err(text)?;
        let mut hashes = Vec::new();
        while let Some(row) = rows.next().map_err(text)? {
            let mut row_hash = Sha256::new();
            for index in 0..count {
                match row.get_ref(index).map_err(text)? {
                    ValueRef::Null => row_hash.update(b"null"),
                    ValueRef::Integer(value) => {
                        row_hash.update(b"int");
                        row_hash.update(value.to_le_bytes());
                    }
                    ValueRef::Real(value) => {
                        row_hash.update(b"real");
                        row_hash.update(value.to_le_bytes());
                    }
                    ValueRef::Text(value) => {
                        row_hash.update(b"text");
                        row_hash.update((value.len() as u64).to_le_bytes());
                        row_hash.update(value);
                    }
                    ValueRef::Blob(value) => {
                        row_hash.update(b"blob");
                        row_hash.update((value.len() as u64).to_le_bytes());
                        row_hash.update(value);
                    }
                }
            }
            hashes.push(format!("{:x}", row_hash.finalize()));
        }
        hashes.sort();
        for hash in hashes {
            digest.update(hash.as_bytes());
        }
    }
    Ok(format!("{:x}", digest.finalize()))
}

pub fn delete_opencode(options: DeleteOptions<'_>) -> Result<bool, String> {
    let mut connection =
        Connection::open_with_flags(options.path, OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(text)?;
    connection
        .busy_timeout(DATABASE_BUSY_TIMEOUT)
        .map_err(text)?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(text)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(text)?;
    if fingerprint(&transaction, options.session_id)? != options.expected_database_revision {
        return Err("数据库会话已变化，请重新扫描".to_string());
    }
    let hashes = selected_blob_hashes(&transaction, options.session_id)?;
    for table in [
        "part",
        "message",
        "session_message",
        "todo",
        "session_share",
        "blob_ref",
        "session_inbox",
        "session_pending",
        "instruction_entry",
        "instruction_state",
    ] {
        delete_matching(&transaction, table, "session_id", options.session_id)?;
    }
    delete_matching(&transaction, "event", "aggregate_id", options.session_id)?;
    delete_matching(
        &transaction,
        "event_sequence",
        "aggregate_id",
        options.session_id,
    )?;
    let deleted = delete_matching(&transaction, "session_v2", "id", options.session_id)?
        + delete_matching(&transaction, "session", "id", options.session_id)?;
    for hash in hashes {
        transaction.execute(
            "DELETE FROM blob WHERE hash=?1 AND NOT EXISTS(SELECT 1 FROM blob_ref WHERE hash=?1)",
            [hash],
        ).map_err(text)?;
    }
    transaction.commit().map_err(text)?;
    Ok(deleted > 0)
}

pub struct DeleteOptions<'a> {
    pub path: &'a Path,
    pub session_id: &'a str,
    pub expected_database_revision: &'a str,
}

pub fn delete_hermes(options: DeleteOptions<'_>) -> Result<bool, String> {
    let mut connection =
        Connection::open_with_flags(options.path, OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(text)?;
    connection
        .busy_timeout(DATABASE_BUSY_TIMEOUT)
        .map_err(text)?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(text)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(text)?;
    if fingerprint(&transaction, options.session_id)? != options.expected_database_revision {
        return Err("Hermes 会话已变化，请重新扫描".to_string());
    }
    delete_matching(&transaction, "messages", "session_id", options.session_id)?;
    let deleted = delete_matching(&transaction, "sessions", "id", options.session_id)?;
    transaction.commit().map_err(text)?;
    Ok(deleted > 0)
}

fn selected_blob_hashes(connection: &Connection, id: &str) -> Result<Vec<String>, String> {
    if !has_table(connection, "blob_ref")? || !has_table(connection, "blob")? {
        return Ok(Vec::new());
    }
    let mut statement = connection
        .prepare("SELECT DISTINCT hash FROM blob_ref WHERE session_id=?1")
        .map_err(text)?;
    let values = statement
        .query_map([id], |row| row.get(0))
        .map_err(text)?
        .collect::<Result<Vec<String>, _>>()
        .map_err(text)?;
    Ok(values)
}

pub fn has_table(connection: &Connection, table: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
            [table],
            |row| row.get(0),
        )
        .map_err(text)
}

pub fn columns(connection: &Connection, table: &str) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info(\"{table}\")"))
        .map_err(text)?;
    let result = statement
        .query_map([], |row| row.get(1))
        .map_err(text)?
        .collect::<Result<Vec<String>, _>>()
        .map_err(text)?;
    Ok(result)
}

pub fn delete_matching(
    connection: &Connection,
    table: &str,
    key: &str,
    id: &str,
) -> Result<usize, String> {
    if !has_table(connection, table)? {
        return Ok(0);
    }
    if !columns(connection, table)?
        .iter()
        .any(|column| column == key)
    {
        return Err(format!("关联表 {table} 的结构尚未识别，未执行删除"));
    }
    connection
        .execute(&format!("DELETE FROM \"{table}\" WHERE \"{key}\"=?1"), [id])
        .map_err(text)
}

pub fn compact(source: &SourceSpec) -> Result<Value, String> {
    if source.kind != "opencode" {
        return Err("此来源不支持数据库整理".to_string());
    }
    let database = session_core::context::opencode_database(source);
    file_policy::validate_database(source, &database)?;
    let before = std::fs::metadata(&database).map_err(text)?.len();
    let connection =
        Connection::open_with_flags(&database, OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(text)?;
    connection
        .busy_timeout(DATABASE_BUSY_TIMEOUT)
        .map_err(text)?;
    let busy: i64 = connection
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))
        .map_err(text)?;
    if busy != 0 {
        return Err("数据库仍在使用，未执行整理，请关闭原工具后重试".to_string());
    }
    connection.execute_batch("VACUUM").map_err(text)?;
    let busy_after: i64 = connection
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))
        .map_err(text)?;
    drop(connection);
    let after = std::fs::metadata(database).map_err(text)?.len();
    Ok(json!({"fileBytesBefore":before,"fileBytesAfter":after,
        "warning":if busy_after == 0 { None } else { Some("数据库已整理，但其他连接仍阻止截断 WAL") }}))
}

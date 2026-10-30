pub(crate) mod session_usage {
    const MAX_SESSION_DURATION_MS: i64 = 30 * 24 * 60 * 60 * 1000;

    pub(crate) fn estimated_latency_ms(start_ms: i64, end_ms: i64) -> Option<i64> {
        if start_ms <= 0 || end_ms <= start_ms {
            return None;
        }
        let duration_ms = end_ms - start_ms;
        (duration_ms <= MAX_SESSION_DURATION_MS).then_some(duration_ms)
    }
}

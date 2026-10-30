mod delete_policy;
mod codex_policy;
mod file_policy;
mod protocol;
mod sqlite_policy;

use std::io::{self, BufRead, Write};

fn main() {
    let input = io::stdin();
    let mut output = io::BufWriter::new(io::stdout().lock());
    for line in input.lock().lines() {
        let Ok(line) = line else { break };
        let response = protocol::handle(&line);
        if serde_json::to_writer(&mut output, &response).is_err()
            || writeln!(output).is_err()
            || output.flush().is_err()
        {
            break;
        }
    }
}

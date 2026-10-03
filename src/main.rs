use clap::{Args, Parser, Subcommand};
use daemon::{DaemonOpts, DEFAULT_IDLE_SECS};
use paths::Paths;

mod archive;
mod client;
mod daemon;
mod db;
mod embed;
mod log;
mod mcp;
mod parse;
mod paths;
mod project;
mod read;
mod search;
mod sync;
mod terms;

#[derive(Parser)]
#[command(name = "episodic-memory", version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

/// Test-only daemon knobs; `sync` and `mcp` forward them to a daemon they spawn.
#[derive(Args)]
struct Hidden {
    #[arg(long, hide = true, default_value_t = DEFAULT_IDLE_SECS)]
    idle_secs: u64,
    #[arg(long, hide = true)]
    fake_embedder: bool,
}

impl Hidden {
    fn opts(&self) -> DaemonOpts {
        DaemonOpts {
            idle_secs: self.idle_secs,
            fake_embedder: self.fake_embedder,
        }
    }
}

#[derive(Subcommand)]
enum Command {
    /// Sync transcripts into the memory index
    Sync(Hidden),
    /// Run the MCP server
    Mcp(Hidden),
    /// Run the background daemon
    Daemon(Hidden),
}

fn main() {
    let cli = Cli::parse();
    let paths = Paths::from_env();
    match cli.command {
        Command::Sync(h) => client::run_sync_hook(&paths, &h.opts()),
        Command::Mcp(h) => {
            if let Err(e) = client::run_mcp(&paths, &h.opts()) {
                log::log_line(&paths, &format!("mcp: {e:#}"));
                eprintln!("episodic-memory: {e:#}");
                std::process::exit(1);
            }
        }
        Command::Daemon(h) => {
            if let Err(e) = daemon::run(paths.clone(), h.opts()) {
                log::log_line(&paths, &format!("daemon: {e:#}"));
                std::process::exit(1);
            }
        }
    }
}

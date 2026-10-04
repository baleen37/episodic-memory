use clap::{Args, Parser, Subcommand};
use daemon::{DEFAULT_IDLE_SECS, DaemonOpts};
use paths::Paths;

mod archive;
mod client;
mod daemon;
mod db;
mod doctor;
mod embed;
mod host;
mod locks;
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

#[derive(Args)]
struct SyncArgs {
    #[command(flatten)]
    hidden: Hidden,
    /// Test-only: return after the daemon finishes the sync this call triggered.
    #[arg(long, hide = true)]
    wait: bool,
}

#[derive(Subcommand)]
enum Command {
    /// Sync transcripts into the memory index
    Sync(SyncArgs),
    /// Run the MCP server
    Mcp(Hidden),
    /// Run the background daemon
    Daemon(Hidden),
    /// Check the health of the plugin
    Doctor,
}

fn main() {
    let cli = Cli::parse();
    let paths = Paths::from_env();
    match cli.command {
        Command::Sync(a) if a.wait => {
            if let Err(e) = client::run_sync_wait(&paths, &a.hidden.opts()) {
                log::log_line(&paths, &format!("sync --wait: {e:#}"));
                eprintln!("episodic-memory: {e:#}");
                std::process::exit(1);
            }
        }
        Command::Sync(a) => client::run_sync_hook(&paths, &a.hidden.opts()),
        Command::Mcp(h) => {
            if let Err(e) = client::run_mcp(&paths, &h.opts()) {
                log::log_line(&paths, &format!("mcp: {e:#}"));
                eprintln!("episodic-memory: {e:#}");
                std::process::exit(1);
            }
        }
        Command::Doctor => {
            let checks = doctor::run_checks(&paths);
            for c in &checks {
                println!("{c}");
            }
            if checks.iter().any(|c| c.level == doctor::Level::Fail) {
                std::process::exit(1);
            }
        }
        Command::Daemon(h) => {
            if let Err(e) = daemon::run(&paths, h.opts()) {
                log::log_line(&paths, &format!("daemon: {e:#}"));
                std::process::exit(1);
            }
        }
    }
}

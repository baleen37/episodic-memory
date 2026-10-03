use clap::{Parser, Subcommand};

mod db;
mod log;
mod paths;
mod terms;

#[derive(Parser)]
#[command(name = "episodic-memory", version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Sync transcripts into the memory index
    Sync,
    /// Run the MCP server
    Mcp,
    /// Run the background daemon
    Daemon,
}

fn main() {
    let cli = Cli::parse();
    match cli.command {
        Command::Sync | Command::Mcp | Command::Daemon => println!("not implemented"),
    }
}

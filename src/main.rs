use clap::{Parser, Subcommand};

mod archive;
mod db;
mod embed;
mod log;
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

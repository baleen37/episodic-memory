// Command memmem is the CLI entrypoint for the Go port of memmem.
//
// Ports src/cli/main.ts (the router and arg parsing). Subcommand logic lives in
// the internal/cli package so it stays unit-testable.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/baleen37/memmem/internal/cli"
)

func main() {
	os.Exit(run(os.Args[1:]))
}

// run dispatches the command and returns a process exit code.
func run(args []string) int {
	var command string
	if len(args) > 0 {
		command = args[0]
	}

	if command == "" || command == "--help" || command == "-h" {
		fmt.Println(cli.HelpText())
		return 0
	}

	ctx := context.Background()

	switch command {
	case "sync":
		return fail(cli.RunSyncCli(ctx))
	case "search":
		parsed, err := cli.ParseSearchArgs(args)
		if err != nil {
			return failMessage(err)
		}
		return fail(cli.RunSearchCli(ctx, os.Stdout, parsed))
	case "read":
		parsed, err := cli.ParseReadArgs(args)
		if err != nil {
			return failMessage(err)
		}
		if err := cli.RunReadCli(os.Stdout, parsed); err != nil {
			fmt.Fprintln(os.Stderr, err.Error())
			return 1
		}
		return 0
	case "stats":
		return fail(cli.RunStatsCli(os.Stdout))
	case "verify":
		if err := cli.RunVerifyCli(os.Stdout); err != nil {
			if errors.Is(err, cli.ErrVerifyIssues) {
				return 1
			}
			fmt.Fprintln(os.Stderr, err.Error())
			return 1
		}
		return 0
	case "doctor":
		if err := cli.RunDoctorCli(os.Stdout); err != nil {
			if errors.Is(err, cli.ErrDoctorFail) {
				return 1
			}
			fmt.Fprintln(os.Stderr, err.Error())
			return 1
		}
		return 0
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n", command)
		fmt.Fprintln(os.Stderr, "Run with --help for usage information.")
		return 1
	}
}

func fail(err error) int {
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		return 1
	}
	return 0
}

func failMessage(err error) int {
	fmt.Fprintln(os.Stderr, err.Error())
	return 1
}

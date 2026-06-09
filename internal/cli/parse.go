// Package cli implements the memmem command-line interface: the router, arg
// parsing, the sync flow, and the search/read/stats/verify/doctor commands.
// Ports src/cli/.
package cli

import (
	"errors"
	"strconv"
	"strings"
)

// SearchArgs holds parsed `search` arguments. A zero *int / "" string means the
// flag was not provided (mirrors TS optional fields).
type SearchArgs struct {
	Query      string
	Limit      int // 0 means unset
	After      string
	Before     string
	SourceKind string
}

// ReadArgs holds parsed `read` arguments.
type ReadArgs struct {
	Path      string
	StartLine int
	EndLine   int
}

// requireOptionValue returns the value at index+1, requiring it to exist and not
// start with "--". Ports requireOptionValue.
func requireOptionValue(args []string, index int, flag string) (string, error) {
	if index+1 >= len(args) {
		return "", errors.New(flag + " requires a value")
	}
	value := args[index+1]
	if value == "" || strings.HasPrefix(value, "--") {
		return "", errors.New(flag + " requires a value")
	}
	return value, nil
}

// parsePositiveInteger parses value as an integer > 0. Ports parsePositiveInteger.
func parsePositiveInteger(value, flag string) (int, error) {
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return 0, errors.New(flag + " must be a positive integer")
	}
	return parsed, nil
}

// ParseSearchArgs parses `search` args (args[0] is the command name). Ports
// parseSearchArgs.
func ParseSearchArgs(args []string) (SearchArgs, error) {
	parsed := SearchArgs{}
	var queryParts []string

	for i := 1; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--after":
			v, err := requireOptionValue(args, i, arg)
			if err != nil {
				return SearchArgs{}, err
			}
			parsed.After = v
			i++
		case arg == "--before":
			v, err := requireOptionValue(args, i, arg)
			if err != nil {
				return SearchArgs{}, err
			}
			parsed.Before = v
			i++
		case arg == "--source-kind":
			v, err := requireOptionValue(args, i, arg)
			if err != nil {
				return SearchArgs{}, err
			}
			parsed.SourceKind = v
			i++
		case arg == "--limit":
			v, err := requireOptionValue(args, i, arg)
			if err != nil {
				return SearchArgs{}, err
			}
			n, err := parsePositiveInteger(v, arg)
			if err != nil {
				return SearchArgs{}, err
			}
			parsed.Limit = n
			i++
		case strings.HasPrefix(arg, "--"):
			return SearchArgs{}, errors.New("Unknown option: " + arg)
		default:
			queryParts = append(queryParts, arg)
		}
	}

	parsed.Query = strings.TrimSpace(strings.Join(queryParts, " "))
	if parsed.Query == "" {
		return SearchArgs{}, errors.New("search requires a query")
	}

	return parsed, nil
}

// ParseReadArgs parses `read` args (args[0] is the command name). Ports
// parseReadArgs.
func ParseReadArgs(args []string) (ReadArgs, error) {
	if len(args) < 2 || args[1] == "" || strings.HasPrefix(args[1], "--") {
		return ReadArgs{}, errors.New("read requires a path")
	}
	parsed := ReadArgs{Path: args[1]}
	hasStart, hasEnd := false, false

	for i := 2; i < len(args); i++ {
		arg := args[i]
		switch arg {
		case "--start-line":
			v, err := requireOptionValue(args, i, arg)
			if err != nil {
				return ReadArgs{}, err
			}
			n, err := parsePositiveInteger(v, arg)
			if err != nil {
				return ReadArgs{}, err
			}
			parsed.StartLine = n
			hasStart = true
			i++
		case "--end-line":
			v, err := requireOptionValue(args, i, arg)
			if err != nil {
				return ReadArgs{}, err
			}
			n, err := parsePositiveInteger(v, arg)
			if err != nil {
				return ReadArgs{}, err
			}
			parsed.EndLine = n
			hasEnd = true
			i++
		default:
			return ReadArgs{}, errors.New("Unknown option: " + arg)
		}
	}

	if !hasStart || !hasEnd {
		return ReadArgs{}, errors.New("read requires --start-line and --end-line")
	}
	if parsed.StartLine > parsed.EndLine {
		return ReadArgs{}, errors.New("--start-line must be less than or equal to --end-line")
	}

	return parsed, nil
}

// HelpText returns the CLI help text. Ports getHelpText.
func HelpText() string {
	return `
memmem - Event/fact memory for Claude Code and Codex transcripts

USAGE:
  memmem <command>

COMMANDS:
  sync      Copy transcripts and extract memory records
  search    Search indexed memory records
  read      Read archived transcript lines
  stats     Print memory index statistics
  verify    Verify memory index integrity
  doctor    Diagnose build, index, and data health

SEARCH OPTIONS:
  --limit <number>        Maximum number of results
  --after <YYYY-MM-DD>    Only include records after this date
  --before <YYYY-MM-DD>   Only include records before this date
  --source-kind <kind>    Filter by transcript source kind

READ OPTIONS:
  --start-line <number>   First archive line to read (required)
  --end-line <number>     Last archive line to read (required)

EXAMPLES:
  memmem search "source of truth" --limit 5
  memmem read /archive/session.jsonl --start-line 3 --end-line 8

ENVIRONMENT VARIABLES:
  CONVERSATION_MEMORY_CONFIG_DIR   Override config directory
  CONVERSATION_MEMORY_DB_PATH      Override database path
`
}

package search

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// isoDateRegex matches the strict YYYY-MM-DD shape (ports the TS isoDateRegex).
var isoDateRegex = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// isValidCalendarDate reports whether dateStr names a real calendar date in UTC.
// Ports isValidCalendarDate: it constructs Date.UTC(y, m-1, d) and checks the
// components round-trip (so 2025-02-30 — which JS normalizes to March 2 — is
// rejected).
func isValidCalendarDate(dateStr string) bool {
	y, m, d, ok := parseISOParts(dateStr)
	if !ok {
		return false
	}
	// time.Date normalizes overflow exactly like Date.UTC, so the round-trip
	// check (2025-02-30 -> 2025-03-02) matches the TS implementation.
	t := time.Date(y, time.Month(m), d, 0, 0, 0, 0, time.UTC)
	return t.Year() == y && int(t.Month()) == m && t.Day() == d
}

// validateISODate ports validateISODate: it throws (returns an error) with the
// exact TS message format on a malformed shape or an unreal calendar date.
func validateISODate(dateStr, paramName string) error {
	if !isoDateRegex.MatchString(dateStr) {
		return fmt.Errorf(
			`Invalid %s date: %q. Expected YYYY-MM-DD format (e.g., 2025-10-01)`,
			paramName, dateStr,
		)
	}
	if !isValidCalendarDate(dateStr) {
		return fmt.Errorf(`Invalid %s date: %q. Not a valid calendar date.`, paramName, dateStr)
	}
	return nil
}

// parseISOParts splits an ISO date into integer parts. It does not validate the
// shape (callers validate via the regex first); it mirrors the TS
// `isoDate.split('-').map(Number)`.
func parseISOParts(isoDate string) (year, month, day int, ok bool) {
	parts := strings.Split(isoDate, "-")
	if len(parts) != 3 {
		return 0, 0, 0, false
	}
	var err error
	if year, err = strconv.Atoi(parts[0]); err != nil {
		return 0, 0, 0, false
	}
	if month, err = strconv.Atoi(parts[1]); err != nil {
		return 0, 0, 0, false
	}
	if day, err = strconv.Atoi(parts[2]); err != nil {
		return 0, 0, 0, false
	}
	return year, month, day, true
}

// isoToTimestamp ports isoToTimestamp: Date.UTC(y, m-1, d) in milliseconds.
func isoToTimestamp(isoDate string) int64 {
	y, m, d, _ := parseISOParts(isoDate)
	return time.Date(y, time.Month(m), d, 0, 0, 0, 0, time.UTC).UnixMilli()
}

// isoToExclusiveNextDayTimestamp ports isoToExclusiveNextDayTimestamp:
// Date.UTC(y, m-1, d+1) in milliseconds. time.Date normalizes the d+1 overflow
// (e.g. 2026-05-31 -> 2026-06-01) exactly like Date.UTC.
func isoToExclusiveNextDayTimestamp(isoDate string) int64 {
	y, m, d, _ := parseISOParts(isoDate)
	return time.Date(y, time.Month(m), d+1, 0, 0, 0, 0, time.UTC).UnixMilli()
}

// escapeLikePattern escapes the LIKE metacharacters \, %, and _ with a leading
// backslash so a literal is matched under `ESCAPE '\'`. Ports escapeLikePattern.
func escapeLikePattern(value string) string {
	var b strings.Builder
	for _, r := range value {
		if r == '\\' || r == '%' || r == '_' {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}

// makeLikePattern wraps an escaped value in % … % for a contains match.
// Ports makeLikePattern.
func makeLikePattern(value string) string {
	return "%" + escapeLikePattern(value) + "%"
}

// filterParts is the SQL fragment + bound params produced from the filter
// options. Ports the TS FilterParts.
type filterParts struct {
	clause     string
	params     []any
	hasFilters bool
}

// buildFilterParts ports buildFilterParts: it assembles the additional WHERE
// clause (prefixed with "AND ") and the ordered bind params for the active
// after / before / sourceKind / projects / files filters. The order of clauses
// and params matches the TS implementation exactly, since the params are bound
// positionally between the vec/text fixed params and the trailing LIMIT.
func buildFilterParts(opts Options) filterParts {
	var filters []string
	var params []any

	if opts.After != "" {
		filters = append(filters, "m.observed_at >= ?")
		params = append(params, isoToTimestamp(opts.After))
	}

	if opts.Before != "" {
		filters = append(filters, "m.observed_at < ?")
		params = append(params, isoToExclusiveNextDayTimestamp(opts.Before))
	}

	if opts.SourceKind != "" {
		filters = append(filters, "m.source_kind = ?")
		params = append(params, opts.SourceKind)
	}

	if len(opts.Projects) > 0 {
		ph := make([]string, len(opts.Projects))
		for i, p := range opts.Projects {
			ph[i] = "?"
			params = append(params, p)
		}
		filters = append(filters, "m.project IN ("+strings.Join(ph, ", ")+")")
	}

	if len(opts.Files) > 0 {
		fileFilters := make([]string, len(opts.Files))
		for i, file := range opts.Files {
			fileFilters[i] = "(\n        m.archive_path LIKE ? ESCAPE '\\'\n        OR m.text LIKE ? ESCAPE '\\'\n      )"
			pattern := makeLikePattern(file)
			params = append(params, pattern, pattern)
		}
		filters = append(filters, "("+strings.Join(fileFilters, " OR ")+")")
	}

	if len(filters) == 0 {
		return filterParts{clause: "", params: nil, hasFilters: false}
	}
	return filterParts{
		clause:     "AND " + strings.Join(filters, " AND "),
		params:     params,
		hasFilters: true,
	}
}

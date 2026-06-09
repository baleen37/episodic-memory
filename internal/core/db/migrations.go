package db

import (
	"database/sql"
	"fmt"
	"sort"
)

// Migration is a versioned, ordered DDL/backfill step. Ports
// src/core/migrations/types.ts. up() owns its own transaction boundaries.
type Migration struct {
	Version int
	Name    string
	Up      func(db *sql.DB) error
}

// migrations is the ordered registry. New migrations append with the next
// version number. Ports src/core/migrations/index.ts MIGRATIONS.
var migrations = []Migration{projectColumnsMigration}

func getUserVersion(db *sql.DB) (int, error) {
	var v int
	if err := db.QueryRow("PRAGMA user_version").Scan(&v); err != nil {
		return 0, fmt.Errorf("read user_version: %w", err)
	}
	return v, nil
}

// runMigrationsWith runs the given migrations whose version exceeds the DB's
// current user_version, in ascending order, bumping user_version after each.
// Ports runMigrationsWith. Exposed for tests via RunMigrationsWith.
func runMigrationsWith(db *sql.DB, ms []Migration) error {
	current, err := getUserVersion(db)
	if err != nil {
		return err
	}
	pending := append([]Migration(nil), ms...)
	sort.Slice(pending, func(i, j int) bool { return pending[i].Version < pending[j].Version })
	for _, m := range pending {
		if m.Version <= current {
			continue
		}
		if err := m.Up(db); err != nil {
			return fmt.Errorf("migration %d (%s): %w", m.Version, m.Name, err)
		}
		// PRAGMA cannot be parameterized; version is a trusted integer.
		if _, err := db.Exec(fmt.Sprintf("PRAGMA user_version = %d", m.Version)); err != nil {
			return fmt.Errorf("set user_version %d: %w", m.Version, err)
		}
	}
	return nil
}

// runMigrations runs the production registry. Ports runMigrations.
func runMigrations(db *sql.DB) error {
	return runMigrationsWith(db, migrations)
}

// RunMigrationsWith is a test-facing wrapper over runMigrationsWith.
func RunMigrationsWith(db *sql.DB, ms []Migration) error {
	return runMigrationsWith(db, ms)
}

// projectColumnsMigration ports src/core/migrations/001-project-columns.ts.
//
// The schema step (ensuring the project_name column) is ported faithfully and
// is a no-op on databases created by this package, since createSchema already
// declares project_name. The data backfill in the TS migration reads each
// archived transcript's cwd and resolves it to project/project_name; that
// depends on the project-resolution and archive-reading modules, which are not
// part of the db package. The backfill is therefore left unimplemented here
// (it only affects legacy rows with project IS NULL) and will be wired in when
// those modules are ported.
var projectColumnsMigration = Migration{
	Version: 1,
	Name:    "project-columns",
	Up: func(db *sql.DB) error {
		has, err := hasColumn(db, "memory_records", "project_name")
		if err != nil {
			return err
		}
		if !has {
			if _, err := db.Exec(`ALTER TABLE memory_records ADD COLUMN project_name TEXT`); err != nil {
				return fmt.Errorf("add project_name: %w", err)
			}
		}
		return nil
	},
}

package cli

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/baleen37/memmem/internal/core/db"
	"github.com/baleen37/memmem/internal/core/indexer"
	"github.com/baleen37/memmem/internal/core/lock"
	"github.com/baleen37/memmem/internal/core/logger"
	"github.com/baleen37/memmem/internal/core/paths"
	"github.com/baleen37/memmem/internal/core/sources"
	"github.com/baleen37/memmem/internal/llm"
)

// SyncResult accumulates the outcome of a sync run. Ports the TS SyncResult.
type SyncResult struct {
	Copied               int
	Archived             int
	SpansConsidered      int
	SpansSkipped         int
	SpansEmpty           int
	SpansErrored         int
	MemoryRecordsIndexed int
}

type archiveFile struct {
	adapter     sources.SourceAdapter
	archivePath string
}

// SyncTranscripts copies transcripts from each source adapter root into the
// archive and reindexes the archive. Ports syncTranscripts.
//
// indexerOpts is passed through to indexer.ReindexArchiveFile; tests inject a
// mock embedder via opts.Embedder. Production passes the zero value.
func SyncTranscripts(ctx context.Context, database *sql.DB, indexerOpts indexer.Options) (SyncResult, error) {
	archiveDir, err := paths.ArchiveDir()
	if err != nil {
		return SyncResult{}, err
	}
	// Preserve insertion order so progress logging and reindex order are stable.
	order := []string{}
	archiveFiles := map[string]archiveFile{}
	setArchive := func(p string, af archiveFile) {
		if _, ok := archiveFiles[p]; !ok {
			order = append(order, p)
		}
		archiveFiles[p] = af
	}
	deleteArchive := func(p string) {
		if _, ok := archiveFiles[p]; ok {
			delete(archiveFiles, p)
			for i, v := range order {
				if v == p {
					order = append(order[:i], order[i+1:]...)
					break
				}
			}
		}
	}

	provider := loadExtractionProvider()
	result := SyncResult{}

	for _, adapter := range sources.BuiltInSourceAdapters() {
		for _, root := range adapter.Roots() {
			var excludedSourceDirs []string
			for _, sourcePath := range findJsonlFiles(root, adapter, &excludedSourceDirs) {
				rel, relErr := filepath.Rel(root, sourcePath)
				if relErr != nil {
					rel = sourcePath
				}
				archivePath := filepath.Join(archiveDir, adapter.Kind(), rel)
				copied, copyErr := copyIfNewer(sourcePath, archivePath)
				if copyErr != nil {
					logger.Warn("Failed to copy transcript; continuing sync.", map[string]any{
						"sourcePath":  sourcePath,
						"archivePath": archivePath,
						"error":       copyErr.Error(),
					})
				} else if copied {
					result.Copied++
				}
				if fileExists(archivePath) {
					setArchive(archivePath, archiveFile{adapter: adapter, archivePath: archivePath})
				}
			}

			for _, sourceDir := range excludedSourceDirs {
				rel, relErr := filepath.Rel(root, sourceDir)
				if relErr != nil {
					rel = sourceDir
				}
				archivePathPrefix := filepath.Join(archiveDir, adapter.Kind(), rel)
				if err := purgeExcludedArchiveSubtree(database, archivePathPrefix, archiveFiles, deleteArchive); err != nil {
					return SyncResult{}, err
				}
			}
		}

		adapterArchiveRoot := filepath.Join(archiveDir, adapter.Kind())
		if dirExists(adapterArchiveRoot) {
			for _, archivePath := range findJsonlFiles(adapterArchiveRoot, adapter, nil) {
				setArchive(archivePath, archiveFile{adapter: adapter, archivePath: archivePath})
			}
		}
	}

	total := len(order)
	if total > 0 {
		suffix := "s"
		if total == 1 {
			suffix = ""
		}
		logger.Info(fmt.Sprintf("Indexing %d archive file%s...", total, suffix), nil)
	}

	archived := 0
	progressInterval := total / 20
	if progressInterval < 1 {
		progressInterval = 1
	}
	for _, key := range order {
		file := archiveFiles[key]
		reindexResult, err := indexer.ReindexArchiveFile(
			ctx, database, file.archivePath, file.adapter.Kind(), file.adapter.Parse, provider, indexerOpts)
		if err != nil {
			return SyncResult{}, err
		}
		result.SpansConsidered += reindexResult.SpansConsidered
		result.SpansSkipped += reindexResult.SpansSkipped
		result.SpansEmpty += reindexResult.SpansEmpty
		result.SpansErrored += reindexResult.SpansErrored
		result.MemoryRecordsIndexed += reindexResult.MemoryRecordsIndexed
		archived++
		if archived%progressInterval == 0 || archived == total {
			logger.Info(fmt.Sprintf("  %d/%d indexed", archived, total), nil)
		}
	}

	result.Archived = archived
	return result, nil
}

// RunSyncCli is the `sync` command. Ports runSyncCli.
func RunSyncCli(ctx context.Context) error {
	release := lock.AcquireSyncLock()
	if release == nil {
		logger.Info("sync already running; skipping", nil)
		return nil
	}
	defer release()

	dbPath, err := paths.DBPath()
	if err != nil {
		return err
	}
	database, err := db.OpenDatabase(dbPath)
	if err != nil {
		return err
	}
	defer database.Close()

	result, err := SyncTranscripts(ctx, database, indexer.Options{})
	if err != nil {
		return err
	}
	logger.Info("Done.", map[string]any{
		"copied":               result.Copied,
		"archived":             result.Archived,
		"spansConsidered":      result.SpansConsidered,
		"spansSkipped":         result.SpansSkipped,
		"spansEmpty":           result.SpansEmpty,
		"spansErrored":         result.SpansErrored,
		"memoryRecordsIndexed": result.MemoryRecordsIndexed,
	})
	return nil
}

// loadExtractionProvider loads the LLM provider, returning nil on any error so
// sync works without a configured provider (extraction is skipped). Ports
// loadExtractionProvider.
func loadExtractionProvider() llm.Provider {
	cfg, err := llm.LoadConfig()
	if err != nil || cfg == nil {
		return nil
	}
	provider, err := llm.CreateProvider(*cfg)
	if err != nil {
		return nil
	}
	return provider
}

// findJsonlFiles recursively collects .jsonl files under root that the adapter
// detects. A directory containing a .no-memmem marker is excluded (pushed to
// *excludedDirs when non-nil) and not descended into. Ports findJsonlFiles.
func findJsonlFiles(root string, adapter sources.SourceAdapter, excludedDirs *[]string) []string {
	var files []string
	if fileExists(filepath.Join(root, ".no-memmem")) {
		if excludedDirs != nil {
			*excludedDirs = append(*excludedDirs, root)
		}
		return files
	}

	entries, err := os.ReadDir(root)
	if err != nil {
		return files
	}
	for _, entry := range entries {
		entryPath := filepath.Join(root, entry.Name())
		if entry.IsDir() {
			files = append(files, findJsonlFiles(entryPath, adapter, excludedDirs)...)
		} else if entry.Type().IsRegular() && strings.HasSuffix(entryPath, ".jsonl") && adapter.Detect(entryPath) {
			files = append(files, entryPath)
		}
	}
	return files
}

// purgeExcludedArchiveSubtree removes the memory index and archive files under
// an excluded source subtree. Ports purgeExcludedArchiveSubtree.
func purgeExcludedArchiveSubtree(
	database *sql.DB,
	archivePathPrefix string,
	archiveFiles map[string]archiveFile,
	deleteArchive func(string),
) error {
	if err := db.DeleteMemoryIndexForArchivePathPrefix(database, archivePathPrefix); err != nil {
		return err
	}
	for archivePath := range archiveFiles {
		if isPathAtOrUnder(archivePath, archivePathPrefix) {
			deleteArchive(archivePath)
		}
	}
	if pathExists(archivePathPrefix) {
		_ = os.RemoveAll(archivePathPrefix)
	}
	return nil
}

// isPathAtOrUnder reports whether filePath is parentPath or below it. Ports
// isPathAtOrUnder.
func isPathAtOrUnder(filePath, parentPath string) bool {
	rel, err := filepath.Rel(parentPath, filePath)
	if err != nil {
		return false
	}
	return rel == "" || rel == "." || (!strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel))
}

// copyIfNewer atomically copies sourcePath to destinationPath if the source is
// newer. It re-stats the source after copying and discards the copy if the
// source changed mid-copy. Returns whether a copy occurred. Ports copyIfNewer.
func copyIfNewer(sourcePath, destinationPath string) (bool, error) {
	sourceBefore, err := os.Stat(sourcePath)
	if err != nil {
		return false, err
	}
	if destInfo, err := os.Stat(destinationPath); err == nil {
		if !destInfo.ModTime().Before(sourceBefore.ModTime()) {
			return false, nil
		}
	}

	if err := os.MkdirAll(filepath.Dir(destinationPath), 0o755); err != nil {
		return false, err
	}
	tmpPath := fmt.Sprintf("%s.tmp-%d-%d", destinationPath, os.Getpid(), nowNanos())
	if err := copyFile(sourcePath, tmpPath); err != nil {
		_ = os.Remove(tmpPath)
		return false, err
	}

	sourceAfter, err := os.Stat(sourcePath)
	if err != nil {
		_ = os.Remove(tmpPath)
		return false, err
	}
	if sourceBefore.Size() != sourceAfter.Size() || !sourceBefore.ModTime().Equal(sourceAfter.ModTime()) {
		_ = os.Remove(tmpPath)
		return false, nil
	}

	if err := os.Rename(tmpPath, destinationPath); err != nil {
		_ = os.Remove(tmpPath)
		return false, err
	}
	return true, nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func fileExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}

func dirExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}

func pathExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

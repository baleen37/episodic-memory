//go:build !embedmodel

package main

// Default build: model NOT embedded. It is loaded from the on-disk .cache
// (representing the "download model on first run" escape hatch).

const modelEmbedded = false

func modelBytes() []byte { return nil }

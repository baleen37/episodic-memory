package main

import _ "embed"

// Always embedded: the onnxruntime dylib (runtime-loaded by path) and the
// tokenizer.json (runtime-read by path). These are small relative to the model.

//go:embed embedded/libonnxruntime.dylib
var dylibBytes []byte

//go:embed embedded/tokenizer.json
var tokenizerBytes []byte

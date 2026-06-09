//go:build embedmodel

package main

import _ "embed"

// Built with `-tags embedmodel`: the 235MB ONNX model is embedded in the binary.

//go:embed embedded/model_fp16.onnx
var modelData []byte

const modelEmbedded = true

func modelBytes() []byte { return modelData }

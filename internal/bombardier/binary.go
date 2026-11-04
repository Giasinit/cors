package bombardier

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sync"
)

const Revision = "2d495aca5b233bec0a5334dc4aa3cbdaef6e1bc5"

//go:embed assets/*
var assets embed.FS

var binaryOnce sync.Once
var binaryPath string
var binaryError error

func bundledBinary() (string, error) {
	binaryOnce.Do(func() {
		binaryPath, binaryError = extractBinary()
	})
	return binaryPath, binaryError
}

func extractBinary() (string, error) {
	if runtime.GOOS != "linux" {
		return "", fmt.Errorf("bundled Bombardier requires Linux")
	}
	name := "bombardier-linux-" + runtime.GOARCH + ".gz"
	compressed, err := assets.ReadFile("assets/" + name)
	if err != nil {
		return "", err
	}
	var manifest struct {
		Artifacts []struct{ File, Sha256 string }
	}
	raw, _ := assets.ReadFile("assets/provenance.json")
	if err = json.Unmarshal(raw, &manifest); err != nil {
		return "", err
	}
	expected := ""
	for _, entry := range manifest.Artifacts {
		if entry.File == name {
			expected = entry.Sha256
		}
	}
	reader, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		return "", err
	}
	defer reader.Close()
	contents, err := io.ReadAll(io.LimitReader(reader, 32*1024*1024+1))
	if err != nil || len(contents) > 32*1024*1024 {
		return "", fmt.Errorf("invalid bundled executable")
	}
	digest := sha256.Sum256(contents)
	if expected == "" || hex.EncodeToString(digest[:]) != expected {
		return "", fmt.Errorf("executable checksum mismatch")
	}
	directory, err := os.MkdirTemp("", "cors-bombardier-")
	if err != nil {
		return "", err
	}
	path := filepath.Join(directory, "bombardier")
	if err = os.WriteFile(path, contents, 0700); err != nil {
		os.RemoveAll(directory)
		return "", err
	}
	return path, nil
}

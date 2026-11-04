package bombardier

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata"
)

const detailURL = "https://salabluplus.rfi.it:8443/pic/v2/GetTrainDetailsWtime"

var numberPattern = regexp.MustCompile(`^[0-9]{1,8}$`)
var rome, _ = time.LoadLocation("Europe/Rome")

// Overrides are server-code only, for loopback tests of the actual executable.
type Handler struct {
	Binary         func() (string, error)
	Endpoint       string
	CA             []byte
	Deadline       time.Duration
	RequestTimeout time.Duration
}

type boundedBuffer struct {
	bytes.Buffer
	limit     int
	truncated bool
}

func (b *boundedBuffer) Write(data []byte) (int, error) {
	n := len(data)
	left := b.limit - b.Len()
	if n > left {
		data = data[:left]
		b.truncated = true
	}
	_, _ = b.Buffer.Write(data)
	return n, nil
}

func reply(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func queryOptions(q url.Values, now time.Time) (string, string, string, int, bool, error) {
	for name, values := range q {
		if len(values) != 1 || !strings.Contains("|number|date|client|c|keepalive|mode|", "|"+name+"|") {
			return "", "", "", 0, false, fmt.Errorf("unknown or repeated parameter: %s", name)
		}
	}
	number := q.Get("number")
	if !numberPattern.MatchString(number) {
		return "", "", "", 0, false, fmt.Errorf("number must contain 1-8 digits")
	}
	date := q.Get("date")
	if date == "" {
		date = now.In(rome).Format("2006-01-02")
	}
	if parsed, err := time.Parse("2006-01-02", date); err != nil || parsed.Format("2006-01-02") != date {
		return "", "", "", 0, false, fmt.Errorf("invalid date; use YYYY-MM-DD")
	}
	client := q.Get("client")
	if client == "" {
		client = "http1"
	}
	if client != "http1" && client != "fasthttp" {
		return "", "", "", 0, false, fmt.Errorf("client must be http1 or fasthttp")
	}
	connections := 1
	if q.Has("c") {
		var err error
		connections, err = strconv.Atoi(q.Get("c"))
		if err != nil || connections < 1 || connections > 20 {
			return "", "", "", 0, false, fmt.Errorf("c must be 1-20")
		}
	}
	keepalive := q.Get("keepalive") == "1"
	if q.Has("keepalive") && q.Get("keepalive") != "0" && !keepalive {
		return "", "", "", 0, false, fmt.Errorf("keepalive must be 0 or 1")
	}
	if q.Has("mode") && q.Get("mode") != "run" {
		return "", "", "", 0, false, fmt.Errorf("mode must be run or info")
	}
	return number, date, client, connections, keepalive, nil
}

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Benchmark-Runtime", "go-bombardier")
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET, OPTIONS")
		reply(w, 405, map[string]string{"error": "METHOD_NOT_ALLOWED"})
		return
	}
	q, queryErr := url.ParseQuery(r.URL.RawQuery)
	info := len(q) == 1 && len(q["mode"]) == 1 && q.Get("mode") == "info"
	var number, date, client string
	var connections int
	var keepalive bool
	if queryErr == nil && !info {
		number, date, client, connections, keepalive, queryErr = queryOptions(q, time.Now())
	}
	if queryErr != nil {
		reply(w, 400, map[string]string{"error": "INVALID_QUERY", "message": queryErr.Error()})
		return
	}
	// An aggregate run is finite. A disconnected caller cancels the executable.
	deadline := h.Deadline
	if deadline == 0 {
		deadline = 26 * time.Second
	}
	ctx, cancel := context.WithTimeout(r.Context(), deadline)
	defer cancel()
	binary := h.Binary
	if binary == nil {
		binary = bundledBinary
	}
	path, err := binary()
	if err != nil {
		reply(w, 500, map[string]string{"error": "BINARY_UNAVAILABLE"})
		return
	}
	stdout := &boundedBuffer{limit: 64 * 1024}
	stderr := &boundedBuffer{limit: 4096}
	if info {
		command := exec.CommandContext(ctx, path, "--version")
		command.Stdout, command.Stderr = stdout, stderr
		if err = command.Run(); err != nil {
			reply(w, 500, map[string]string{"error": "BINARY_START_FAILED"})
			return
		}
		reply(w, 200, map[string]any{"runtime": "go", "engine": "bombardier", "revision": Revision,
			"version": strings.TrimSpace(stdout.String() + stderr.String()), "upstreamRequests": 0})
		return
	}
	directory, err := os.MkdirTemp("", "cors-benchmark-")
	if err != nil {
		reply(w, 500, map[string]string{"error": "RUN_SETUP_FAILED"})
		return
	}
	defer os.RemoveAll(directory)
	ca := h.CA
	if ca == nil {
		ca, _ = assets.ReadFile("assets/rfi-ca.pem")
	}
	caFile := filepath.Join(directory, "rfi-ca.pem")
	if err = os.WriteFile(caFile, ca, 0600); err != nil {
		reply(w, 500, map[string]string{"error": "CA_SETUP_FAILED"})
		return
	}
	endpoint := h.Endpoint
	if endpoint == "" {
		endpoint = detailURL
	}
	body := fmt.Sprintf(`{"trainNumber":%q,"timeGMT":%q,"timeUTC":%q}`,
		number, date+"T00:00:00%2B00:00", date+"T00:00:00.000Z")
	timeout := h.RequestTimeout
	if timeout == 0 {
		timeout = 24 * time.Second
	}
	args := []string{"--" + client, "-n", strconv.Itoa(connections), "-c", strconv.Itoa(connections),
		"-t", timeout.String(), "-l", "-m", "POST", "-b", body,
		"-H", "Content-Type: application/json; charset=UTF-8", "-p", "r", "-o", "json"}
	if !keepalive {
		args = append(args, "-H", "Connection: close")
	}
	args = append(args, endpoint)
	command := exec.CommandContext(ctx, path, args...)
	// Do not inherit an outbound proxy, disable verification, or forward caller headers.
	for _, variable := range os.Environ() {
		name := strings.SplitN(variable, "=", 2)[0]
		switch strings.ToUpper(name) {
		case "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR":
			continue
		}
		command.Env = append(command.Env, variable)
	}
	command.Env = append(command.Env, "SSL_CERT_FILE="+caFile)
	command.Stdout, command.Stderr = stdout, stderr
	started := time.Now()
	err = command.Run()
	if ctx.Err() != nil {
		if r.Context().Err() != nil {
			return
		}
		reply(w, 504, map[string]string{"error": "BENCHMARK_DEADLINE", "message": "Bombardier exceeded the finite run deadline"})
		return
	}
	if err != nil || stdout.truncated {
		reply(w, 502, map[string]any{"error": "BENCHMARK_FAILED", "detail": stderr.String()})
		return
	}
	var result json.RawMessage = stdout.Bytes()
	if !json.Valid(result) {
		reply(w, 502, map[string]string{"error": "INVALID_BENCHMARK_OUTPUT"})
		return
	}
	var report struct {
		Result struct {
			HTTP2xx int     `json:"req2xx"`
			HTTP4xx int     `json:"req4xx"`
			HTTP5xx int     `json:"req5xx"`
			Other   int     `json:"others"`
			Seconds float64 `json:"timeTakenSeconds"`
			Latency struct {
				Mean, Max   float64
				Percentiles map[string]float64
			} `json:"latency"`
		} `json:"result"`
	}
	if err = json.Unmarshal(result, &report); err != nil {
		reply(w, 502, map[string]string{"error": "INVALID_BENCHMARK_OUTPUT"})
		return
	}
	metrics := report.Result
	reply(w, 200, map[string]any{"runtime": "go", "engine": "bombardier", "revision": Revision,
		"client": client, "target": endpoint, "number": number, "queryDate": date,
		"requests": connections, "concurrency": connections, "keepalive": keepalive,
		"elapsedMs": float64(time.Since(started).Microseconds()) / 1000,
		"summary": map[string]any{"http2xx": metrics.HTTP2xx, "http4xx": metrics.HTTP4xx,
			"http5xx": metrics.HTTP5xx, "transportErrors": metrics.Other, "benchmarkSeconds": metrics.Seconds,
			"latencyMs": map[string]float64{"mean": metrics.Latency.Mean / 1000,
				"max": metrics.Latency.Max / 1000, "p50": metrics.Latency.Percentiles["50"] / 1000,
				"p95": metrics.Latency.Percentiles["95"] / 1000, "p99": metrics.Latency.Percentiles["99"] / 1000}},
		"result": result, "responseBodiesDiscarded": true})
}

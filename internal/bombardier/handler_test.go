package bombardier

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func localBinary(t *testing.T) func() (string, error) {
	t.Helper()
	path, err := filepath.Abs("../../.vercel/bombardier-local")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal("run python3 scripts/build_bombardier.py before integration tests:", err)
	}
	return func() (string, error) { return path, nil }
}

func decodeReply(t *testing.T, r *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var value map[string]any
	if err := json.Unmarshal(r.Body.Bytes(), &value); err != nil {
		t.Fatalf("bad JSON: %s", r.Body.String())
	}
	return value
}

func TestInvalidAndHeadNeverStartExecutable(t *testing.T) {
	h := Handler{Binary: func() (string, error) { t.Fatal("unexpected process"); return "", nil }}
	for _, query := range []string{"", "?number=--help", "?number=757&c=0", "?number=757&c=21",
		"?number=757&c=2&c=3", "?number=757&url=https://example.com", "?number=757&date=2026-02-30",
		"?number=757&client=http2", "?number=757&mode=info", "?mode=info&mode=info", "?number=757&keepalive=2"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", "/bombardier"+query, nil))
		if w.Code != 400 {
			t.Fatalf("%s: %d", query, w.Code)
		}
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("HEAD", "/bombardier?number=757", nil))
	if w.Code != 405 {
		t.Fatal(w.Code)
	}
}

func TestInfoRunsRealBombardierWithoutUpstream(t *testing.T) {
	w := httptest.NewRecorder()
	Handler{Binary: localBinary(t)}.ServeHTTP(w, httptest.NewRequest("GET", "/bombardier?mode=info", nil))
	result := decodeReply(t, w)
	if w.Code != 200 || !strings.Contains(result["version"].(string), "bombardier") || result["upstreamRequests"] != float64(0) {
		t.Fatal(w.Code, result)
	}
}

func TestActualBombardierConcurrentPostBothClients(t *testing.T) {
	for _, client := range []string{"http1", "fasthttp"} {
		t.Run(client, func(t *testing.T) {
			var count atomic.Int32
			all := make(chan struct{})
			var mu sync.Mutex
			var failures []string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var payload map[string]string
				raw, _ := io.ReadAll(r.Body)
				err := json.Unmarshal(raw, &payload)
				mu.Lock()
				if err != nil || payload["trainNumber"] != "757" || payload["timeGMT"] != "2026-11-04T00:00:00%2B00:00" || payload["timeUTC"] != "2026-11-04T00:00:00.000Z" {
					failures = append(failures, "wrong body: "+string(raw))
				}
				if r.Method != "POST" || r.Header.Get("Content-Type") != "application/json; charset=UTF-8" || !r.Close {
					failures = append(failures, "wrong request fields")
				}
				if r.Header.Get("X-Forwarded-For") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" {
					failures = append(failures, "caller data leaked")
				}
				mu.Unlock()
				if count.Add(1) == 3 {
					close(all)
				}
				select {
				case <-all:
				case <-time.After(time.Second):
				}
				w.Write([]byte(`{"Trains":[]}`))
			}))
			defer server.Close()
			request := httptest.NewRequest("GET", "/bombardier?number=757&date=2026-11-04&c=3&client="+client, nil)
			request.Header.Set("X-Forwarded-For", "192.0.2.1")
			request.Header.Set("Cookie", "private=yes")
			request.Header.Set("Authorization", "secret")
			// An inherited proxy must not alter the direct outbound request.
			t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")
			t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
			w := httptest.NewRecorder()
			Handler{Binary: localBinary(t), Endpoint: server.URL}.ServeHTTP(w, request)
			data := decodeReply(t, w)
			if w.Code != 200 || count.Load() != 3 {
				t.Fatal(w.Code, count.Load(), data)
			}
			mu.Lock()
			defer mu.Unlock()
			if len(failures) != 0 {
				t.Fatal(failures)
			}
			select {
			case <-all:
			default:
				t.Fatal("requests did not overlap")
			}
			summary := data["summary"].(map[string]any)
			if summary["http2xx"] != float64(3) || summary["transportErrors"] != float64(0) {
				t.Fatal(summary)
			}
		})
	}
}

func TestExecutableIsKilledAtDeadlineAndOnDisconnect(t *testing.T) {
	for _, disconnected := range []bool{false, true} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			io.Copy(io.Discard, r.Body)
			<-r.Context().Done()
		}))
		w := httptest.NewRecorder()
		request := httptest.NewRequest("GET", "/bombardier?number=757", nil)
		h := Handler{Binary: localBinary(t), Endpoint: server.URL, Deadline: 150 * time.Millisecond}
		if disconnected {
			ctx, cancel := context.WithCancel(request.Context())
			request = request.WithContext(ctx)
			timer := time.AfterFunc(100*time.Millisecond, cancel)
			defer timer.Stop()
		}
		started := time.Now()
		h.ServeHTTP(w, request)
		if time.Since(started) > time.Second {
			t.Fatal("child process survived cancellation")
		}
		if !disconnected && w.Code != 504 {
			t.Fatal(w.Code, w.Body.String())
		}
		server.Close()
	}
}

func TestRealUpstreamFailuresAppearInBenchmarkResult(t *testing.T) {
	for _, scenario := range []string{"http500", "timeout", "untrustedTLS"} {
		t.Run(scenario, func(t *testing.T) {
			handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				io.Copy(io.Discard, r.Body)
				if scenario == "timeout" {
					<-r.Context().Done()
					return
				}
				w.WriteHeader(500)
				w.Write([]byte("upstream failure"))
			})
			var server *httptest.Server
			if scenario == "untrustedTLS" {
				server = httptest.NewTLSServer(handler)
			} else {
				server = httptest.NewServer(handler)
			}
			defer server.Close()
			w := httptest.NewRecorder()
			Handler{Binary: localBinary(t), Endpoint: server.URL, RequestTimeout: 150 * time.Millisecond}.
				ServeHTTP(w, httptest.NewRequest("GET", "/bombardier?number=757", nil))
			if w.Code != 200 {
				t.Fatal(w.Code, w.Body.String())
			}
			data := decodeReply(t, w)
			summary := data["summary"].(map[string]any)
			if scenario == "http500" {
				if summary["http5xx"] != float64(1) || summary["http2xx"] != float64(0) {
					t.Fatal(summary)
				}
			} else {
				if summary["transportErrors"] != float64(1) || summary["http2xx"] != float64(0) {
					t.Fatal(summary)
				}
				if scenario == "untrustedTLS" && !strings.Contains(w.Body.String(), "certificate") {
					t.Fatal(w.Body.String())
				}
			}
		})
	}
}

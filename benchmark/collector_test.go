package bombardier

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

type bufferedRuntimeWriter struct {
	headers http.Header
	status  int
	body    bytes.Buffer
}

func (w *bufferedRuntimeWriter) Header() http.Header           { return w.headers }
func (w *bufferedRuntimeWriter) WriteHeader(status int)        { w.status = status }
func (w *bufferedRuntimeWriter) Write(raw []byte) (int, error) { return w.body.Write(raw) }

func TestBufferedRuntimeRejectsSSEBeforeCalendarOrProcess(t *testing.T) {
	h := CollectorHandler{Binary: func() (string, error) { t.Fatal("unexpected executable"); return "", nil }, Calendar: func() (*trainCalendar, error) { t.Fatal("unexpected calendar"); return nil, nil }}
	w := &bufferedRuntimeWriter{headers: make(http.Header)}
	h.ServeHTTP(w, httptest.NewRequest("GET", "/gettrain?stream=1", nil))
	if w.status != 501 || !strings.Contains(w.body.String(), "STREAMING_UNAVAILABLE") || strings.Contains(w.body.String(), "event: start") {
		t.Fatal(w.status, w.body.String())
	}
}

var fixtureNow = time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)

func fleetBinary(t *testing.T) func() (string, error) {
	t.Helper()
	p, err := filepath.Abs("../.vercel/bombardier-fleet-local")
	if err != nil {
		t.Fatal(err)
	}
	return func() (string, error) { return p, nil }
}
func fixtureCalendar(numbers ...string) func() (*trainCalendar, error) {
	return func() (*trainCalendar, error) {
		c := &trainCalendar{Version: 1, Timezone: "Europe/Rome", From: "2026-11-03", To: "2026-11-05", MaxEnd: 86399, masks: [][]byte{{7}}}
		for _, n := range numbers {
			c.Trains = append(c.Trains, calendarWindow{n, 0, 86399, 0})
		}
		return c, nil
	}
}
func fixtureDetail(number string) string {
	return fmt.Sprintf(`{"Trains":[{"TrainHeader":{"Id":"20261104123456"},"Path":[{"Place":2000,"Departed":true,"Departure":{"TrainNumber":%q,"Time":"2026-11-04T12:00:00+01:00","Delay":0}}]}]}`, number)
}

func TestCollectorValidationScheduleAndReconnectDoNotStartProcess(t *testing.T) {
	h := CollectorHandler{Binary: func() (string, error) { t.Fatal("unexpected child"); return "", nil }, Calendar: fixtureCalendar("1", "2"), Clock: func() time.Time { return fixtureNow }}
	for _, query := range []string{"?limit=-1", "?limit=1&limit=2", "?after=1441", "?stream=yes", "?numbers=1,", "?client=http2", "?mode=schedule&stream=1", "?url=https://example.com"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", "/gettrain-go"+query, nil))
		if w.Code != 400 {
			t.Fatal(query, w.Code)
		}
	}
	for _, query := range []string{"?mode=schedule", "?limit=0", "?numbers=999"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", "/gettrain-go"+query, nil))
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	r := httptest.NewRequest("GET", "/gettrain-go?stream=1", nil)
	r.Header.Set("Last-Event-ID", "old:1")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 204 {
		t.Fatal(w.Code)
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("HEAD", "/gettrain-go", nil))
	if w.Code != 405 {
		t.Fatal(w.Code)
	}
}

func TestActualFleetReturnsDistinctTrainsConcurrentlyBothEngines(t *testing.T) {
	for _, client := range []string{"http1", "fasthttp"} {
		t.Run(client, func(t *testing.T) {
			var mu sync.Mutex
			counts := map[string]int{}
			var faults []string
			all := make(chan struct{})
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]string
				json.NewDecoder(r.Body).Decode(&body)
				number := body["trainNumber"]
				mu.Lock()
				counts[number]++
				if len(counts) == 3 {
					close(all)
				}
				if body["timeGMT"] != "2026-11-04T00:00:00%2B00:00" || body["timeUTC"] != "2026-11-04T00:00:00.000Z" || r.Method != "POST" || !r.Close {
					faults = append(faults, "wrong request")
				}
				if r.Header.Get("X-Forwarded-For") != "" || r.Header.Get("Cookie") != "" {
					faults = append(faults, "caller data leaked")
				}
				mu.Unlock()
				select {
				case <-all:
				case <-time.After(time.Second):
				}
				io.WriteString(w, fixtureDetail(number))
			}))
			defer upstream.Close()
			h := CollectorHandler{Binary: fleetBinary(t), Calendar: fixtureCalendar("1", "2", "3"), Clock: func() time.Time { return fixtureNow }, Endpoint: upstream.URL}
			request := httptest.NewRequest("GET", "/gettrain?transport=bombardier&client="+client+"&diagnostics=1", nil)
			request.Header.Set("Cookie", "private=yes")
			request.Header.Set("X-Forwarded-For", "192.0.2.1")
			t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
			t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")
			w := httptest.NewRecorder()
			h.ServeHTTP(w, request)
			var data struct {
				Selected int
				Trains   []trainRow
				Summary  map[string]int
			}
			if err := json.Unmarshal(w.Body.Bytes(), &data); err != nil {
				t.Fatal(err, w.Body.String())
			}
			if w.Code != 200 || data.Selected != 3 || data.Summary["errors"] != 0 {
				t.Fatal(w.Code, w.Body.String())
			}
			mu.Lock()
			defer mu.Unlock()
			if !reflect.DeepEqual(counts, map[string]int{"1": 1, "2": 1, "3": 1}) || len(faults) > 0 {
				t.Fatal(counts, faults)
			}
			for i, row := range data.Trains {
				if row.Number != fmt.Sprint(i+1) || row.RT == nil || !*row.RT || row.Last.Place != 2000 {
					t.Fatal(row)
				}
			}
		})
	}
}

func TestActualFleetSSEFastResultPrecedesTimeoutBothEngines(t *testing.T) {
	for _, client := range []string{"http1", "fasthttp"} {
		t.Run(client, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]string
				json.NewDecoder(r.Body).Decode(&body)
				if body["trainNumber"] == "2" {
					<-r.Context().Done()
					return
				}
				io.WriteString(w, fixtureDetail(body["trainNumber"]))
			}))
			defer upstream.Close()
			h := CollectorHandler{Binary: fleetBinary(t), Calendar: fixtureCalendar("1", "2"), Clock: func() time.Time { return fixtureNow }, Endpoint: upstream.URL, RequestTimeout: 400 * time.Millisecond, ProgressInterval: 50 * time.Millisecond}
			server := httptest.NewServer(h)
			defer server.Close()
			response, err := http.Get(server.URL + "?stream=1&client=" + client)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			scanner := bufio.NewScanner(response.Body)
			kind := ""
			var firstTrainAt time.Time
			var trainEvents []trainRow
			progress, done := false, false
			for scanner.Scan() {
				line := scanner.Text()
				if strings.HasPrefix(line, "event: ") {
					kind = strings.TrimPrefix(line, "event: ")
				}
				if !strings.HasPrefix(line, "data: ") {
					continue
				}
				payload := []byte(strings.TrimPrefix(line, "data: "))
				switch kind {
				case "train":
					if firstTrainAt.IsZero() {
						firstTrainAt = time.Now()
					}
					var row trainRow
					json.Unmarshal(payload, &row)
					trainEvents = append(trainEvents, row)
				case "progress":
					progress = true
				case "done":
					done = true
				}
			}
			if err := scanner.Err(); err != nil {
				t.Fatal(err)
			}
			if !progress || !done || len(trainEvents) != 2 || trainEvents[0].Number != "1" || trainEvents[0].Error != nil || trainEvents[1].Error == nil || trainEvents[1].Error.Code != "UPSTREAM_TIMEOUT" {
				t.Fatal(progress, done, trainEvents)
			}
			if time.Since(firstTrainAt) < 200*time.Millisecond {
				t.Fatal("fast result was buffered until the stalled train finished")
			}
		})
	}
}

func TestFleetRejectsUntrustedTLSAndOversizeBodies(t *testing.T) {
	for _, client := range []string{"http1", "fasthttp"} {
		for _, scenario := range []string{"tls", "oversize"} {
			t.Run(client+"/"+scenario, func(t *testing.T) {
				fixture := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					io.Copy(io.Discard, r.Body)
					io.WriteString(w, strings.Repeat("x", 1024*1024+1))
				})
				var upstream *httptest.Server
				if scenario == "tls" {
					upstream = httptest.NewTLSServer(fixture)
				} else {
					upstream = httptest.NewServer(fixture)
				}
				defer upstream.Close()
				h := CollectorHandler{Binary: fleetBinary(t), Calendar: fixtureCalendar("1"), Clock: func() time.Time { return fixtureNow }, Endpoint: upstream.URL}
				w := httptest.NewRecorder()
				h.ServeHTTP(w, httptest.NewRequest("GET", "/gettrain-go?client="+client, nil))
				var data struct{ Trains []trainRow }
				json.Unmarshal(w.Body.Bytes(), &data)
				if len(data.Trains) != 1 || data.Trains[0].Error == nil {
					t.Fatal(w.Body.String())
				}
				if scenario == "oversize" && data.Trains[0].Error.Code != "RESPONSE_TOO_LARGE" {
					t.Fatal(data.Trains[0].Error)
				}
				if scenario == "tls" && !strings.Contains(data.Trains[0].Error.Message, "certificate") {
					t.Fatal(data.Trains[0].Error)
				}
			})
		}
	}
}

func TestCollectorPreservesHTTPInvalidJSONDateAndNumberErrors(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		switch body["trainNumber"] {
		case "1":
			w.WriteHeader(500)
			io.WriteString(w, "<fault><faultstring>Policy Falsified</faultstring></fault>")
		case "2":
			io.WriteString(w, "not json")
		case "3":
			io.WriteString(w, strings.ReplaceAll(fixtureDetail("3"), "20261104", "20261103"))
		case "4":
			io.WriteString(w, fixtureDetail("99"))
		case "5":
			io.WriteString(w, fixtureDetail("5"))
		}
	}))
	defer upstream.Close()
	h := CollectorHandler{Binary: fleetBinary(t), Calendar: fixtureCalendar("1", "2", "3", "4", "5"), Clock: func() time.Time { return fixtureNow }, Endpoint: upstream.URL}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/gettrain-go", nil))
	var data struct {
		Trains  []trainRow
		Summary map[string]int
	}
	json.Unmarshal(w.Body.Bytes(), &data)
	expected := []string{"UPSTREAM_HTTP", "INVALID_RESPONSE", "SERVICE_DATE_MISMATCH", "TRAIN_NOT_FOUND"}
	if len(data.Trains) != 5 || data.Summary["errors"] != 4 {
		t.Fatal(w.Body.String())
	}
	for i, code := range expected {
		if data.Trains[i].Error == nil || data.Trains[i].Error.Code != code {
			t.Fatal(i, data.Trains[i])
		}
	}
	if data.Trains[0].Error.Status != 500 || data.Trains[4].Error != nil {
		t.Fatal(data)
	}
	if data.Trains[0].Error.Message != "Policy Falsified" {
		t.Fatal(data.Trains[0].Error)
	}
}

func TestCollectorDeadlineAndClientCancellationKillSingleProcess(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.Copy(io.Discard, r.Body); <-r.Context().Done() }))
	defer upstream.Close()
	for _, disconnect := range []bool{false, true} {
		h := CollectorHandler{Binary: fleetBinary(t), Calendar: fixtureCalendar("1", "2", "3"), Clock: func() time.Time { return fixtureNow }, Endpoint: upstream.URL, Deadline: 200 * time.Millisecond}
		request := httptest.NewRequest("GET", "/gettrain-go", nil)
		if disconnect {
			ctx, cancel := context.WithCancel(request.Context())
			request = request.WithContext(ctx)
			timer := time.AfterFunc(100*time.Millisecond, cancel)
			defer timer.Stop()
		}
		w := httptest.NewRecorder()
		started := time.Now()
		h.ServeHTTP(w, request)
		if time.Since(started) > time.Second {
			t.Fatal("process survived cancellation")
		}
		if !disconnect {
			var data struct{ Trains []trainRow }
			json.Unmarshal(w.Body.Bytes(), &data)
			if len(data.Trains) != 3 {
				t.Fatal(w.Body.String())
			}
			for _, row := range data.Trains {
				if row.Error == nil || row.Error.Code != "UPSTREAM_TIMEOUT" {
					t.Fatal(row)
				}
			}
		}
	}
}

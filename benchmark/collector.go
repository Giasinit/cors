package bombardier

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
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
)

type CollectorHandler struct {
	Binary           func() (string, error)
	Calendar         func() (*trainCalendar, error)
	Clock            func() time.Time
	Endpoint         string
	CA               []byte
	Deadline         time.Duration
	RequestTimeout   time.Duration
	ProgressInterval time.Duration
}
type collectorOptions struct {
	Mode, Client                   string
	After, Limit                   int
	Numbers                        map[string]bool
	Stream, Diagnostics, KeepAlive bool
}

var unsignedPattern = regexp.MustCompile(`^\d+$`)
var numbersPattern = regexp.MustCompile(`^\d+(?:,\d+)*$`)

func parseCollectorQuery(q url.Values, accept string) (collectorOptions, error) {
	o := collectorOptions{Mode: "live", Client: "fasthttp", Limit: int(^uint(0) >> 1)}
	for name, values := range q {
		if len(values) != 1 || !strings.Contains("|mode|client|after|limit|numbers|stream|diagnostics|keepalive|transport|", "|"+name+"|") {
			return o, fmt.Errorf("invalid parameter: %s", name)
		}
	}
	if q.Has("mode") {
		o.Mode = q.Get("mode")
	}
	if o.Mode != "live" && o.Mode != "schedule" {
		return o, fmt.Errorf("invalid mode")
	}
	if q.Has("client") {
		o.Client = q.Get("client")
	}
	if o.Client != "http1" && o.Client != "fasthttp" {
		return o, fmt.Errorf("invalid client")
	}
	if q.Has("transport") && q.Get("transport") != "bombardier" {
		return o, fmt.Errorf("transport must be bombardier")
	}
	for name, target := range map[string]*int{"after": &o.After, "limit": &o.Limit} {
		if !q.Has(name) {
			continue
		}
		value := q.Get(name)
		n, err := strconv.ParseUint(value, 10, 53)
		if !unsignedPattern.MatchString(value) || err != nil {
			return o, fmt.Errorf("invalid %s", name)
		}
		*target = int(n)
	}
	if o.After > 1440 {
		return o, fmt.Errorf("after must be at most 1440 minutes")
	}
	if q.Has("numbers") {
		value := q.Get("numbers")
		if !numbersPattern.MatchString(value) {
			return o, fmt.Errorf("invalid numbers")
		}
		o.Numbers = map[string]bool{}
		for _, number := range strings.Split(value, ",") {
			o.Numbers[number] = true
		}
	}
	o.Stream = strings.Contains(accept, "text/event-stream") && !strings.Contains(accept, "application/json")
	for name, target := range map[string]*bool{"stream": &o.Stream, "diagnostics": &o.Diagnostics, "keepalive": &o.KeepAlive} {
		if !q.Has(name) {
			continue
		}
		v := q.Get(name)
		if v != "0" && v != "1" {
			return o, fmt.Errorf("invalid %s", name)
		}
		*target = v == "1"
	}
	o.Diagnostics = o.Diagnostics || o.Stream
	if o.Mode == "schedule" && o.Stream {
		return o, fmt.Errorf("SSE requires live mode")
	}
	return o, nil
}

type collectorJob struct {
	Number     string `json:"number"`
	OriginDate string `json:"originDate"`
	QueryDate  string `json:"queryDate"`
}
type collectorFrame struct {
	Index      int     `json:"index"`
	Number     string  `json:"number"`
	OriginDate string  `json:"originDate"`
	Status     int     `json:"status"`
	Body       []byte  `json:"body"`
	Error      string  `json:"error"`
	Code       string  `json:"code"`
	ElapsedMS  float64 `json:"elapsedMs"`
}
type collectorExit struct{ Wait, Scan error }

func cleanProcessEnvironment(caFile string) []string {
	environment := make([]string, 0)
	for _, variable := range os.Environ() {
		name := strings.ToUpper(strings.SplitN(variable, "=", 2)[0])
		switch name {
		case "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR":
			continue
		}
		environment = append(environment, variable)
	}
	return append(environment, "SSL_CERT_FILE="+caFile)
}

func (h CollectorHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Collector-Runtime", "go-bombardier-fleet")
	if r.Method == "OPTIONS" {
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Accept, Last-Event-ID")
		w.WriteHeader(204)
		return
	}
	if r.Method != "GET" {
		w.Header().Set("Allow", "GET, OPTIONS")
		reply(w, 405, map[string]string{"error": "METHOD_NOT_ALLOWED"})
		return
	}
	query, err := url.ParseQuery(r.URL.RawQuery)
	var options collectorOptions
	if err == nil {
		options, err = parseCollectorQuery(query, r.Header.Get("Accept"))
	}
	if err != nil {
		reply(w, 400, map[string]string{"error": "INVALID_QUERY", "message": err.Error()})
		return
	}
	if options.Stream && r.Header.Get("Last-Event-ID") != "" {
		w.WriteHeader(204)
		return
	}
	clock := h.Clock
	if clock == nil {
		clock = time.Now
	}
	startedAt := clock()
	started := time.Now()
	load := h.Calendar
	if load == nil {
		load = loadTrainCalendar
	}
	calendar, err := load()
	if err != nil {
		reply(w, 500, map[string]string{"error": "CALENDAR_ERROR"})
		return
	}
	active, err := selectTrainEntries(calendar, startedAt, options.After, options.Numbers)
	if err != nil {
		reply(w, 409, map[string]string{"error": "CALENDAR_OUT_OF_RANGE", "message": err.Error()})
		return
	}
	selected := active
	if options.Limit < len(selected) {
		selected = selected[:options.Limit]
	}
	metadata := map[string]any{"startedAt": timestamp(startedAt), "timezone": "Europe/Rome",
		"calendar": map[string]any{"from": calendar.From, "to": calendar.To, "publication": calendar.Publication, "sha256": calendar.Source.SHA256},
		"active":   len(active), "selected": len(selected), "transport": "bombardier", "runtime": "go",
		"engine": "bombardier-fleet", "client": options.Client, "upstreamRevision": Revision, "extended": true}
	if options.Mode == "schedule" {
		metadata["trains"] = selected
		reply(w, 200, metadata)
		return
	}
	deadline := h.Deadline
	if deadline == 0 {
		deadline = 26 * time.Second
	}
	ctx, cancel := context.WithTimeout(r.Context(), deadline)
	defer cancel()
	rows := make([]trainRow, len(selected))
	seen := make([]bool, len(selected))
	completed := 0
	var sequence int
	nonce := make([]byte, 8)
	_, _ = rand.Read(nonce)
	runID := hex.EncodeToString(nonce)
	emit := func(event string, value any) bool {
		if r.Context().Err() != nil {
			return false
		}
		encoded, encodeErr := json.Marshal(value)
		if encodeErr != nil {
			return false
		}
		controller := http.NewResponseController(w)
		_ = controller.SetWriteDeadline(time.Now().Add(2 * time.Second))
		_, writeErr := fmt.Fprintf(w, "id: %s:%d\nevent: %s\ndata: %s\n\n", runID, sequence, event, encoded)
		sequence++
		if writeErr == nil {
			writeErr = controller.Flush()
		}
		if writeErr != nil {
			cancel()
			return false
		}
		return true
	}
	if options.Stream {
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache, no-transform")
		w.Header().Set("X-Accel-Buffering", "no")
		identities := make([]map[string]string, 0, len(selected))
		for _, entry := range selected {
			identities = append(identities, map[string]string{"number": entry.Number, "serviceDate": entry.OriginDate})
		}
		start := make(map[string]any)
		for k, v := range metadata {
			start[k] = v
		}
		start["trains"] = identities
		if !emit("start", start) {
			return
		}
	}
	record := func(index int, row trainRow) bool {
		rows[index] = row
		seen[index] = true
		completed++
		if options.Stream {
			return emit("train", struct {
				trainRow
				Completed int `json:"completed"`
				Remaining int `json:"remaining"`
			}{row, completed, len(selected) - completed})
		}
		return true
	}
	var runError error
	if len(selected) > 0 {
		runError = h.run(ctx, cancel, selected, startedAt.In(rome).Format("2006-01-02"), options,
			func(frame collectorFrame) error {
				if frame.Index < 0 || frame.Index >= len(selected) || seen[frame.Index] {
					return fmt.Errorf("invalid or duplicate result index")
				}
				entry := selected[frame.Index]
				if frame.Number != entry.Number || frame.OriginDate != entry.OriginDate {
					return fmt.Errorf("collector identity mismatch")
				}
				var row trainRow
				var fault error
				switch {
				case frame.Error != "":
					code := frame.Code
					if code == "" {
						code = "LOOKUP_ERROR"
					}
					fault = &trainFault{Code: code, Message: frame.Error}
				case frame.Status != 200:
					fault = &trainFault{Code: "UPSTREAM_HTTP", Status: frame.Status, Message: string(frame.Body)}
				default:
					row, fault = compactTrainBody(frame.Body, entry, clock())
				}
				if fault != nil {
					row = errorTrainRow(entry, clock(), fault)
				}
				if options.Diagnostics {
					outcome := "success"
					if row.Error != nil {
						outcome = "error"
						if row.Error.Code == "UPSTREAM_TIMEOUT" {
							outcome = "timeout"
						}
					}
					row.Diagnostics = &trainDiagnostics{frame.ElapsedMS, "complete", outcome}
				}
				if !record(frame.Index, row) {
					return fmt.Errorf("downstream closed")
				}
				return nil
			}, func() bool {
				if !options.Stream {
					return true
				}
				pending := make([]map[string]any, 0)
				for i, entry := range selected {
					if !seen[i] {
						pending = append(pending, map[string]any{"number": entry.Number, "serviceDate": entry.OriginDate, "phase": "awaiting_bombardier_result"})
					}
				}
				return emit("progress", map[string]any{"elapsedMs": time.Since(started).Milliseconds(), "completed": completed, "remaining": len(pending), "pending": pending})
			})
	}
	if r.Context().Err() != nil {
		return
	}
	for index, entry := range selected {
		if seen[index] {
			continue
		}
		fault := &trainFault{Code: "COLLECTOR_PROCESS_ERROR", Message: "Bombardier exited without a result"}
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			fault = &trainFault{Code: "UPSTREAM_TIMEOUT", Message: "RFI request exceeded the collector deadline"}
		} else if runError != nil {
			fault.Message = runError.Error()
		}
		row := errorTrainRow(entry, clock(), fault)
		if options.Diagnostics {
			outcome := "error"
			if fault.Code == "UPSTREAM_TIMEOUT" {
				outcome = "timeout"
			}
			row.Diagnostics = &trainDiagnostics{float64(time.Since(started).Milliseconds()), "collector", outcome}
		}
		if !record(index, row) {
			return
		}
	}
	errorsCount, realtime := 0, 0
	for _, row := range rows {
		if row.Error != nil {
			errorsCount++
		} else if row.RT != nil && *row.RT {
			realtime++
		}
	}
	metadata["completedAt"] = timestamp(clock())
	metadata["elapsedMs"] = time.Since(started).Milliseconds()
	metadata["summary"] = map[string]int{"realtime": realtime, "noRealtime": len(rows) - errorsCount - realtime, "errors": errorsCount}
	if options.Stream {
		metadata["completed"] = completed
		metadata["remaining"] = 0
		emit("done", metadata)
	} else {
		metadata["trains"] = rows
		reply(w, 200, metadata)
	}
}

func (h CollectorHandler) run(ctx context.Context, cancel context.CancelFunc, entries []trainEntry, queryDate string, options collectorOptions, onFrame func(collectorFrame) error, onProgress func() bool) error {
	binary := h.Binary
	if binary == nil {
		binary = bundledFleetBinary
	}
	path, err := binary()
	if err != nil {
		return fmt.Errorf("fleet executable unavailable")
	}
	directory, err := os.MkdirTemp("", "cors-fleet-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(directory)
	ca := h.CA
	if ca == nil {
		ca, _ = assets.ReadFile("assets/rfi-ca.pem")
	}
	caFile := filepath.Join(directory, "rfi-ca.pem")
	if err = os.WriteFile(caFile, ca, 0600); err != nil {
		return err
	}
	endpoint := h.Endpoint
	if endpoint == "" {
		endpoint = detailURL
	}
	timeout := h.RequestTimeout
	if timeout == 0 {
		timeout = 24 * time.Second
	}
	jobs := make([]collectorJob, 0, len(entries))
	for _, entry := range entries {
		jobs = append(jobs, collectorJob{entry.Number, entry.OriginDate, queryDate})
	}
	input, _ := json.Marshal(map[string]any{"target": endpoint, "client": options.Client, "timeoutMs": timeout.Milliseconds(), "keepalive": options.KeepAlive, "jobs": jobs})
	command := exec.CommandContext(ctx, path, "--train-fleet")
	command.Env = cleanProcessEnvironment(caFile)
	command.Stdin = bytes.NewReader(input)
	stderr := &boundedBuffer{limit: 4096}
	command.Stderr = stderr
	stdout, err := command.StdoutPipe()
	if err != nil {
		return err
	}
	if err = command.Start(); err != nil {
		return fmt.Errorf("fleet executable could not start")
	}
	frames := make(chan collectorFrame, 8)
	done := make(chan collectorExit, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 64*1024), 2*1024*1024)
		var scanError error
	scanLoop:
		for scanner.Scan() {
			var frame collectorFrame
			if err := json.Unmarshal(scanner.Bytes(), &frame); err != nil {
				scanError = fmt.Errorf("invalid fleet result frame")
				cancel()
				break
			}
			select {
			case frames <- frame:
			case <-ctx.Done():
				break scanLoop
			}
		}
		if scanError == nil {
			scanError = scanner.Err()
		}
		result := collectorExit{Wait: command.Wait(), Scan: scanError}
		done <- result
		close(frames)
	}()
	interval := h.ProgressInterval
	if interval == 0 {
		interval = 3 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	var handlerError error
loop:
	for {
		select {
		case frame, open := <-frames:
			if !open {
				break loop
			}
			if err := onFrame(frame); err != nil {
				handlerError = err
				cancel()
				break loop
			}
		case <-ticker.C:
			if !onProgress() {
				cancel()
				handlerError = fmt.Errorf("downstream closed")
				break loop
			}
		case <-ctx.Done():
			break loop
		}
	}
	result := <-done
	if handlerError != nil {
		return handlerError
	}
	if result.Scan != nil {
		return result.Scan
	}
	if result.Wait != nil {
		return fmt.Errorf("fleet executable failed")
	}
	return nil
}

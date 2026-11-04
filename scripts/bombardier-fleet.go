// Added to the pinned upstream Bombardier source by build_bombardier.py.
// This mode reuses Bombardier's actual client factories and returns bodies
// instead of discarding them. The original benchmark CLI is unchanged.
package main

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sync"
	"time"

	"github.com/valyala/fasthttp"
)

type fleetJob struct {
	Number     string `json:"number"`
	OriginDate string `json:"originDate"`
	QueryDate  string `json:"queryDate"`
}
type fleetConfig struct {
	Target    string     `json:"target"`
	Client    string     `json:"client"`
	TimeoutMS int        `json:"timeoutMs"`
	KeepAlive bool       `json:"keepalive"`
	Jobs      []fleetJob `json:"jobs"`
}
type fleetFrame struct {
	Index      int     `json:"index"`
	Number     string  `json:"number"`
	OriginDate string  `json:"originDate"`
	Status     int     `json:"status"`
	Body       []byte  `json:"body,omitempty"`
	Error      string  `json:"error,omitempty"`
	Code       string  `json:"code,omitempty"`
	ElapsedMS  float64 `json:"elapsedMs"`
}

const fleetBodyLimit = 1024 * 1024

func init() {
	if len(os.Args) == 2 && os.Args[1] == "--train-fleet" {
		if err := runTrainFleet(os.Stdin, os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		os.Exit(0)
	}
}

func runTrainFleet(input io.Reader, output io.Writer) error {
	var config fleetConfig
	if err := json.NewDecoder(io.LimitReader(input, 4*1024*1024)).Decode(&config); err != nil {
		return err
	}
	target, err := url.Parse(config.Target)
	if err != nil || (target.Scheme != "https" && target.Scheme != "http") {
		return fmt.Errorf("invalid fleet target")
	}
	if config.Client != "http1" && config.Client != "fasthttp" {
		return fmt.Errorf("invalid fleet client")
	}
	if config.TimeoutMS <= 0 || config.TimeoutMS > 24000 {
		return fmt.Errorf("invalid fleet timeout")
	}
	headers := headersList{{key: "Content-Type", value: "application/json; charset=UTF-8"}}
	if !config.KeepAlive {
		headers = append(headers, header{key: "Connection", value: "close"})
	}
	var bytesRead, bytesWritten int64
	options := &clientOpts{requestURL: target, headers: &headers, method: "POST",
		timeout:  time.Duration(config.TimeoutMS) * time.Millisecond,
		maxConns: uint64(len(config.Jobs) + 1), disableKeepAlives: !config.KeepAlive,
		tlsConfig: &tls.Config{MinVersion: tls.VersionTLS12},
		bytesRead: &bytesRead, bytesWritten: &bytesWritten}
	// One shared client, one goroutine per dated train; no worker pool or semaphore.
	var standard *httpClient
	var fast *fasthttpClient
	if config.Client == "http1" {
		standard = newHTTPClient(options).(*httpClient)
		defer standard.client.CloseIdleConnections()
	} else {
		fast = newFastHTTPClient(options).(*fasthttpClient)
		fast.client.MaxResponseBodySize = fleetBodyLimit
		fast.client.MaxIdemponentCallAttempts = 1
		defer fast.client.CloseIdleConnections()
	}
	encoder := json.NewEncoder(output)
	var outputMu sync.Mutex
	var outputError error
	launchFleetJobs(config.Jobs, func(index int, job fleetJob) {
		frame := fleetFrame{Index: index, Number: job.Number, OriginDate: job.OriginDate}
		started := time.Now()
		body := []byte(fmt.Sprintf(`{"trainNumber":%q,"timeGMT":%q,"timeUTC":%q}`,
			job.Number, job.QueryDate+"T00:00:00%2B00:00", job.QueryDate+"T00:00:00.000Z"))
		var requestError error
		if standard != nil {
			req, requestErr := http.NewRequest("POST", target.String(), bytes.NewReader(body))
			if requestErr == nil {
				req.Header = standard.headers.Clone()
				response, responseErr := standard.client.Do(req)
				requestError = responseErr
				if responseErr == nil {
					frame.Status = response.StatusCode
					frame.Body, requestError = io.ReadAll(io.LimitReader(response.Body, fleetBodyLimit+1))
					response.Body.Close()
					if len(frame.Body) > fleetBodyLimit {
						frame.Body = nil
						frame.Code = "RESPONSE_TOO_LARGE"
						requestError = fmt.Errorf("RFI response exceeds 1 MiB")
					}
				}
			} else {
				requestError = requestErr
			}
		} else {
			req, response := fasthttp.AcquireRequest(), fasthttp.AcquireResponse()
			fast.headers.CopyTo(&req.Header)
			req.Header.SetMethod("POST")
			req.SetURI(fast.uri)
			req.UseHostHeader = true
			req.SetBody(body)
			requestError = fast.client.DoTimeout(req, response, options.timeout)
			if requestError == nil {
				frame.Status = response.StatusCode()
				frame.Body = append([]byte(nil), response.Body()...)
			}
			fasthttp.ReleaseRequest(req)
			fasthttp.ReleaseResponse(response)
		}
		if requestError != nil {
			frame.Body = nil
			frame.Error = requestError.Error()
			if len(frame.Error) > 160 {
				frame.Error = frame.Error[:160]
			}
			if frame.Code == "" {
				frame.Code = "LOOKUP_ERROR"
				if timeout, ok := requestError.(interface{ Timeout() bool }); ok && timeout.Timeout() {
					frame.Code = "UPSTREAM_TIMEOUT"
				}
				if requestError == fasthttp.ErrTimeout {
					frame.Code = "UPSTREAM_TIMEOUT"
				}
				if requestError == fasthttp.ErrBodyTooLarge {
					frame.Code = "RESPONSE_TOO_LARGE"
				}
			}
		}
		frame.ElapsedMS = float64(time.Since(started).Microseconds()) / 1000
		outputMu.Lock()
		if outputError == nil {
			outputError = encoder.Encode(frame)
		}
		outputMu.Unlock()
	})
	return outputError
}

func launchFleetJobs(jobs []fleetJob, execute func(int, fleetJob)) {
	var wg sync.WaitGroup
	start := make(chan struct{})
	for index, job := range jobs {
		wg.Add(1)
		go func(index int, job fleetJob) {
			defer wg.Done()
			<-start
			execute(index, job)
		}(index, job)
	}
	close(start)
	wg.Wait()
}

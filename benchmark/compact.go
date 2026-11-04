package bombardier

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type trainFault struct {
	Code    string `json:"code"`
	Status  int    `json:"status,omitempty"`
	Message string `json:"message"`
}

func (e *trainFault) Error() string { return e.Message }

type lastEvent struct {
	Place         int64   `json:"place"`
	Event         string  `json:"event"`
	ScheduledTime *string `json:"scheduledTime"`
	EstimatedTime *string `json:"estimatedTime"`
}
type trainDiagnostics struct {
	ElapsedMS float64 `json:"elapsedMs"`
	Phase     string  `json:"phase"`
	Outcome   string  `json:"outcome"`
}
type trainRow struct {
	Number      string            `json:"number"`
	ServiceDate string            `json:"serviceDate"`
	RT          *bool             `json:"rt"`
	Last        *lastEvent        `json:"last"`
	CheckedAt   string            `json:"checkedAt"`
	Error       *trainFault       `json:"error,omitempty"`
	Diagnostics *trainDiagnostics `json:"diagnostics,omitempty"`
}
type rawEvent struct {
	TrainNumber json.RawMessage
	Time        json.RawMessage
	Delay       json.RawMessage
}
type rawPoint struct {
	Place     json.RawMessage
	Arrived   bool
	Departed  bool
	Arrival   *rawEvent
	Departure *rawEvent
}
type rawTrain struct {
	TrainHeader struct{ ID json.RawMessage }
	Path        []rawPoint
}
type trainDetail struct{ Trains []rawTrain }

var delayPattern = regexp.MustCompile(`^[+-]?\d+(?:\.\d+)?$`)

func scalarString(raw json.RawMessage) string {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if decoder.Decode(&value) == nil {
		if n, ok := value.(json.Number); ok {
			f, err := n.Float64()
			if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
				return ""
			}
			if f == 0 {
				return "0"
			}
			if math.Abs(f) >= 1e-6 && math.Abs(f) < 1e21 {
				return strconv.FormatFloat(f, 'f', -1, 64)
			}
			return strconv.FormatFloat(f, 'g', -1, 64)
		}
	}
	return ""
}
func canonicalTrain(number string) string {
	result := strings.TrimLeft(number, "0")
	if result == "" {
		return "0"
	}
	return result
}
func eventDelay(raw json.RawMessage) (float64, bool) {
	if len(raw) == 0 {
		return 0, false
	}
	var value any
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if d.Decode(&value) != nil {
		return 0, false
	}
	var text string
	switch v := value.(type) {
	case string:
		text = strings.TrimSpace(v)
		if !delayPattern.MatchString(text) {
			return 0, false
		}
	case json.Number:
		text = v.String()
	default:
		return 0, false
	}
	n, err := strconv.ParseFloat(text, 64)
	return n, err == nil && !math.IsInf(n, 0) && !math.IsNaN(n)
}
func timestamp(now time.Time) string { return now.UTC().Format("2006-01-02T15:04:05.000Z") }

func compactTrainBody(body []byte, entry trainEntry, now time.Time) (trainRow, error) {
	var detail trainDetail
	if json.Unmarshal(body, &detail) != nil || detail.Trains == nil {
		return trainRow{}, &trainFault{Code: "INVALID_RESPONSE", Message: "Missing or invalid Trains array"}
	}
	var matches []rawTrain
	byNumber := 0
	for _, train := range detail.Trains {
		found := false
		if train.Path == nil {
			continue
		}
		for _, point := range train.Path {
			for _, event := range []*rawEvent{point.Arrival, point.Departure} {
				if event != nil && scalarString(event.TrainNumber) != "" && canonicalTrain(scalarString(event.TrainNumber)) == canonicalTrain(entry.Number) {
					found = true
				}
			}
		}
		if !found {
			continue
		}
		byNumber++
		if strings.HasPrefix(scalarString(train.TrainHeader.ID), strings.ReplaceAll(entry.OriginDate, "-", "")) {
			matches = append(matches, train)
		}
	}
	if len(matches) != 1 {
		code := "TRAIN_NOT_FOUND"
		if len(matches) > 1 {
			code = "AMBIGUOUS_TRAIN"
		} else if byNumber > 0 {
			code = "SERVICE_DATE_MISMATCH"
		}
		return trainRow{}, &trainFault{Code: code, Message: "No unique detail matching the public number and origin date"}
	}
	realtime := false
	row := trainRow{Number: entry.Number, ServiceDate: entry.OriginDate, RT: &realtime, CheckedAt: timestamp(now)}
	for _, point := range matches[0].Path {
		for _, event := range []*rawEvent{point.Arrival, point.Departure} {
			if event != nil {
				if _, ok := eventDelay(event.Delay); ok {
					realtime = true
				}
			}
		}
		kind := ""
		var event *rawEvent
		if point.Departed && point.Departure != nil {
			kind = "departure"
			event = point.Departure
		} else if point.Arrived && point.Arrival != nil {
			kind = "arrival"
			event = point.Arrival
		}
		if event == nil {
			continue
		}
		var place float64
		if bytes.Equal(bytes.TrimSpace(point.Place), []byte("null")) || json.Unmarshal(point.Place, &place) != nil || place < 0 || place > 9007199254740991 || math.Trunc(place) != place {
			return trainRow{}, &trainFault{Code: "INVALID_RESPONSE", Message: "Missing PIC place ID"}
		}
		realtime = true
		last := &lastEvent{Place: int64(place), Event: kind}
		var schedule string
		if json.Unmarshal(event.Time, &schedule) == nil {
			if parsed, err := time.Parse(time.RFC3339Nano, schedule); err == nil {
				last.ScheduledTime = &schedule
				if delay, ok := eventDelay(event.Delay); ok {
					millis := float64(parsed.UnixMilli()) + delay*60000
					if math.Abs(millis) <= 8640000000000000 {
						estimated := timestamp(time.UnixMilli(int64(millis)))
						last.EstimatedTime = &estimated
					}
				}
			}
		}
		row.Last = last
	}
	return row, nil
}

func errorTrainRow(entry trainEntry, now time.Time, err error) trainRow {
	fault, ok := err.(*trainFault)
	if !ok {
		fault = &trainFault{Code: "LOOKUP_ERROR", Message: fmt.Sprint(err)}
	}
	if len(fault.Message) > 160 {
		copy := *fault
		copy.Message = copy.Message[:160]
		fault = &copy
	}
	return trainRow{Number: entry.Number, ServiceDate: entry.OriginDate, CheckedAt: timestamp(now), Error: fault}
}

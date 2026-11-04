package bombardier

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"
	"sync"
	"time"
)

type calendarWindow struct {
	Number               string
	Start, End, Calendar int
}

func (w *calendarWindow) UnmarshalJSON(raw []byte) error {
	var values []json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil {
		return err
	}
	if len(values) != 4 {
		return fmt.Errorf("invalid calendar window")
	}
	for i, target := range []any{&w.Number, &w.Start, &w.End, &w.Calendar} {
		if err := json.Unmarshal(values[i], target); err != nil {
			return err
		}
	}
	return nil
}

type trainCalendar struct {
	Version     int    `json:"version"`
	Timezone    string `json:"timezone"`
	From        string `json:"from"`
	To          string `json:"to"`
	Publication string `json:"publication"`
	Source      struct {
		SHA256 string `json:"sha256"`
	} `json:"source"`
	MaxEnd    int              `json:"maxEnd"`
	Calendars []string         `json:"calendars"`
	Trains    []calendarWindow `json:"trains"`
	masks     [][]byte
}

type trainEntry struct {
	Number      string `json:"number"`
	ServiceDate string `json:"serviceDate"`
	OriginDate  string `json:"originDate"`
}

var calendarOnce sync.Once
var bundledCalendar *trainCalendar
var calendarError error

func loadTrainCalendar() (*trainCalendar, error) {
	calendarOnce.Do(func() {
		raw, err := assets.ReadFile("assets/train-calendar.json.gz")
		if err != nil {
			calendarError = err
			return
		}
		reader, err := gzip.NewReader(bytes.NewReader(raw))
		if err != nil {
			calendarError = err
			return
		}
		defer reader.Close()
		content, err := io.ReadAll(io.LimitReader(reader, 8*1024*1024))
		if err != nil {
			calendarError = err
			return
		}
		bundledCalendar, calendarError = decodeCalendar(content)
	})
	return bundledCalendar, calendarError
}

func decodeCalendar(raw []byte) (*trainCalendar, error) {
	var c trainCalendar
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, err
	}
	if c.Version != 1 || c.Timezone != "Europe/Rome" {
		return nil, fmt.Errorf("unsupported calendar")
	}
	for _, encoded := range c.Calendars {
		mask, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return nil, err
		}
		c.masks = append(c.masks, mask)
	}
	return &c, nil
}

func addCalendarDays(date string, days int) string {
	t, _ := time.Parse("2006-01-02", date)
	return t.AddDate(0, 0, days).Format("2006-01-02")
}

func selectTrainEntries(c *trainCalendar, now time.Time, after int, numbers map[string]bool) ([]trainEntry, error) {
	local := now.In(rome)
	date := local.Format("2006-01-02")
	if date < c.From || date > c.To {
		return nil, &trainFault{Code: "CALENDAR_OUT_OF_RANGE", Message: fmt.Sprintf("Calendar valid %s through %s", c.From, c.To)}
	}
	first, _ := time.Parse("2006-01-02", c.From)
	lookback := (c.MaxEnd + after*60 + 86399) / 86400
	seconds := local.Hour()*3600 + local.Minute()*60 + local.Second()
	seen := map[string]bool{}
	entries := make([]trainEntry, 0)
	for offset := 0; offset <= lookback; offset++ {
		service := addCalendarDays(date, -offset)
		serviceTime, _ := time.Parse("2006-01-02", service)
		index := int(serviceTime.Sub(first).Hours() / 24)
		if index < 0 {
			continue
		}
		civilSeconds := offset*86400 + seconds
		for _, row := range c.Trains {
			if numbers != nil && !numbers[row.Number] {
				continue
			}
			if civilSeconds < row.Start || civilSeconds > row.End+after*60 {
				continue
			}
			if row.Calendar < 0 || row.Calendar >= len(c.masks) {
				return nil, fmt.Errorf("invalid calendar index")
			}
			mask := c.masks[row.Calendar]
			if index/8 >= len(mask) || mask[index/8]&(1<<uint(index&7)) == 0 {
				continue
			}
			origin := addCalendarDays(service, row.Start/86400)
			key := origin + "/" + row.Number
			if !seen[key] {
				seen[key] = true
				entries = append(entries, trainEntry{row.Number, service, origin})
			}
		}
	}
	sort.SliceStable(entries, func(i, j int) bool {
		a, b := entries[i], entries[j]
		if a.OriginDate != b.OriginDate {
			return a.OriginDate < b.OriginDate
		}
		x, y := strings.TrimLeft(a.Number, "0"), strings.TrimLeft(b.Number, "0")
		if len(x) != len(y) {
			return len(x) < len(y)
		}
		return x < y
	})
	return entries, nil
}

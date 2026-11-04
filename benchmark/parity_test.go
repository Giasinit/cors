package bombardier

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"reflect"
	"testing"
	"time"
)

func TestCalendarAndCompactDifferentialAgainstExistingNode(t *testing.T) {
	output, err := exec.Command("node", "../scripts/collector-parity.mjs").Output()
	if err != nil {
		t.Fatal(err)
	}
	var reference struct {
		Calendars []struct {
			Data    json.RawMessage
			Now     string
			Options struct {
				AfterMinutes int
				Numbers      []string
			}
			Expected []trainEntry
			Error    string
		}
		Details []struct {
			Data      json.RawMessage
			Entry     trainEntry
			CheckedAt string
			Expected  json.RawMessage
			Error     string
		}
	}
	if err = json.Unmarshal(output, &reference); err != nil {
		t.Fatal(err)
	}
	for i, c := range reference.Calendars {
		data, err := decodeCalendar(c.Data)
		if err != nil {
			t.Fatal(err)
		}
		now, _ := time.Parse(time.RFC3339, c.Now)
		var numbers map[string]bool
		if c.Options.Numbers != nil {
			numbers = map[string]bool{}
			for _, n := range c.Options.Numbers {
				numbers[n] = true
			}
		}
		actual, err := selectTrainEntries(data, now, c.Options.AfterMinutes, numbers)
		if c.Error != "" {
			if fault, ok := err.(*trainFault); !ok || fault.Code != c.Error {
				t.Fatalf("calendar %d: %v", i, err)
			}
			continue
		}
		if err != nil || !reflect.DeepEqual(actual, c.Expected) {
			t.Fatalf("calendar %d: %v; Go=%v Node=%v", i, err, actual, c.Expected)
		}
	}
	for i, c := range reference.Details {
		now, _ := time.Parse(time.RFC3339, c.CheckedAt)
		actual, err := compactTrainBody(c.Data, c.Entry, now)
		if c.Error != "" {
			if fault, ok := err.(*trainFault); !ok || fault.Code != c.Error {
				t.Fatalf("detail %d: got %v expected %s", i, err, c.Error)
			}
			continue
		}
		if err != nil {
			t.Fatalf("detail %d: %v", i, err)
		}
		raw, _ := json.Marshal(actual)
		var got, want any
		json.Unmarshal(raw, &got)
		json.Unmarshal(c.Expected, &want)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("detail %d: Go=%s Node=%s", i, raw, c.Expected)
		}
	}
	source, err := os.ReadFile("../data/train-calendar.json.gz")
	if err != nil {
		t.Fatal(err)
	}
	embedded, _ := assets.ReadFile("assets/train-calendar.json.gz")
	if !bytes.Equal(source, embedded) {
		t.Fatal("Go and Node calendar copies differ")
	}
	t.Logf("%d calendar scenarios and %d compact responses agree", len(reference.Calendars), len(reference.Details))
}

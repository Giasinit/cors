package main

import (
	"sync/atomic"
	"testing"
	"time"
)

func TestTrainFleetStarts1000BeforeAnyCompletes(t *testing.T) {
	jobs := make([]fleetJob, 1000)
	var started atomic.Int32
	all := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		launchFleetJobs(jobs, func(index int, job fleetJob) {
			if started.Add(1) == 1000 {
				close(all)
			}
			<-all
		})
		close(finished)
	}()
	select {
	case <-finished:
	case <-time.After(3 * time.Second):
		t.Fatalf("only %d started before completion", started.Load())
	}
	if started.Load() != 1000 {
		t.Fatal(started.Load())
	}
}

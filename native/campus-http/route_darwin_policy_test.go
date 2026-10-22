package main

import "testing"

func TestDarwinPrimaryDefaultAndAmbiguity(t *testing.T) {
	primary := route{Name: "en0", Index: 4, Gateway: "192.0.2.1", Addresses: "192.0.2.2/24", Metric: 100}
	secondary := route{Name: "en1", Index: 5, Gateway: "198.51.100.1", Addresses: "198.51.100.2/24", Metric: 1 << 32}
	for _, rows := range [][]route{{secondary, primary}, {primary, secondary}, {primary, primary}} {
		got, err := selectDarwinRoute(rows)
		if err != nil || got != primary {
			t.Fatal(got, err)
		}
	}
	secondary.Metric = primary.Metric
	for _, rows := range [][]route{nil, {primary, secondary}} {
		if _, err := selectDarwinRoute(rows); err == nil {
			t.Fatal("missing or ambiguous route accepted")
		}
	}
}

package main

import "testing"

func TestWindowsPhysicalSelection(t *testing.T) {
	good := windowsRouteCandidate{Route: route{Name: "hardware", Index: 9, Gateway: "192.0.2.1", Addresses: "192.0.2.2/24", Metric: 40}, Hardware: true, Up: true, Connected: true, Type: 6, LUID: 99}
	vpn := good
	vpn.Route.Name = "virtual"
	vpn.Route.Index = 3
	vpn.Route.Metric = 0
	vpn.Hardware = false
	got, e := selectWindowsPhysicalRoute([]windowsRouteCandidate{vpn, good})
	if e != nil || got.Name != "hardware" {
		t.Fatal(got, e)
	}
	for _, bad := range []string{"hardware", "up", "connected", "type", "index", "luid", "address"} {
		b := good
		switch bad {
		case "hardware":
			b.Hardware = false
		case "up":
			b.Up = false
		case "connected":
			b.Connected = false
		case "type":
			b.Type = 131
		case "index":
			b.Route.Index = 1 << 24
		case "luid":
			b.LUID = 0
		case "address":
			b.Route.Addresses = ""
		}
		if _, e := selectWindowsPhysicalRoute([]windowsRouteCandidate{b}); e == nil {
			t.Fatal(bad)
		}
	}
	other := good
	other.Route.Index = 10
	if _, e := selectWindowsPhysicalRoute([]windowsRouteCandidate{good, other}); e == nil {
		t.Fatal("ambiguous route allowed")
	}
	other.Route.Metric++
	if _, e := selectWindowsPhysicalRoute([]windowsRouteCandidate{other, good}); e != nil {
		t.Fatal(e)
	}
	wireless := good
	wireless.Type = 71
	if _, e := selectWindowsPhysicalRoute([]windowsRouteCandidate{wireless}); e != nil {
		t.Fatal(e)
	}
	if windowsInterfaceNetworkOrder(23) != 0x17000000 {
		t.Fatal("byte order")
	}
}

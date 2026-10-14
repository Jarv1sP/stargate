package main

import (
	"errors"
	"net"
)

// Costs combine IPv4 route and interface metrics. Virtual defaults never win.
type windowsRouteCandidate struct {
	Route                   route
	Hardware, Up, Connected bool
	Type                    uint32
	LUID                    uint64
}

func selectWindowsPhysicalRoute(rows []windowsRouteCandidate) (route, error) {
	var chosen route
	found, ambiguous := false, false
	for _, c := range rows {
		gateway := net.ParseIP(c.Route.Gateway)
		if !c.Hardware || !c.Up || !c.Connected || (c.Type != 6 && c.Type != 71) || c.LUID == 0 || c.Route.Index <= 0 || c.Route.Index >= 1<<24 || c.Route.Addresses == "" || gateway == nil || gateway.To4() == nil || !gateway.IsGlobalUnicast() {
			continue
		}
		if !found || c.Route.Metric < chosen.Metric {
			chosen = c.Route
			found = true
			ambiguous = false
		} else if c.Route.Metric == chosen.Metric && c.Route != chosen {
			ambiguous = true
		}
	}
	if !found || ambiguous {
		return route{}, errors.New("PHYSICAL_ROUTE_UNAVAILABLE")
	}
	return chosen, nil
}
func windowsInterfaceNetworkOrder(index int) int {
	v := uint32(index)
	return int(v>>24 | v>>8&0xff00 | v<<8&0xff0000 | v<<24)
}

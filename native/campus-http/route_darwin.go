//go:build darwin

package main

import (
	"errors"
	"net"
	"sort"
	"strings"
	"syscall"
)

// Read the kernel routing table, without shell commands or route changes.
func currentRoute() (route, error) {
	raw, e := syscall.RouteRIB(syscall.NET_RT_DUMP, 0)
	if e != nil {
		return route{}, errors.New("ROUTE_UNCONFIRMED")
	}
	messages, e := syscall.ParseRoutingMessage(raw)
	if e != nil {
		return route{}, errors.New("ROUTE_UNCONFIRMED")
	}
	var candidates []route
	for _, message := range messages {
		m, ok := message.(*syscall.RouteMessage)
		if !ok {
			continue
		}
		r, ok := darwinDefaultRoute(m)
		if !ok {
			continue
		}
		nic, err := net.InterfaceByIndex(r.Index)
		if err != nil || nic.Flags&net.FlagUp == 0 || nic.Flags&(net.FlagLoopback|net.FlagPointToPoint) != 0 || len(nic.HardwareAddr) != 6 {
			continue
		}
		addresses, err := nic.Addrs()
		if err != nil {
			continue
		}
		var v4 []string
		for _, address := range addresses {
			ip, _, err := net.ParseCIDR(address.String())
			if err == nil && ip.To4() != nil && !ip.IsLoopback() && ip.IsGlobalUnicast() {
				v4 = append(v4, address.String())
			}
		}
		if len(v4) == 0 {
			continue
		}
		sort.Strings(v4)
		r.Name, r.Addresses = nic.Name, strings.Join(v4, ",")
		candidates = append(candidates, r)
	}
	return selectDarwinRoute(candidates)
}

func darwinDefaultRoute(m *syscall.RouteMessage) (route, bool) {
	if m.Header.Flags&(syscall.RTF_UP|syscall.RTF_GATEWAY) != syscall.RTF_UP|syscall.RTF_GATEWAY ||
		m.Header.Flags&(syscall.RTF_HOST|syscall.RTF_REJECT|syscall.RTF_BLACKHOLE) != 0 {
		return route{}, false
	}
	addresses, e := syscall.ParseRoutingSockaddr(m)
	if e != nil {
		return route{}, false
	}
	destination, ok := addresses[syscall.RTAX_DST].(*syscall.SockaddrInet4)
	if !ok || destination.Addr != [4]byte{} {
		return route{}, false
	}
	if mask := addresses[syscall.RTAX_NETMASK]; mask != nil {
		v4, ok := mask.(*syscall.SockaddrInet4)
		if !ok || v4.Addr != [4]byte{} {
			return route{}, false
		}
	}
	gateway, ok := addresses[syscall.RTAX_GATEWAY].(*syscall.SockaddrInet4)
	if !ok || !net.IP(gateway.Addr[:]).IsGlobalUnicast() {
		return route{}, false
	}
	r := route{Index: int(m.Header.Index), Gateway: net.IP(gateway.Addr[:]).String(), Metric: uint64(m.Header.Rmx.Hopcount)}
	// macOS marks secondary, interface-scoped defaults separately from the
	// primary default. Prefer the primary while keeping hop-count ordering.
	if m.Header.Flags&syscall.RTF_IFSCOPE != 0 {
		r.Metric += 1 << 32
	}
	return r, true
}

func bindPhysicalInterface(fd uintptr, r route) error {
	return syscall.SetsockoptInt(int(fd), syscall.IPPROTO_IP, syscall.IP_BOUND_IF, r.Index)
}

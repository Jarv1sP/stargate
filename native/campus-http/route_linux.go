//go:build linux

package main

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
)

func currentRoute() (route, error) {
	raw, e := os.ReadFile("/proc/net/route")
	if e != nil || len(raw) > 65536 {
		return route{}, errors.New("ROUTE_UNCONFIRMED")
	}
	r, e := defaultRoute(string(raw))
	if e != nil {
		return route{}, e
	}
	nic, e := net.InterfaceByName(r.Name)
	if e != nil || nic.Flags&net.FlagUp == 0 || nic.Flags&net.FlagLoopback != 0 || len(nic.HardwareAddr) != 6 {
		return route{}, errors.New("PHYSICAL_ROUTE_UNAVAILABLE")
	}
	base := filepath.Join("/sys/class/net", r.Name)
	kind, e := os.ReadFile(filepath.Join(base, "type"))
	if e != nil || strings.TrimSpace(string(kind)) != "1" {
		return route{}, errors.New("PHYSICAL_ROUTE_UNAVAILABLE")
	}
	if _, e = os.Lstat(filepath.Join(base, "tun_flags")); e == nil || !os.IsNotExist(e) {
		return route{}, errors.New("PHYSICAL_ROUTE_UNAVAILABLE")
	}
	addresses, e := nic.Addrs()
	if e != nil {
		return route{}, errors.New("ROUTE_UNCONFIRMED")
	}
	v4 := []string{}
	for _, address := range addresses {
		ip, _, err := net.ParseCIDR(address.String())
		if err == nil && ip.To4() != nil && !ip.IsLoopback() && ip.IsGlobalUnicast() {
			v4 = append(v4, address.String())
		}
	}
	if len(v4) == 0 {
		return route{}, errors.New("PHYSICAL_ROUTE_UNAVAILABLE")
	}
	sort.Strings(v4)
	r.Index = nic.Index
	r.Addresses = strings.Join(v4, ",")
	return r, nil
}

func bindPhysicalInterface(fd uintptr, r route) error {
	return syscall.SetsockoptString(int(fd), syscall.SOL_SOCKET, syscall.SO_BINDTODEVICE, r.Name)
}

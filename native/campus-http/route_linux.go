//go:build linux

package main

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
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

func physicalDial(ctx context.Context, r route, host, port string) (net.Conn, error) {
	ips, e := net.DefaultResolver.LookupIP(ctx, "ip4", host)
	if e != nil {
		return nil, errors.New("DNS_FAILED")
	}
	// A grant never becomes a public VPS/Tail route through DNS or proxy fallback.
	var address net.IP
	for _, ip := range ips {
		if ip.To4() != nil && ip.IsPrivate() {
			address = ip
			break
		}
	}
	if address == nil {
		return nil, errors.New("CAMPUS_ADDRESS_REQUIRED")
	}
	nic, e := net.InterfaceByIndex(r.Index)
	if e != nil || nic.Name != r.Name {
		return nil, errors.New("NETWORK_CHANGED")
	}
	dialer := net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second, Control: func(network, address string, c syscall.RawConn) error {
		var bindErr error
		if e := c.Control(func(fd uintptr) {
			bindErr = syscall.SetsockoptString(int(fd), syscall.SOL_SOCKET, syscall.SO_BINDTODEVICE, r.Name)
		}); e != nil {
			return errors.New("PHYSICAL_BIND_DENIED")
		}
		if bindErr != nil {
			return errors.New("PHYSICAL_BIND_DENIED")
		}
		return nil
	}}
	if _, e = strconv.Atoi(port); e != nil {
		return nil, errors.New("INVALID_ORIGIN")
	}
	conn, e := dialer.DialContext(ctx, "tcp4", net.JoinHostPort(address.String(), port))
	if e != nil {
		return nil, dialFailure(e)
	}
	return conn, nil
}

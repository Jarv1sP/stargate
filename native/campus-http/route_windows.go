//go:build windows

package main

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

// SDK layouts for bounded read-only IPHelper queries. Go syscall registers
// iphlpapi.dll for System32-only loading before this lazy DLL is loaded.
var windowsIPHelper = syscall.NewLazyDLL("iphlpapi.dll")
var getForwardTable = windowsIPHelper.NewProc("GetIpForwardTable2")
var freeForwardTable = windowsIPHelper.NewProc("FreeMibTable")
var getAdapters = windowsIPHelper.NewProc("GetAdaptersAddresses")
var getInterface = windowsIPHelper.NewProc("GetIfEntry2")

type windowsForwardRow struct {
	LUID                                    uint64
	Index                                   uint32
	Prefix                                  [28]byte
	PrefixLength                            byte
	_                                       [3]byte
	NextHop                                 [28]byte
	SitePrefix                              byte
	_                                       [3]byte
	Valid, Preferred, Metric, Protocol      uint32
	Loopback, Autoconfig, Publish, Immortal byte
	Age, Origin                             uint32
}
type windowsInterfaceRow struct {
	LUID                                                  uint64
	Index                                                 uint32
	GUID                                                  [16]byte
	Alias, Description                                    [257]uint16
	AddressLength                                         uint32
	Address, Permanent                                    [32]byte
	MTU, Type, Tunnel, Media, Physical, Access, Direction uint32
	Flags                                                 byte
	_                                                     [3]byte
	Oper, Admin, Connected                                uint32
	Network                                               [16]byte
	Connection                                            uint32
	_                                                     [4]byte
	Counters                                              [20]uint64
}
type windowsAdapter struct {
	Length, Index                                    uint32
	Next                                             *windowsAdapter
	AdapterName                                      uintptr
	Unicast, Anycast, Multicast, DNS                 uintptr
	Suffix, Description, FriendlyName                uintptr
	Address                                          [8]byte
	AddressLength, Flags, MTU, Type, Oper, IPv6Index uint32
	Zones                                            [16]uint32
	Prefix                                           uintptr
	TxSpeed, RxSpeed                                 uint64
	WINS, Gateway                                    uintptr
	IPv4Metric, IPv6Metric                           uint32
	LUID                                             uint64
}

func windowsABIValid() bool {
	return unsafe.Sizeof(windowsForwardRow{}) == 104 && unsafe.Offsetof(windowsForwardRow{}.NextHop) == 44 && unsafe.Sizeof(windowsInterfaceRow{}) == 1352 && unsafe.Offsetof(windowsInterfaceRow{}.Flags) == 1152 && unsafe.Sizeof(windowsAdapter{}) == 232 && unsafe.Offsetof(windowsAdapter{}.IPv4Metric) == 216
}
func windowsAdapterMetrics() (map[uint32]windowsAdapter, error) {
	size := uint32(15000)
	buf := make([]byte, size)
	for attempt := 0; attempt < 2; attempt++ {
		code, _, _ := getAdapters.Call(2, 2|4|8, 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)))
		if code == 111 && attempt == 0 && size <= 1024*1024 && size >= 15000 {
			buf = make([]byte, size)
			continue
		}
		if code != 0 {
			return nil, errors.New("ROUTE_UNCONFIRMED")
		}
		break
	}
	base := uintptr(unsafe.Pointer(&buf[0]))
	end := base + uintptr(len(buf))
	out := map[uint32]windowsAdapter{}
	seen := map[uintptr]bool{}
	for p := (*windowsAdapter)(unsafe.Pointer(&buf[0])); p != nil; p = p.Next {
		at := uintptr(unsafe.Pointer(p))
		if len(seen) >= 256 || seen[at] || at < base || at+unsafe.Sizeof(*p) > end || p.Length < uint32(unsafe.Sizeof(*p)) {
			return nil, errors.New("ROUTE_UNCONFIRMED")
		}
		seen[at] = true
		if p.Index != 0 {
			if _, duplicate := out[p.Index]; duplicate {
				return nil, errors.New("ROUTE_UNCONFIRMED")
			}
			out[p.Index] = *p
		}
	}
	runtime.KeepAlive(buf)
	return out, nil
}
func currentRoute() (route, error) {
	if !windowsABIValid() {
		return route{}, errors.New("ROUTE_UNCONFIRMED")
	}
	adapters, e := windowsAdapterMetrics()
	if e != nil {
		return route{}, e
	}
	var table uintptr
	code, _, _ := getForwardTable.Call(2, uintptr(unsafe.Pointer(&table)))
	if code != 0 || table == 0 {
		return route{}, errors.New("ROUTE_UNCONFIRMED")
	}
	defer freeForwardTable.Call(table)
	count := *(*uint32)(unsafe.Pointer(table))
	if count > 4096 {
		return route{}, errors.New("ROUTE_UNCONFIRMED")
	}
	candidates := []windowsRouteCandidate{}
	for i := uint32(0); i < count; i++ {
		row := *(*windowsForwardRow)(unsafe.Pointer(table + 8 + uintptr(i)*unsafe.Sizeof(windowsForwardRow{})))
		if row.PrefixLength != 0 || binary.LittleEndian.Uint16(row.Prefix[:2]) != 2 || binary.LittleEndian.Uint16(row.NextHop[:2]) != 2 || row.Loopback != 0 || row.Valid == 0 {
			continue
		}
		a, ok := adapters[row.Index]
		if !ok || a.LUID != row.LUID {
			continue
		}
		iface := windowsInterfaceRow{LUID: row.LUID, Index: row.Index}
		result, _, _ := getInterface.Call(uintptr(unsafe.Pointer(&iface)))
		if result != 0 || iface.Index != row.Index || iface.LUID != row.LUID {
			return route{}, errors.New("NETWORK_CHANGED")
		}
		if iface.Flags&1 == 0 || iface.Oper != 1 || iface.Connected != 1 || (iface.Type != 6 && iface.Type != 71) {
			continue
		}
		nic, err := net.InterfaceByIndex(int(row.Index))
		if err != nil || nic.Flags&net.FlagUp == 0 || nic.Flags&net.FlagLoopback != 0 || len(nic.HardwareAddr) != 6 {
			return route{}, errors.New("NETWORK_CHANGED")
		}
		addresses, err := nic.Addrs()
		if err != nil {
			return route{}, errors.New("ROUTE_UNCONFIRMED")
		}
		v4 := []string{}
		for _, address := range addresses {
			ip, _, err := net.ParseCIDR(address.String())
			if err == nil && ip.To4() != nil && ip.IsGlobalUnicast() && !ip.IsLoopback() {
				v4 = append(v4, address.String())
			}
		}
		sort.Strings(v4)
		if len(v4) == 0 {
			continue
		}
		candidates = append(candidates, windowsRouteCandidate{Route: route{Name: nic.Name, Index: int(row.Index), Gateway: net.IP(row.NextHop[4:8]).String(), Metric: uint64(row.Metric) + uint64(a.IPv4Metric), Addresses: strings.Join(v4, ",") + fmt.Sprintf(";luid=%x;mac=%s", row.LUID, nic.HardwareAddr)}, Hardware: true, Up: true, Connected: true, Type: iface.Type, LUID: row.LUID})
	}
	return selectWindowsPhysicalRoute(candidates)
}
func windowsDial(ctx context.Context, r route, host, port string, campus bool) (net.Conn, error) {
	p, e := strconv.Atoi(port)
	if e != nil || p < 1 || p > 65535 || !campus && p != 443 {
		return nil, errors.New("INVALID_ORIGIN")
	}
	ips, e := net.DefaultResolver.LookupIP(ctx, "ip4", host)
	if e != nil {
		return nil, errors.New("DNS_FAILED")
	}
	var address net.IP
	for _, ip := range ips {
		v4 := ip.To4()
		if v4 == nil || !ip.IsGlobalUnicast() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
			continue
		}
		if campus && !ip.IsPrivate() {
			continue
		}
		if !campus && (ip.IsPrivate() || v4[0] == 100 && v4[1]&0xc0 == 64) {
			continue
		}
		address = ip
		break
	}
	if address == nil {
		if campus {
			return nil, errors.New("CAMPUS_ADDRESS_REQUIRED")
		}
		return nil, errors.New("CONTROL_ADDRESS_REQUIRED")
	}
	conn, bound, e := windowsSocketDial(ctx, windowsDialer(r, campus), net.JoinHostPort(address.String(), port), campus)
	if e != nil {
		return nil, dialFailure(e)
	}
	if !bound {
		return conn, nil
	}
	local, ok := conn.LocalAddr().(*net.TCPAddr)
	matched := false
	if ok {
		for _, cidr := range strings.Split(strings.Split(r.Addresses, ";")[0], ",") {
			ip, _, e := net.ParseCIDR(cidr)
			if e == nil && ip.Equal(local.IP) {
				matched = true
			}
		}
	}
	if !matched {
		conn.Close()
		return nil, errors.New("NETWORK_CHANGED")
	}
	return conn, nil
}

func windowsDialer(r route, campus bool) net.Dialer {
	d := net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	if !campus {
		return d
	}
	d.Control = func(_, _ string, c syscall.RawConn) error {
		var bind error
		if e := c.Control(func(fd uintptr) {
			bind = syscall.SetsockoptInt(syscall.Handle(fd), syscall.IPPROTO_IP, 31, windowsInterfaceNetworkOrder(r.Index))
			if bind == nil {
				var got int
				got, bind = syscall.GetsockoptInt(syscall.Handle(fd), syscall.IPPROTO_IP, 31)
				if bind == nil && got != r.Index {
					bind = errors.New("PHYSICAL_BIND_DENIED")
				}
			}
		}); e != nil || bind != nil {
			return errors.New("PHYSICAL_BIND_DENIED")
		}
		return nil
	}
	return d
}

// Binding is only for campus data. No HTTP or credential bytes are sent here.
func windowsSocketDial(ctx context.Context, d net.Dialer, address string, campus bool) (net.Conn, bool, error) {
	if campus {
		attempt, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
		conn, err := d.DialContext(attempt, "tcp4", address)
		cancel()
		if err == nil {
			return conn, true, nil
		}
		if ctx.Err() != nil {
			return nil, false, ctx.Err()
		}
		d.Control = nil
	}
	conn, err := d.DialContext(ctx, "tcp4", address)
	return conn, false, err
}
func physicalDial(ctx context.Context, r route, host, port string) (net.Conn, error) {
	return windowsDial(ctx, r, host, port, true)
}
func controlDial(ctx context.Context, network, address string) (net.Conn, error) {
	if network != "tcp" && network != "tcp4" {
		return nil, errors.New("INVALID_ORIGIN")
	}
	host, port, e := net.SplitHostPort(address)
	if e != nil {
		return nil, errors.New("INVALID_ORIGIN")
	}
	return windowsDial(ctx, route{}, host, port, false)
}

"""Concurrent TCP port scanner for small networks.

Uses plain TCP connect() so it needs no root rights and works on Windows,
macOS and Linux. Only scan networks you own or are allowed to test.
"""
from __future__ import annotations

import ipaddress
import socket
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

COMMON_PORTS = {
    22: "ssh", 53: "dns", 80: "http", 139: "netbios", 443: "https", 445: "smb",
    631: "ipp", 3389: "rdp", 5900: "vnc", 8080: "http-alt", 9100: "printer",
}

MAX_HOSTS = 1024


@dataclass
class HostResult:
    ip: str
    hostname: str | None = None
    open_ports: list[int] = field(default_factory=list)

    @property
    def services(self) -> list[str]:
        return [COMMON_PORTS.get(p, str(p)) for p in self.open_ports]

    def to_dict(self) -> dict:
        return {"ip": self.ip, "hostname": self.hostname,
                "open_ports": self.open_ports, "services": self.services}


def parse_ports(spec: str | None) -> list[int]:
    """Parse '22,80,8000-8010' into a sorted list of ports. None -> common ports."""
    if not spec:
        return sorted(COMMON_PORTS)
    ports: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            lo, hi = (int(x) for x in part.split("-", 1))
            if lo > hi:
                lo, hi = hi, lo
            ports.update(range(lo, hi + 1))
        else:
            ports.add(int(part))
    bad = [p for p in ports if not 1 <= p <= 65535]
    if bad:
        raise ValueError(f"invalid port(s): {bad[:5]}")
    return sorted(ports)


def expand_targets(target: str) -> list[str]:
    """Accept a single IP, a CIDR range or a hostname."""
    try:
        net = ipaddress.ip_network(target, strict=False)
    except ValueError:
        return [socket.gethostbyname(target)]
    hosts = [str(h) for h in net.hosts()] or [str(net.network_address)]
    if len(hosts) > MAX_HOSTS:
        raise ValueError(f"{target} has {len(hosts)} hosts; limit is {MAX_HOSTS}")
    return hosts


def check_port(ip: str, port: int, timeout: float) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(timeout)
        return s.connect_ex((ip, port)) == 0


def reverse_dns(ip: str) -> str | None:
    try:
        return socket.gethostbyaddr(ip)[0]
    except (socket.herror, socket.gaierror, OSError):
        return None


def scan(target: str, ports: list[int], timeout: float = 0.5, workers: int = 128,
         resolve: bool = True) -> list[HostResult]:
    hosts = expand_targets(target)
    jobs = [(ip, p) for ip in hosts for p in ports]
    results = {ip: HostResult(ip) for ip in hosts}

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for (ip, port), is_open in zip(jobs, pool.map(lambda j: check_port(*j, timeout), jobs)):
            if is_open:
                results[ip].open_ports.append(port)

    alive = [r for r in results.values() if r.open_ports]
    if resolve:
        with ThreadPoolExecutor(max_workers=32) as pool:
            for r, name in zip(alive, pool.map(reverse_dns, [r.ip for r in alive])):
                r.hostname = name
    alive.sort(key=lambda r: ipaddress.ip_address(r.ip))
    return alive

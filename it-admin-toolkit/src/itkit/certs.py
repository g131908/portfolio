"""Check TLS certificate expiry for a list of hosts - catches the 'website down on Monday' ticket early."""
from __future__ import annotations

import socket
import ssl
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone


@dataclass
class CertStatus:
    host: str
    port: int
    ok: bool
    days_left: int | None = None
    expires: str | None = None
    issuer: str | None = None
    error: str | None = None

    def level(self, warn_days: int = 30) -> str:
        if not self.ok:
            return "ERROR"
        if self.days_left is not None and self.days_left < 0:
            return "EXPIRED"
        if self.days_left is not None and self.days_left <= warn_days:
            return "WARN"
        return "OK"


def parse_target(target: str) -> tuple[str, int]:
    host, _, port = target.partition(":")
    return host, int(port) if port else 443


def days_until(not_after: str, now: datetime | None = None) -> int:
    """`not_after` uses OpenSSL's format, e.g. 'Jun  1 12:00:00 2027 GMT'."""
    expires = datetime.fromtimestamp(ssl.cert_time_to_seconds(not_after), tz=timezone.utc)
    now = now or datetime.now(timezone.utc)
    return (expires - now).days


def check(target: str, timeout: float = 5.0) -> CertStatus:
    host, port = parse_target(target)
    ctx = ssl.create_default_context()
    try:
        with socket.create_connection((host, port), timeout=timeout) as sock, \
                ctx.wrap_socket(sock, server_hostname=host) as tls:
            cert = tls.getpeercert()
    except (OSError, ssl.SSLError) as e:
        return CertStatus(host, port, ok=False, error=str(e)[:120])
    issuer = dict(x[0] for x in cert.get("issuer", ()))
    return CertStatus(
        host, port, ok=True,
        days_left=days_until(cert["notAfter"]),
        expires=cert["notAfter"],
        issuer=issuer.get("organizationName") or issuer.get("commonName"),
    )


def check_many(targets: list[str], timeout: float = 5.0) -> list[CertStatus]:
    with ThreadPoolExecutor(max_workers=16) as pool:
        return list(pool.map(lambda t: check(t, timeout), targets))

"""Python fixture: decorators, f-strings, type hints, regexp sub-grammar."""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, field
from typing import Iterable, Protocol

SEMVER = re.compile(r"^v?(?P<major>\d+)\.(?P<minor>\d+)\.(?P<patch>\d+)(?:-(?P<pre>[\w.]+))?$")


class Formatter(Protocol):
    def format(self, source: str) -> str: ...


@dataclass(slots=True)
class Release:
    tag: str
    assets: list[str] = field(default_factory=list)

    @property
    def version(self) -> tuple[int, int, int]:
        m = SEMVER.match(self.tag)
        if m is None:
            raise ValueError(f"bad tag: {self.tag!r}")
        return tuple(int(m.group(k)) for k in ("major", "minor", "patch"))  # type: ignore[return-value]

    def __str__(self) -> str:
        return f"{self.tag} ({len(self.assets)} assets)"


async def gather_sizes(urls: Iterable[str], *, limit: int = 4) -> dict[str, int]:
    sem = asyncio.Semaphore(limit)

    async def one(url: str) -> tuple[str, int]:
        async with sem:
            await asyncio.sleep(0)
            return url, len(url)

    return dict(await asyncio.gather(*(one(u) for u in urls)))


def main() -> int:
    rel = Release("v0.2.0", assets=["poly-linux-x64", "poly-win32-x64.exe"])
    match rel.version:
        case (0, minor, _) if minor < 3:
            print(f"early release: {rel}")
        case (major, *_):
            print(f"stable line {major}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

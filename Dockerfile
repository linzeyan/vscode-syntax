# poly in a container, for CI that runs jobs in an image rather than on a
# runner with actions.
#
# The binary is not built here. release.yml already compiles it once per
# platform with the shipped profile (fat LTO, size-gated), and rebuilding it
# under emulation to make one image would take longer than the whole release
# and produce a different binary than the one users download. The workflow
# stages the release artifacts as docker/poly-<arch> and this only assembles
# them, so `docker buildx build --platform linux/amd64,linux/arm64` costs a
# copy per architecture.
#
# To build locally:
# cargo build --release --manifest-path cli/Cargo.toml
# mkdir -p docker && cp cli/target/release/poly docker/poly-$(dpkg --print-architecture)
# docker build -t poly .
#
# docker-root-user wants a USER. This image is a CI tool, not a service: it
# writes into a checkout mounted at /work that belongs to whoever the runner
# runs as, and a fixed non-root UID baked in here would own none of it -- the
# same mismatch the `safe.directory` line below already works around.
# poly: ignore poly/docker-root-user
FROM ubuntu:24.04

# Matches the runner the binary is compiled on. A slimmer base is tempting,
# but the release binary links glibc 2.39 and bookworm ships 2.36, so it would
# fail at exec with a message about the loader rather than anything readable.
ARG TARGETARCH

# ca-certificates: poly downloads its external linters over TLS on first use,
# and without them every one of them is "unavailable, skipping its files".
# git: `--changed` and the Git Repo scope shell out to it.
#
# Both are deliberately unpinned. Ubuntu drops the old version from the archive
# the moment a security update lands, so a pin here means the image stops
# building on someone else's schedule -- and these two are a CA bundle and git,
# where the newest patch is the one you want.
RUN apt-get update \
  # The suppression sits here rather than above the RUN because the finding
  # lands on the package it names, not on the instruction.
  # poly: ignore poly/docker-apt-get-unpinned
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

COPY --chmod=755 docker/poly-${TARGETARCH} /usr/local/bin/poly
# An image is a copy of the software, and MIT asks for the notice to come with
# it. `docker run --entrypoint cat poly /usr/share/doc/poly/LICENSE` reads it.
COPY LICENSE /usr/share/doc/poly/LICENSE
# Cheap, and the one failure this image can have that is otherwise invisible
# until someone runs it: the wrong architecture's binary staged under the
# right name produces "exec format error" at `docker run`, not at build.
RUN poly --version

# Where poly caches the linters it downloads. Declared so a CI job can mount a
# volume here and stop re-fetching tens of megabytes on every run.
ENV XDG_CACHE_HOME=/cache
VOLUME /cache

# Checking out a repo as one user and running the container as another is the
# normal case in CI, and git refuses to operate in a directory it thinks
# belongs to someone else. poly reads .gitignore through git's rules, so that
# refusal would silently change which files get linted.
RUN git config --system --add safe.directory '*'

WORKDIR /work
ENTRYPOINT ["poly"]
CMD ["--help"]

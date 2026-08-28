FROM rust:1.97-slim AS builder
WORKDIR /app
COPY . .
RUN cargo build --release

FROM debian:bookworm-slim
COPY --from=builder /app/target/release/poly /usr/local/bin/poly
ENTRYPOINT ["poly"]
CMD ["check", "."]

# Benchmark record

These are observed single-run measurements, not performance guarantees. They are retained to make regressions visible. Request latency includes the public API call and LevelDB work, excludes database initialization, and is measured sequentially with warm-up. RSS is process RSS delta for each series, so GC can make it negative. p50/p95/p99 are per-call samples.

## Environment

- Windows x64, Node.js v20.19.4
- 12th Gen Intel Core i5-12450H, 16 GiB RAM
- LevelDB on the local workspace filesystem
- Local series: 2,000 requests per operation, 500 warm-up writes
- gRPC series: 500 unary requests, batches of 100, 20 scan-page samples

## Before implementation

Recorded before record envelopes, TTL, and core bulk/scanning changes, using the same local benchmark workload. The baseline did not contain gRPC or batch tests.

| Operation | ops/s | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|
| SET object | 38,600 | 0.0236 | 0.0323 | 0.0620 |
| GET object | 41,300 | 0.0200 | 0.0394 | 0.0701 |
| EXISTS | 54,500 | 0.0173 | 0.0197 | 0.0411 |
| Sequential SET reference | 41,700 | 0.0226 | 0.0276 | 0.0628 |
| DELETE | 36,100 | 0.0228 | 0.0550 | 0.0903 |
| Hash set + get | 21,300 | — | — | — |
| Sorted Set set + get | 22,700 | — | — | — |

## After implementation

Most recent representative local run (`node benchmark/local.cjs 2000`):

| Operation | ops/s | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|
| SET object | 22,069 | 0.0331 | 0.0995 | 0.1491 |
| GET object | 26,486 | 0.0275 | 0.0830 | 0.1324 |
| EXISTS | 34,473 | 0.0236 | 0.0512 | 0.1073 |
| Sequential SET reference | 30,229 | 0.0289 | 0.0539 | 0.0934 |
| DELETE | 34,751 | 0.0246 | 0.0491 | 0.0901 |
| Hash set + get | 15,444 | 0.0549 | 0.1131 | 0.1908 |
| Sorted Set set + get | 15,155 | 0.0560 | 0.1190 | 0.2044 |

The new record envelope and per-key correctness/TTL work reduced throughput in this run: local SET/GET are about 43%/36% below the recorded baseline. DELETE is close to baseline. This is a measured regression and further profiling/optimization is needed; no general local speedup is claimed.

Representative local gRPC run (`node benchmark/grpc.cjs 500`):

| Operation | ops/s | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|
| gRPC SET | 1,124 | 0.8213 | 1.3137 | 1.8125 |
| gRPC GET | 1,374 | 0.6327 | 1.2047 | 1.9002 |
| gRPC TTL SET | 1,396 | 0.6385 | 1.0712 | 2.2757 |
| gRPC batch of 100 (5 samples) | 349 batches/s | 2.2816 | 5.0686 | 5.0686 |
| gRPC scan page of 100 (20 samples) | 437 pages/s | 2.0260 | 5.4741 | 5.4741 |

The gRPC run is loopback-only and is not an old REST comparison. Its short batch sample count is too small for stable tail-latency conclusions. The code can reproduce and expand these measurements; before/after remote comparison is unavailable because there is no matching baseline remote benchmark script.

Encryption size run (`node benchmark/encryption.cjs 30`), selected samples:

| Payload | Operation | Plain p50 / p95 ms | GCM p50 / p95 ms |
|---:|---|---:|---:|
| 4 KiB | SET | 0.0457 / 0.1595 | 0.0782 / 0.1315 |
| 4 KiB | GET | 0.0293 / 0.0876 | 0.0413 / 0.0837 |
| 1 MiB | SET | 3.3131 / 16.7313 | 5.4448 / 21.8520 |
| 1 MiB | GET | 1.0399 / 1.8326 | 1.8803 / 2.5813 |

This short run shows measurable encryption overhead, especially for 1 MiB values, but is substantially lower than the earlier text/Base64 binary path. Encrypted Buffers now use a compact authenticated binary GCM envelope. The benchmark measures serialization, encryption/decryption, and storage together; it does not isolate the crypto primitive from the storage stack.

## Reproduce

```bash
npm run build
node benchmark/local.cjs 2000
node benchmark/grpc.cjs 500
node benchmark/encryption.cjs 100
```

The local script additionally reports RSS and CPU deltas and covers bulk batches, TTL operations, and scans. The gRPC script reports corresponding unary, batch, and scan measurements. Use multiple runs and matching hardware/filesystem conditions before making decisions from these numbers.

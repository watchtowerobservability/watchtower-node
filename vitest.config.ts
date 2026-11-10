// Tests pass their own span exporter; keep the default OTLP log/metric exporters from dialing localhost:4318.
// A test that wants a signal passes `logs: true` / `metrics: true` or an explicit exporter.
export default { test: { env: { OTEL_LOGS_EXPORTER: 'none', OTEL_METRICS_EXPORTER: 'none' } } };

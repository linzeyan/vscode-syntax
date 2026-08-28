// Grafana dashboard fragment.
local grafana = import 'grafonnet/grafana.libsonnet';
local defaults = {
  datasource: 'prometheus',
  interval: '1m',
};

local panel(title, expr, unit='short') = {
  title: title,
  type: 'timeseries',
  datasource: defaults.datasource,
  targets: [{ expr: expr, legendFormat: '{{instance}}' }],
  fieldConfig: { defaults: { unit: unit } },
};

{
  _config:: {
    namespace: 'poly',
    thresholds: { p95Ms: 200 },
  },

  dashboard: grafana.dashboard.new(
    title='poly latency',
    tags=['poly', 'lsp'],
  ) + {
    panels: [
      panel('format p95', 'histogram_quantile(0.95, rate(poly_fmt_seconds_bucket[5m]))', 'ms'),
      panel('daemon RSS', 'process_resident_memory_bytes{job="poly"}', 'bytes'),
    ],
    templating: { list: [{ name: 'instance', query: 'label_values(instance)' }] },
  },

  assert $._config.thresholds.p95Ms <= 200 : 'budget regression',
}

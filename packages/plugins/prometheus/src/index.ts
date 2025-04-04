import { type GatewayPlugin } from '@graphql-hive/gateway-runtime';
import type { OnSubgraphExecuteHook } from '@graphql-mesh/fusion-runtime';
import type { TransportEntry } from '@graphql-mesh/transport-common';
import type {
  Logger,
  MeshFetchRequestInit,
  MeshPlugin,
  OnFetchHook,
} from '@graphql-mesh/types';
import { getHeadersObj } from '@graphql-mesh/utils';
import {
  isAsyncIterable,
  type ExecutionRequest,
  type ExecutionResult,
} from '@graphql-tools/utils';
import type {
  CounterAndLabels,
  CounterMetricOption,
  FillLabelsFnParams,
  HistogramAndLabels,
  HistogramMetricOption,
  PrometheusTracingPluginConfig,
  SummaryAndLabels,
} from '@graphql-yoga/plugin-prometheus';
import {
  createCounter,
  createHistogram,
  createSummary,
  getCounterFromConfig,
  getHistogramFromConfig,
  usePrometheus as useYogaPrometheus,
} from '@graphql-yoga/plugin-prometheus';
import { type Plugin as YogaPlugin } from 'graphql-yoga';
import { register as defaultRegistry, Registry } from 'prom-client';

export { createCounter, createHistogram, createSummary };
export type {
  CounterAndLabels,
  FillLabelsFnParams,
  HistogramAndLabels,
  SummaryAndLabels,
};

const DEFAULT_METRICS_CONFIG: PrometheusPluginOptions['metrics'] = {
  graphql_envelop_deprecated_field: true,
  graphql_envelop_request: true,
  graphql_envelop_request_duration: true,
  graphql_envelop_request_time_summary: true,
  graphql_envelop_phase_parse: true,
  graphql_envelop_phase_validate: true,
  graphql_envelop_phase_context: true,
  graphql_envelop_error_result: true,
  graphql_envelop_execute_resolver: false,
  graphql_envelop_phase_execute: true,
  graphql_envelop_phase_subscribe: true,
  graphql_envelop_schema_change: true,
  graphql_yoga_http_duration: true,
  graphql_gateway_fetch_duration: true,
  graphql_gateway_subgraph_execute_duration: true,
  graphql_gateway_subgraph_execute_errors: true,
};

type MeshMetricsConfig = {
  metrics: {
    /**
     * Tracks the duration of outgoing HTTP requests.
     * It reports the time spent on each request made using the `fetch` function provided by Mesh.
     * It is reported as an histogram.
     *
     * You can pass multiple type of values:
     *  - boolean: Disable or Enable the metric with default configuration
     *  - string: Enable the metric with custom name
     *  - number[]: Enable the metric with custom buckets
     *  - string[]: Enable the metric on a list of phases
     *  - ReturnType<typeof createHistogram>: Enable the metric with custom configuration
     */
    graphql_gateway_fetch_duration: HistogramMetricOption<
      'fetch',
      string,
      FetchMetricsLabelParams
    >;

    /**
     * Tracks the duration of subgraph execution.
     * It reports the time spent on each subgraph queries made to resolve incoming operations as an
     * histogram.
     *
     * You can pass multiple type of values:
     *  - boolean: Disable or Enable the metric with default configuration
     *  - string: Enable the metric with custom name
     *  - number[]: Enable the metric with custom buckets
     *  - string[]: Enable the metric on a list of phases
     *  - ReturnType<typeof createHistogram>: Enable the metric with custom configuration
     */
    graphql_gateway_subgraph_execute_duration: HistogramMetricOption<
      'subgraphExecute',
      string,
      SubgraphMetricsLabelParams
    >;

    /**
     * This metric tracks the number of errors that occurred during the subgraph execution.
     * It counts all errors found in the response returned by the subgraph execution.
     * It is exposed as a counter
     *
     * You can pass multiple type of values:
     *  - boolean: Disable or Enable the metric with default configuration
     *  - string: Enable the metric with custom name
     *  - number[]: Enable the metric with custom buckets
     *  - string[]: Enable the metric on a list of phases
     *  - ReturnType<typeof createHistogram>: Enable the metric with custom configuration
     */
    graphql_gateway_subgraph_execute_errors: CounterMetricOption<
      'subgraphExecute',
      string,
      SubgraphMetricsLabelParams
    >;
  };

  labels?: {
    /**
     * The name of the targeted subgraph.
     */
    subgraphName?: boolean;
    /**
     * The type of the GraphQL operation executed by the subgraph.
     *
     * The headers to include in the label can be specified as an array of strings.
     */
    fetchRequestHeaders?: boolean | string[];
    /**
     * The name of the GraphQL operation executed by the subgraph.
     *
     * The headers to include in the label can be specified as an array of strings.
     */
    fetchResponseHeaders?: boolean | string[];
  };

  /**
   * The logger instance used by the plugin to log messages.
   * This should be the logger instance provided by Mesh in the plugins context.
   */
  logger: Logger;
};

export type PrometheusPluginOptions = PrometheusTracingPluginConfig &
  MeshMetricsConfig;

type SubgraphMetricsLabelParams = {
  subgraphName: string;
  transportEntry?: TransportEntry;
  executionRequest: ExecutionRequest;
};

type FetchMetricsLabelParams = {
  url: string;
  options: MeshFetchRequestInit;
  response: Response;
};

export default function useMeshPrometheus(
  pluginOptions: PrometheusPluginOptions,
): MeshPlugin<any> & YogaPlugin & GatewayPlugin {
  let registry: Registry;
  if (!pluginOptions.registry) {
    registry = defaultRegistry;
  } else if (typeof pluginOptions.registry !== 'string') {
    registry = pluginOptions.registry;
  } else {
    pluginOptions.logger.error(
      'Could not identify given prometheus registry. Utilizing default registry.',
    );
    registry = defaultRegistry;
  }

  const config: PrometheusPluginOptions = {
    ...pluginOptions,
    registry,
    metrics: {
      ...DEFAULT_METRICS_CONFIG,
      ...pluginOptions.metrics,
    },
  };

  const fetchLabelNames = [
    'url',
    'method',
    'statusCode',
    'statusText',
    'requestHeaders',
    'responseHeaders',
  ];
  // Since request and response headers can be large, they are disabled by default
  const { fetchRequestHeaders, fetchResponseHeaders } =
    pluginOptions.labels ?? {};
  if (fetchRequestHeaders) {
    fetchLabelNames.push('requestHeaders');
  }
  if (fetchResponseHeaders) {
    fetchLabelNames.push('responseHeaders');
  }

  const fetchHistogram = getHistogramFromConfig<
    'fetch',
    NonNullable<PrometheusPluginOptions['metrics']>,
    FetchMetricsLabelParams
  >(
    config,
    'graphql_gateway_fetch_duration',
    ['fetch'],
    {
      labelNames: fetchLabelNames,
      help: 'Time spent on outgoing HTTP calls',
    },
    ({ url, options, response }) => {
      if (!options.method) {
        throw new Error('Request method is missing from the options');
      }
      const labels: Record<string, string | number> = {
        url,
        method: options.method,
        statusCode: response.status,
        statusText: response.statusText,
      };

      if (fetchRequestHeaders) {
        labels['requestHeaders'] = JSON.stringify(
          filterHeaders(fetchRequestHeaders, options.headers || {}),
        );
      }
      if (fetchResponseHeaders) {
        labels['responseHeaders'] = JSON.stringify(
          filterHeaders(fetchResponseHeaders, getHeadersObj(response.headers)),
        );
      }
      return labels;
    },
  );

  const subgraphExecuteHistogram = getHistogramFromConfig<
    'subgraphExecute',
    NonNullable<PrometheusPluginOptions['metrics']>,
    SubgraphMetricsLabelParams
  >(
    config,
    'graphql_gateway_subgraph_execute_duration',
    ['subgraphExecute'],
    {
      labelNames: ['subgraphName', 'operationName', 'operationType'],
      help: 'Time spent on subgraph execution',
    },
    ({ subgraphName, executionRequest }) => ({
      subgraphName,
      operationName: executionRequest.operationName || 'Anonymous',
      operationType: executionRequest.operationType || 'query',
    }),
  );

  const subgraphExecuteErrorCounter = getCounterFromConfig<
    'subgraphExecute',
    NonNullable<PrometheusPluginOptions['metrics']>,
    SubgraphMetricsLabelParams
  >(
    config,
    'graphql_gateway_subgraph_execute_errors',
    ['subgraphExecute'],
    {
      labelNames: ['subgraphName', 'operationName', 'operationType'],
      help: 'Number of errors on subgraph execution',
    },
    ({ subgraphName, executionRequest }) => ({
      subgraphName,
      operationName: executionRequest.operationName || 'Anonymous',
      operationType: executionRequest.operationType || 'query',
    }),
  );

  const onSubgraphExecute: OnSubgraphExecuteHook | undefined =
    (subgraphExecuteHistogram || subgraphExecuteErrorCounter) &&
    ((payload) => {
      const start = Date.now();
      const { context } = payload.executionRequest.context;
      const onResult =
        subgraphExecuteErrorCounter &&
        (({ result }: { result: ExecutionResult }) => {
          if (result.errors) {
            result.errors.forEach(() => {
              if (subgraphExecuteErrorCounter.shouldObserve(payload, context)) {
                subgraphExecuteErrorCounter.counter.inc(
                  subgraphExecuteErrorCounter.fillLabelsFn(payload, context),
                );
              }
            });
          }
        });

      const onEnd =
        subgraphExecuteHistogram &&
        (() => {
          if (subgraphExecuteHistogram.shouldObserve(payload, context)) {
            const end = Date.now();
            const duration = (end - start) / 1000;
            subgraphExecuteHistogram.histogram.observe(
              subgraphExecuteHistogram.fillLabelsFn(payload, context),
              duration,
            );
          }
        });

      return ({ result }) => {
        if (isAsyncIterable(result)) {
          return {
            onNext: onResult,
            onEnd,
          };
        }

        onResult?.({ result });
        onEnd?.();
        return undefined;
      };
    });

  const onFetch: OnFetchHook<any> | undefined =
    fetchHistogram &&
    (({ url, options, context }) => {
      const start = Date.now();
      return ({ response }) => {
        const params = { url, options, response };
        if (fetchHistogram.shouldObserve(params, context)) {
          const end = Date.now();
          const duration = (end - start) / 1000;
          fetchHistogram.histogram.observe(
            fetchHistogram.fillLabelsFn({ url, options, response }, context),
            duration,
          );
        }
      };
    });

  return {
    onPluginInit({ addPlugin }) {
      addPlugin(
        // @ts-expect-error TODO: plugin context generic is missing in yoga's prometheus plugin
        useYogaPrometheus(config),
      );
    },
    onSubgraphExecute,
    onFetch,
    onDispose() {
      return registry.clear();
    },
  };
}

function filterHeaders(
  allowList: string[] | unknown,
  headers: Record<string, string>,
) {
  return Array.isArray(allowList)
    ? Object.fromEntries(
        Object.entries(headers).filter(([key]) => allowList.includes(key)),
      )
    : headers;
}

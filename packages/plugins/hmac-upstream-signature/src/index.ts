import type { GatewayPlugin } from '@graphql-hive/gateway-runtime';
import type { OnSubgraphExecutePayload } from '@graphql-mesh/fusion-runtime';
import { serializeExecutionRequest } from '@graphql-tools/executor-common';
import type { ExecutionRequest } from '@graphql-tools/utils';
import {
  handleMaybePromise,
  type MaybePromise,
} from '@whatwg-node/promise-helpers';
import type {
  FetchAPI,
  GraphQLParams,
  YogaLogger,
  Plugin as YogaPlugin,
} from 'graphql-yoga';
import jsonStableStringify from 'json-stable-stringify';

export type HMACUpstreamSignatureOptions = {
  secret: string;
  shouldSign?: (
    input: Pick<
      OnSubgraphExecutePayload<{}>,
      'subgraph' | 'subgraphName' | 'executionRequest'
    >,
  ) => boolean;
  extensionName?: string;
  serializeExecutionRequest?: (executionRequest: ExecutionRequest) => string;
};

const DEFAULT_EXTENSION_NAME = 'hmac-signature';
const DEFAULT_SHOULD_SIGN_FN: NonNullable<
  HMACUpstreamSignatureOptions['shouldSign']
> = () => true;

export const defaultExecutionRequestSerializer = (
  executionRequest: ExecutionRequest,
) =>
  jsonStableStringify(
    serializeExecutionRequest({
      executionRequest: {
        document: executionRequest.document,
        variables: executionRequest.variables,
      },
    }),
  );
export const defaultParamsSerializer = (params: GraphQLParams) =>
  jsonStableStringify({
    query: params.query,
    variables:
      params.variables != null && Object.keys(params.variables).length > 0
        ? params.variables
        : undefined,
  });

function createCryptoKey({
  textEncoder,
  crypto,
  secret,
  usages,
}: {
  textEncoder: TextEncoder;
  crypto: Crypto;
  secret: string;
  usages: KeyUsage[];
}): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages,
  );
}

export function useHmacUpstreamSignature(
  options: HMACUpstreamSignatureOptions,
): GatewayPlugin {
  if (!options.secret) {
    throw new Error(
      'Property "secret" is required for useHmacUpstreamSignature plugin',
    );
  }

  const shouldSign = options.shouldSign || DEFAULT_SHOULD_SIGN_FN;
  const extensionName = options.extensionName || DEFAULT_EXTENSION_NAME;
  const serializeExecutionRequest =
    options.serializeExecutionRequest || defaultExecutionRequestSerializer;
  let key$: MaybePromise<CryptoKey>;
  let fetchAPI: FetchAPI;
  let textEncoder: TextEncoder;
  let yogaLogger: YogaLogger;

  return {
    onYogaInit({ yoga }) {
      fetchAPI = yoga.fetchAPI;
      yogaLogger = yoga.logger;
    },
    onSubgraphExecute({
      subgraphName,
      subgraph,
      executionRequest,
      setExecutionRequest,
      logger = yogaLogger,
    }) {
      logger?.debug(`running shouldSign for subgraph ${subgraphName}`);

      if (shouldSign({ subgraphName, subgraph, executionRequest })) {
        logger?.debug(
          `shouldSign is true for subgraph ${subgraphName}, signing request`,
        );
        textEncoder ||= new fetchAPI.TextEncoder();
        return handleMaybePromise(
          () =>
            (key$ ||= createCryptoKey({
              textEncoder,
              crypto: fetchAPI.crypto,
              secret: options.secret,
              usages: ['sign'],
            })),
          (key) => {
            key$ = key;
            const serializedExecutionRequest =
              serializeExecutionRequest(executionRequest);
            const encodedContent = textEncoder.encode(
              serializedExecutionRequest,
            );
            return handleMaybePromise(
              () => fetchAPI.crypto.subtle.sign('HMAC', key, encodedContent),
              (signature) => {
                const extensionValue = fetchAPI.btoa(
                  String.fromCharCode(...new Uint8Array(signature)),
                );
                logger?.debug(
                  `produced hmac signature for subgraph ${subgraphName}, signature: ${extensionValue}, signed payload: ${serializedExecutionRequest}`,
                );

                setExecutionRequest({
                  ...executionRequest,
                  extensions: {
                    ...executionRequest.extensions,
                    [extensionName]: extensionValue,
                  },
                });
              },
            );
          },
        );
      } else {
        logger?.debug(
          `shouldSign is false for subgraph ${subgraphName}, skipping hmac signature`,
        );
      }
    },
  };
}

export type HMACUpstreamSignatureValidationOptions = {
  secret: string;
  extensionName?: string;
  serializeParams?: (params: GraphQLParams) => string;
};

export function useHmacSignatureValidation(
  options: HMACUpstreamSignatureValidationOptions,
): YogaPlugin {
  if (!options.secret) {
    throw new Error(
      'Property "secret" is required for useHmacSignatureValidation plugin',
    );
  }

  const extensionName = options.extensionName || DEFAULT_EXTENSION_NAME;
  let key$: MaybePromise<CryptoKey>;
  let textEncoder: TextEncoder;
  let logger: YogaLogger;
  const paramsSerializer = options.serializeParams || defaultParamsSerializer;

  return {
    onYogaInit({ yoga }) {
      logger = yoga.logger;
    },
    onParams({ params, fetchAPI }) {
      textEncoder ||= new fetchAPI.TextEncoder();
      const extension = params.extensions?.[extensionName];

      if (!extension) {
        logger.warn(
          `Missing HMAC signature: extension ${extensionName} not found in request.`,
        );

        throw new Error(
          `Missing HMAC signature: extension ${extensionName} not found in request.`,
        );
      }

      return handleMaybePromise(
        () =>
          (key$ ||= createCryptoKey({
            textEncoder,
            crypto: fetchAPI.crypto,
            secret: options.secret,
            usages: ['verify'],
          })),
        (key) => {
          key$ = key;
          const sigBuf = Uint8Array.from(atob(extension), (c) =>
            c.charCodeAt(0),
          );
          const serializedParams = paramsSerializer(params);
          logger.debug(
            `HMAC signature will be calculate based on serialized params: ${serializedParams}`,
          );

          return handleMaybePromise(
            () =>
              fetchAPI.crypto.subtle.verify(
                'HMAC',
                key,
                sigBuf,
                textEncoder.encode(serializedParams),
              ),
            (result) => {
              if (!result) {
                logger.error(
                  `HMAC signature does not match the body content. short circuit request.`,
                );

                throw new Error(
                  `Invalid HMAC signature: extension ${extensionName} does not match the body content.`,
                );
              }
            },
          );
        },
      );
    },
  };
}

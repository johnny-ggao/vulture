import {
  OPENAPI_V1_ENDPOINTS,
  type OpenApiV1Endpoint,
  type OpenApiV1EndpointByOperationId,
  type OpenApiV1OperationId,
} from "./generated/v1-endpoints";

type PathParamNames<Path extends string> =
  Path extends `${string}{${infer Param}}${infer Rest}`
    ? Param | PathParamNames<Rest>
    : never;

export type OpenApiV1PathParamNames<T extends OpenApiV1OperationId> =
  PathParamNames<OpenApiV1EndpointByOperationId<T>["path"]>;

export type OpenApiV1PathParams<T extends OpenApiV1OperationId> =
  [OpenApiV1PathParamNames<T>] extends [never]
    ? {}
    : { [K in OpenApiV1PathParamNames<T>]: string | number };

type OpenApiV1PathArgs<T extends OpenApiV1OperationId> =
  [OpenApiV1PathParamNames<T>] extends [never]
    ? [params?: OpenApiV1PathParams<T>]
    : [params: OpenApiV1PathParams<T>];

export const OPENAPI_V1_ENDPOINTS_BY_OPERATION_ID = Object.fromEntries(
  OPENAPI_V1_ENDPOINTS.map((endpoint) => [endpoint.operationId, endpoint]),
) as {
  readonly [Endpoint in OpenApiV1Endpoint as Endpoint["operationId"]]: Endpoint;
};

export function getOpenApiV1Endpoint<T extends OpenApiV1OperationId>(
  operationId: T,
): OpenApiV1EndpointByOperationId<T> {
  return OPENAPI_V1_ENDPOINTS_BY_OPERATION_ID[operationId] as unknown as OpenApiV1EndpointByOperationId<T>;
}

export function buildOpenApiV1Path<T extends OpenApiV1OperationId>(
  operationId: T,
  ...args: OpenApiV1PathArgs<T>
): string {
  const endpoint = getOpenApiV1Endpoint(operationId);
  const params = args[0] as Record<string, string | number> | undefined;
  return endpoint.path.replaceAll(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = params?.[name];
    if (value === undefined) {
      throw new Error(`missing OpenAPI path parameter '${name}' for ${operationId}`);
    }
    return encodeURIComponent(String(value));
  });
}

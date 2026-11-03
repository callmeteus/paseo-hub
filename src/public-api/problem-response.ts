import { ProblemSchema, type Problem } from "./contracts.js";

/**
 * JSON success body with the request id Hub already promised the caller.
 *
 * @param requestId - Caller or generated request id
 * @param status - HTTP status
 * @param schema - Response contract
 * @param value - Body to validate before it leaves the process
 * @returns The HTTP response
 */
export function success(
  requestId: string,
  status: number,
  schema: { parse(value: unknown): unknown },
  value: unknown,
): Response {
  return Response.json(schema.parse(value), { status, headers: { "x-request-id": requestId } });
}

/**
 * RFC 9457 problem for a public API failure.
 *
 * @param requestId - Caller or generated request id
 * @param status - HTTP status
 * @param code - Stable problem code
 * @param title - Short title
 * @param detail - Sentence the caller can show
 * @param issues - Field errors, when the request itself was invalid
 * @returns The problem response
 */
export function problem(
  requestId: string,
  status: number,
  code: string,
  title: string,
  detail: string,
  issues?: readonly { path: readonly (string | number)[]; message: string }[],
): Response {
  const body: Problem = ProblemSchema.parse({
    type: `https://paseo.sh/problems/${code.replaceAll("_", "-")}`,
    title,
    status,
    detail,
    code,
    requestId,
    ...(issues === undefined ? {} : { issues }),
  });
  return Response.json(body, {
    status,
    headers: {
      "content-type": "application/problem+json",
      "x-request-id": requestId,
      ...(status === 401 ? { "www-authenticate": "Bearer" } : {}),
    },
  });
}

/**
 * Storage was unreachable. The caller can retry.
 *
 * @param requestId - Caller or generated request id
 * @returns 503 problem
 */
export function infrastructureProblem(requestId: string): Response {
  return problem(
    requestId,
    503,
    "infrastructure_unavailable",
    "Service unavailable",
    "The operation could not reach durable storage. Retry the request later.",
  );
}

/**
 * Turns a schema failure into a problem response.
 *
 * @param requestId - Caller or generated request id
 * @param issues - Zod issues
 * @param detail - What was invalid
 * @returns 400 problem
 */
export function validationProblem(
  requestId: string,
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
  detail = "The request body contains invalid fields.",
): Response {
  return problem(
    requestId,
    400,
    "invalid_request",
    "Invalid request",
    detail,
    issues.map((issue) => ({
      path: issue.path.flatMap((part) => (typeof part === "symbol" ? [] : [part])),
      message: issue.message,
    })),
  );
}

/**
 * Fails the build when a result status has no response.
 *
 * @param value - Status the switch did not handle
 * @returns Never
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled public operation result: ${String(value)}`);
}

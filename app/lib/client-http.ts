export class ApiResponseError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(status: number, retryable: boolean, message: string) {
    super(message);
    this.name = "ApiResponseError";
    this.status = status;
    this.retryable = retryable;
  }
}

export async function readApiJson<T>(response: Response): Promise<T> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    throw new ApiResponseError(
      response.status,
      response.status >= 500,
      response.status >= 500
        ? "ClearBox's cloud worker was interrupted. Retrying shortly may help."
        : "ClearBox received an unexpected server response.",
    );
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiResponseError(
      response.status,
      response.status >= 500,
      "ClearBox received an invalid server response.",
    );
  }
}

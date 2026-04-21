interface ApiErrorResponse {
  message?: string;
  error?: string;
}

export async function readApiError(response: Response): Promise<string> {
  try {
    const data = await response.json() as ApiErrorResponse;
    return data.message || data.error || `Request failed with status ${String(response.status)}`;
  } catch {
    return `Request failed with status ${String(response.status)}`;
  }
}

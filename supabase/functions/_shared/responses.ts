export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...init?.headers,
    },
  });
}

export function errorResponse(message: string, status = 500): Response {
  return jsonResponse(
    {
      status: 'error',
      detail: message,
    },
    { status },
  );
}

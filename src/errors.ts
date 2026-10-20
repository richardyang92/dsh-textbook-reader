/** Typed application errors that map to one HTTP response, with no secret detail. */

export class AppError extends Error {
  readonly status: number
  readonly code: string
  readonly hint?: string

  constructor(status: number, code: string, message: string, hint?: string) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.code = code
    this.hint = hint
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError
}

/** 400 — malformed or missing input. */
export function badRequest(message: string, code = 'bad_request'): AppError {
  return new AppError(400, code, message)
}

/** 404 — a book or resource does not exist. */
export function notFound(message = '资源不存在'): AppError {
  return new AppError(404, 'not_found', message)
}

/** 409 — the request conflicts with current state. */
export function conflict(code: string, message: string, hint?: string): AppError {
  return new AppError(409, code, message, hint)
}

/** 413 — the request exceeds a documented limit. */
export function tooLarge(message: string): AppError {
  return new AppError(413, 'payload_too_large', message)
}

/** 422 — the PDF is valid input but cannot be processed. */
export function unprocessable(code: string, message: string, hint?: string): AppError {
  return new AppError(422, code, message, hint)
}

export class AppError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 413 | 415 | 422 | 503,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what = "Not found") => new AppError(404, what);
export const forbidden = (what = "You do not have access to this.") => new AppError(403, what);
export const invalid = (what: string) => new AppError(422, what);
export const conflict = (what: string) => new AppError(409, what);
export const unavailable = (what: string) => new AppError(503, what);

export const STALE_MESSAGE =
  "This job changed after the page was loaded, so nothing was saved. Reload the job and try again.";

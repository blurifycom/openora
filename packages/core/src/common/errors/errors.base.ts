export class AppError extends Error {
  constructor(
    public override message: string,
    public code: string,
    public meta?: unknown,
  ) {
    super(message);
  }
}

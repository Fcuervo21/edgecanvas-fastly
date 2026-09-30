/** An expected request failure with an HTTP status; safe to show to the caller. */
export class RoomError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

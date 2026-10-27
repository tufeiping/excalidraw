/** Raised for any provider/transport failure; `status` mirrors HTTP status. */
export class AgentRequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "AgentRequestError";
  }
}

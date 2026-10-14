export class TaskmdError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_found"
      | "invalid_transition"
      | "dependencies_open"
      | "children_open"
      | "leased"
      | "invalid_input"
      | "parse_error"
      | "no_vault"
      | "forbidden",
  ) {
    super(message);
    this.name = "TaskmdError";
  }
}

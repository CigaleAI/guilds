import { ApiError } from "../../api/client";

/**
 * Whether the server refused a change to an integration's keys until the admin confirms replacing
 * them, as it does while logins depend on the GitHub App.
 */
export function asksToConfirmReplace(error: Error): boolean {
  return error instanceof ApiError && error.status === 409;
}

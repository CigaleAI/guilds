/**
 * The app started or rendered without a piece its wiring provides, such as the page's root
 * element or a context provider above a hook. It is a fault in how the app is assembled, never in
 * what the operator did.
 */
export class AppWiringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppWiringError";
  }
}

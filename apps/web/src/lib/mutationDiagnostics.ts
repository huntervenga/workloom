/** Payload-free diagnostic: never print a command, response, error object, secret or field value. */
export function reportMutationObserverFailure(): void {
  try { console.error('MUTATION_CONFIRMED_OBSERVER_FAILED'); }
  catch { /* Diagnostics must not change a confirmed command outcome. */ }
}

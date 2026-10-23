/** Session meta records the Vinculum agent as `vinculum`. `omp` is the registry key and a file the daemon has not rewritten yet. */
export function isVinculumHarness(key: string): boolean {
  return key === "vinculum" || key === "omp";
}

/**
 * Development-only URL switches for the mock engine (npm run web, dev:mock):
 *   ?window=setup                  the first-run Setup window, on a fresh Mac (scenario "fresh")
 *   ?firstrun=<scenario>           fresh · resume · disk · network · checksum · optional-fail · slow
 * e.g. http://localhost:5208/?mock=1&window=setup&firstrun=network
 */
import { FIRST_RUN_SCENARIOS, type FirstRunScenario } from './installSim'
import { mockEngine } from './mockEngine'

export function applyMockScenarios(params: URLSearchParams): void {
  const requested = params.get('firstrun') ?? ''
  const known = (FIRST_RUN_SCENARIOS as readonly string[]).includes(requested)
  const scenario: FirstRunScenario | null = known ? (requested as FirstRunScenario) : params.get('window') === 'setup' ? 'fresh' : null
  if (scenario) {
    mockEngine.installer.simulateFirstRun(scenario)
    console.info(`[fvwks] mock first run: ${scenario}`)
  }
}

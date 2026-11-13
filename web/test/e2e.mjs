// End-to-end test of web/ without the hardware. Runs every scenario of scenarios/*.mjs (or the one
// named on the command line) against shared tools from lib.mjs: the 4-channel sink, its split
// outputs, the static server and Chrome are created once; each scenario gets a fresh simulated
// controller and a reloaded page. A scenario is a module whose default export receives
// { page, sim, url } and reports through check().
//
// Usage: node web/test/e2e.mjs [scenario]   (make web-test [SCENARIO=poc])

import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { check, cleanup, createSink, failureCount, splitOutputs, startChrome, startServer, startSim } from './lib.mjs';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'scenarios');
const wanted = process.argv[2];

async function main() {
  const names = readdirSync(DIR).filter((f) => f.endsWith('.mjs')).map((f) => f.slice(0, -4)).sort()
    .filter((n) => !wanted || n === wanted);
  if (!names.length) throw new Error(`no scenario${wanted ? ` named ${wanted}` : ''} in ${DIR}`);

  createSink();
  await splitOutputs();
  const url = await startServer();
  const page = await startChrome(url);
  const failed = [];
  for (const name of names) {
    console.log(`\n== ${name}`);
    const before = failureCount();
    let sim;
    try {
      sim = await startSim();
      await page.reload();
      const { default: scenario } = await import(pathToFileURL(join(DIR, `${name}.mjs`)));
      await scenario({ page, sim, url });
    } catch (err) {
      check('le scénario va au bout', false, err.stack || String(err));
    } finally {
      await sim?.stop();
    }
    if (failureCount() > before) failed.push(name);
  }
  return failed;
}

let exitCode = 0;
try {
  const failed = await main();
  console.log(failed.length ? `\n${failureCount()} échec(s), scénario(s) en échec : ${failed.join(', ')}` : '\ntout est vert');
  exitCode = failed.length ? 1 : 0;
} catch (err) {
  console.error(`erreur : ${err.stack || err}`);
  exitCode = 2;
} finally {
  cleanup();
}
process.exit(exitCode);

/*
|--------------------------------------------------------------------------
| JavaScript entrypoint for running ace commands
|--------------------------------------------------------------------------
|
| Registers a hook to process TypeScript files using @poppinss/ts-exec, then
| imports the "bin/console.ts" file.
|
*/
import '@poppinss/ts-exec'

await import('./bin/console.js')

import { relative, resolve, join } from 'pathe'
import consola from 'consola'
import * as rollup from 'rollup'
import fse from 'fs-extra'
import { genDynamicImport } from 'knitwork'
import { printFSTree } from './utils/tree'
import { getRollupConfig } from './rollup/config'
import { hl, prettyPath, serializeTemplate, writeFile, isDirectory, replaceAll } from './utils'
import { NitroContext } from './context'
import { scanMiddleware } from './server/middleware'

export async function prepare (nitroContext: NitroContext) {
  consola.info(`Nitro preset is ${hl(nitroContext.preset)}`)

  await cleanupDir(nitroContext.output.dir)

  if (!nitroContext.output.publicDir.startsWith(nitroContext.output.dir)) {
    await cleanupDir(nitroContext.output.publicDir)
  }

  if (!nitroContext.output.serverDir.startsWith(nitroContext.output.dir)) {
    await cleanupDir(nitroContext.output.serverDir)
  }
}

async function cleanupDir (dir: string) {
  consola.info('Cleaning up', prettyPath(dir))
  await fse.emptyDir(dir)
}

export async function generate (nitroContext: NitroContext) {
  consola.start('Generating public...')

  await nitroContext._internal.hooks.callHook('nitro:generate', nitroContext)

  const publicDir = nitroContext._nuxt.publicDir
  if (await isDirectory(publicDir)) {
    await fse.copy(publicDir, nitroContext.output.publicDir)
  }

  const clientDist = resolve(nitroContext._nuxt.buildDir, 'dist/client')
  if (await isDirectory(clientDist)) {
    const buildAssetsDir = join(nitroContext.output.publicDir, nitroContext._nuxt.buildAssetsDir)
    await fse.copy(clientDist, buildAssetsDir)
  }

  consola.success('Generated public ' + prettyPath(nitroContext.output.publicDir))
}

export async function build (nitroContext: NitroContext) {
  // Compile html template
  const htmlSrc = resolve(nitroContext._nuxt.buildDir, `views/${{ 2: 'app', 3: 'document' }[2]}.template.html`)
  const htmlTemplate = { src: htmlSrc, contents: '', dst: '' }
  htmlTemplate.dst = htmlTemplate.src.replace(/.html$/, '.mjs').replace('app.template.mjs', 'document.template.mjs')
  htmlTemplate.contents = nitroContext.vfs[htmlTemplate.src] || await fse.readFile(htmlTemplate.src, 'utf-8')
  await nitroContext._internal.hooks.callHook('nitro:document', htmlTemplate)
  const compiled = 'export default ' + serializeTemplate(htmlTemplate.contents)
  await writeFile(htmlTemplate.dst, compiled)

  nitroContext.rollupConfig = getRollupConfig(nitroContext)
  await nitroContext._internal.hooks.callHook('nitro:rollup:before', nitroContext)
  return nitroContext._nuxt.dev ? _watch(nitroContext) : _build(nitroContext)
}

export async function writeTypes (nitroContext: NitroContext) {
  const routeTypes: Record<string, string[]> = {}

  const middleware = [
    ...nitroContext.scannedMiddleware,
    ...nitroContext.middleware
  ]

  for (const mw of middleware) {
    if (typeof mw.handle !== 'string') { continue }
    const relativePath = relative(nitroContext._nuxt.buildDir, mw.handle).replace(/\.[a-z]+$/, '')
    routeTypes[mw.route] = routeTypes[mw.route] || []
    routeTypes[mw.route].push(`Awaited<ReturnType<typeof ${genDynamicImport(relativePath, { wrapper: false })}.default>>`)
  }

  const lines = [
    '// Generated by nitro',
    'declare module \'@nuxt/nitro\' {',
    '  type Awaited<T> = T extends PromiseLike<infer U> ? Awaited<U> : T',
    '  interface InternalApi {',
    ...Object.entries(routeTypes).map(([path, types]) => `    '${path}': ${types.join(' | ')}`),
    '  }',
    '}',
    // Makes this a module for augmentation purposes
    'export {}'
  ]

  await writeFile(join(nitroContext._nuxt.buildDir, 'types/nitro.d.ts'), lines.join('\n'))
}

async function _build (nitroContext: NitroContext) {
  nitroContext.scannedMiddleware = await scanMiddleware(nitroContext._nuxt.serverDir)
  await writeTypes(nitroContext)

  consola.start('Building server...')
  const build = await rollup.rollup(nitroContext.rollupConfig).catch((error) => {
    consola.error('Rollup error: ' + error.message)
    throw error
  })

  consola.start('Writing server bundle...')
  await build.write(nitroContext.rollupConfig.output)

  const rewriteBuildPaths = (input: unknown, to: string) =>
    typeof input === 'string' ? replaceAll(input, nitroContext.output.dir, to) : undefined

  // Write build info
  const nitroConfigPath = resolve(nitroContext.output.dir, 'nitro.json')
  const buildInfo = {
    date: new Date(),
    preset: nitroContext.preset,
    commands: {
      preview: rewriteBuildPaths(nitroContext.commands.preview, '.'),
      deploy: rewriteBuildPaths(nitroContext.commands.deploy, '.')
    }
  }
  await writeFile(nitroConfigPath, JSON.stringify(buildInfo, null, 2))

  consola.success('Server built')
  await printFSTree(nitroContext.output.serverDir)
  await nitroContext._internal.hooks.callHook('nitro:compiled', nitroContext)

  // Show deploy and preview hints
  const rOutDir = relative(process.cwd(), nitroContext.output.dir)
  if (nitroContext.commands.preview) {
    // consola.info(`You can preview this build using \`${rewriteBuildPaths(nitroContext.commands.preview, rOutDir)}\``)
    consola.info('You can preview this build using `nuxi preview`')
  }
  if (nitroContext.commands.deploy) {
    consola.info(`You can deploy this build using \`${rewriteBuildPaths(nitroContext.commands.deploy, rOutDir)}\``)
  }

  return {
    entry: resolve(nitroContext.rollupConfig.output.dir, nitroContext.rollupConfig.output.entryFileNames as string)
  }
}

function startRollupWatcher (nitroContext: NitroContext) {
  const watcher = rollup.watch(nitroContext.rollupConfig)
  let start: number

  watcher.on('event', (event) => {
    switch (event.code) {
      // The watcher is (re)starting
      case 'START':
        return

      // Building an individual bundle
      case 'BUNDLE_START':
        start = Date.now()
        return

      // Finished building all bundles
      case 'END':
        nitroContext._internal.hooks.callHook('nitro:compiled', nitroContext)
        consola.success('Nitro built', start ? `in ${Date.now() - start} ms` : '')
        return

      // Encountered an error while bundling
      case 'ERROR':
        consola.error('Rollup error: ' + event.error)
        // consola.error(event.error)
    }
  })
  return watcher
}

async function _watch (nitroContext: NitroContext) {
  let watcher = startRollupWatcher(nitroContext)

  nitroContext.scannedMiddleware = await scanMiddleware(nitroContext._nuxt.serverDir,
    (middleware, event) => {
      nitroContext.scannedMiddleware = middleware
      if (['add', 'addDir'].includes(event)) {
        watcher.close()
        writeTypes(nitroContext).catch(console.error)
        watcher = startRollupWatcher(nitroContext)
      }
    }
  )
  await writeTypes(nitroContext)
}

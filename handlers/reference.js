import fs from 'node:fs'
import path from 'node:path'
import {spawnSync} from 'node:child_process'

import {REPOSITORY_PATHS} from '../repositories.js'

const is_safe_repository_path = relative_path => {
   if (!relative_path || relative_path.includes('\\') || path.posix.isAbsolute(relative_path)) {
      return false
   }
   const segments = relative_path.split('/')
   return !segments.some(segment => !segment || segment === '.' || segment === '..')
}

export const parse_tracked_repository_paths = output => output
   .split('\0')
   .filter(is_safe_repository_path)

export const parse_tracked_markdown_paths = output =>
   parse_tracked_repository_paths(output).filter(relative_path =>
      path.posix.extname(relative_path).toLowerCase() === '.md',
   )

const list_tracked_repository_paths = repository => {
   const root = path.resolve(repository.directory)
   if (!fs.existsSync(path.join(root, '.git'))) return []

   const result = spawnSync('git', [
      '-c', `safe.directory=${root}`,
      '-C', root,
      'ls-files', '--cached', '-z',
   ], {
      windowsHide: true,
   })
   if (result.error) throw result.error
   if (result.status !== 0) {
      const details = result.stderr?.toString('utf8').trim()
      throw new Error(details || `Git file listing failed for ${repository.name}`)
   }
   return parse_tracked_repository_paths(result.stdout?.toString('utf8') || '')
}

const list_tracked_markdown_paths = repository =>
   list_tracked_repository_paths(repository).filter(relative_path =>
      path.posix.extname(relative_path).toLowerCase() === '.md',
   )

export const list_parent_directories = paths => {
   const directories = new Set()
   paths.forEach(file_path => {
      const segments = file_path.split('/')
      segments.pop()
      for (let index = 1; index <= segments.length; index += 1) {
         directories.add(segments.slice(0, index).join('/'))
      }
   })
   return [...directories].sort((left, right) => left.localeCompare(right))
}

const has_hidden_parent_directory = relative_path =>
   relative_path.split('/').slice(0, -1).some(segment => segment.startsWith('.'))

const is_visible_directory = relative_path =>
   relative_path.split('/').every(segment => !segment.startsWith('.'))

export const build_reference_repository_listing = paths => ({
   files: paths.filter(relative_path =>
      path.posix.extname(relative_path).toLowerCase() === '.md' &&
      !has_hidden_parent_directory(relative_path),
   ),
   folders: list_parent_directories(paths).filter(is_visible_directory),
})

const is_safe_markdown_path = relative_path => {
   if (typeof relative_path !== 'string' || !relative_path || relative_path.includes('\\') ||
      path.posix.isAbsolute(relative_path)) return false
   const segments = relative_path.split('/')
   return !segments.some(segment => !segment || segment === '.' || segment === '..') &&
      path.posix.extname(relative_path).toLowerCase() === '.md'
}

/** Return a tracked Markdown document from one of the fixed repositories. */
export const handle_reference_document = (req, res) => {
   const repository = REPOSITORY_PATHS.find(item => item.name === req.query.repository)
   const relative_path = req.query.path
   if (!repository || !is_safe_markdown_path(relative_path)) {
      return res.status(404).json({error: 'Reference document not found'})
   }

   try {
      if (!list_tracked_markdown_paths(repository).includes(relative_path)) {
         return res.status(404).json({error: 'Reference document not found'})
      }

      const root = fs.realpathSync(repository.directory)
      const file_path = path.resolve(root, ...relative_path.split('/'))
      const real_file_path = fs.realpathSync(file_path)
      const relative_real_path = path.relative(root, real_file_path)
      if (!relative_real_path || relative_real_path.startsWith(`..${path.sep}`) ||
         relative_real_path === '..' || path.isAbsolute(relative_real_path) ||
         fs.lstatSync(file_path).isSymbolicLink() || !fs.statSync(file_path).isFile()) {
         return res.status(404).json({error: 'Reference document not found'})
      }

      res.setHeader('Cache-Control', 'no-store')
      return res.json({
         repository: repository.name,
         path: relative_path,
         content: fs.readFileSync(real_file_path, 'utf8'),
      })
   } catch (error) {
      if (error.code === 'ENOENT') return res.status(404).json({error: 'Reference document not found'})
      console.error('Unable to read Reference document:', error.message)
      return res.status(503).json({error: 'Unable to read Reference document'})
   }
}

/** List tracked Markdown paths from the fixed repository allowlist. */
export const handle_reference_tree = (req, res) => {
   try {
      const repositories = REPOSITORY_PATHS.map(repository => {
         const paths = list_tracked_repository_paths(repository)
         return {
            name: repository.name,
            ...build_reference_repository_listing(paths),
         }
      })
      res.setHeader('Cache-Control', 'no-store')
      res.json({repositories})
   } catch (error) {
      console.error('Unable to list Reference documents:', error.message)
      res.status(503).json({error: 'Unable to list Reference documents'})
   }
}

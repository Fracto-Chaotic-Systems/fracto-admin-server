import fs from 'node:fs'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'

const admin_directory = path.dirname(fileURLToPath(import.meta.url))
const root_directory = path.resolve(admin_directory, '..', '..', '..')
const repository_paths = [
   {name: 'fracto', directory: root_directory},
   ...['fracto-admin-server', 'fracto-asset-server', 'fracto-data-server',
      'fracto-tiles-server', 'fracto-ui'].map(name => ({
      name,
      directory: path.join(root_directory, 'servers', name),
   })),
]

const run_git = (directory, args) => {
   const result = spawnSync('git', args, {
      cwd: directory,
      encoding: 'utf8',
      windowsHide: true,
   })
   if (result.error) throw result.error
   if (result.status !== 0) throw new Error(result.stderr?.trim() || `git exited with ${result.status}`)
   return result.stdout || ''
}

const summarize_commit = (directory, hash) => {
   const summary = run_git(directory, ['show', '--format=', '--numstat', '--summary', '--no-renames', hash])
   let files_changed = 0
   let insertions = 0
   let deletions = 0
   let files_created = 0
   let files_removed = 0
   summary.split(/\r?\n/).forEach(line => {
      const numstat = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/)
      if (numstat) {
         files_changed++
         if (numstat[1] !== '-') insertions += Number(numstat[1])
         if (numstat[2] !== '-') deletions += Number(numstat[2])
      }
      if (line.startsWith(' create mode ')) files_created++
      if (line.startsWith(' delete mode ')) files_removed++
   })
   return {files_changed, insertions, deletions, files_created, files_removed}
}

/**
 * Collects recent commits from the root and nested service repositories.
 * @param {import('express').Request} req Request with optional `limit` query.
 * @param {import('express').Response} res Response containing normalized commits.
 * @returns {void}
 * @calledBy AdminBackend.commits and the Admin Commits page.
 * @notes Repositories are allowlisted; Git is invoked without a shell.
 */
export const handle_commits = (req, res) => {
   const requested_limit = Number(req.query.limit || 100)
   const limit = Number.isInteger(requested_limit)
      ? Math.min(250, Math.max(1, requested_limit)) : 100
   const commits = []
   repository_paths.forEach(repository => {
      if (!fs.existsSync(path.join(repository.directory, '.git'))) return
      try {
         const log = run_git(repository.directory, [
            'log', `-${limit}`, '--date=iso-strict',
            '--pretty=format:%H%x1f%aI%x1f%an%x1f%s',
         ])
         log.split(/\r?\n/).filter(Boolean).forEach(line => {
            const [hash, date, author, message] = line.split('\x1f')
            if (!hash || !date) return
            commits.push({
               repository: repository.name,
               hash,
               date,
               author,
               message,
               ...summarize_commit(repository.directory, hash),
            })
         })
      } catch (error) {
         console.error(`Unable to collect commits for ${repository.name}:`, error.message)
      }
   })
   commits.sort((left, right) => new Date(right.date) - new Date(left.date))
   res.json({commits: commits.slice(0, limit)})
}

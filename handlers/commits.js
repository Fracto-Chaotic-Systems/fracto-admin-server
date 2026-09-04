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

const parse_commit_records = log => log.split('\x1e').filter(Boolean).map(record => {
   const lines = record.trim().split(/\r?\n/)
   const [hash, date, author, message] = lines.shift().split('\x1f')
   let files_changed = 0
   let insertions = 0
   let deletions = 0
   let files_created = 0
   let files_removed = 0
   lines.forEach(line => {
      const numstat = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/)
      if (numstat) {
         files_changed++
         if (numstat[1] !== '-') insertions += Number(numstat[1])
         if (numstat[2] !== '-') deletions += Number(numstat[2])
      }
      if (line.startsWith(' create mode ')) files_created++
      if (line.startsWith(' delete mode ')) files_removed++
   })
   return {hash, date, author, message, files_changed, insertions, deletions, files_created, files_removed}
})

const load_commit_snapshot = () => {
   const snapshot_path = path.join(root_directory, 'build-info.json')
   if (!fs.existsSync(snapshot_path)) return []
   try {
      const snapshot = JSON.parse(fs.readFileSync(snapshot_path, 'utf8'))
      return Object.entries(snapshot.repositories || {}).flatMap(([repository, info]) =>
         (info.commits || []).map(commit => ({repository, ...commit})))
   } catch (error) {
      console.error('Unable to read commit snapshot:', error.message)
      return []
   }
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
   const repositories_found = new Set()
   repository_paths.forEach(repository => {
      if (!fs.existsSync(path.join(repository.directory, '.git'))) return
      try {
         const log = run_git(repository.directory, [
            'log', `-${limit}`, '--date=iso-strict',
            '--pretty=format:%x1e%H%x1f%aI%x1f%an%x1f%s',
            '--numstat', '--summary', '--no-renames',
         ])
         parse_commit_records(log).forEach(commit => {
            const {hash, date, author, message, ...summary} = commit
            if (!hash || !date) return
            commits.push({
               repository: repository.name,
               hash,
               date,
               author,
               message,
               ...summary,
            })
         })
         // Mark a repository as live only after its Git history was read
         // successfully. If Git is present but unusable in a deployment,
         // the packaged snapshot must still supply that repository's rows.
         repositories_found.add(repository.name)
      } catch (error) {
         console.error(`Unable to collect commits for ${repository.name}:`, error.message)
      }
   })
   // TODO(2026-10-04): remove the temporary snapshot fallback and its loader
   // once every supported deployment guarantees a commit snapshot. At that
   // point this handler should use the single packaged source directly and
   // report a clear configuration error when it is absent, rather than
   // silently falling back between live Git and snapshot data.
   if (repositories_found.size < repository_paths.length) {
      const snapshot = load_commit_snapshot()
      commits.push(...snapshot.filter(commit => !repositories_found.has(commit.repository)))
   }
   commits.sort((left, right) => new Date(right.date) - new Date(left.date))
   res.json({commits: commits.slice(0, limit)})
}

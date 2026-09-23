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
   const [hash, date, author, message, decorations = ''] = lines.shift().split('\x1f')
   const tags = decorations.split(',')
      .map(value => value.trim())
      .filter(value => value.startsWith('tag: '))
      .map(value => value.slice(5))
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
   return {hash, date, author, message, tags, files_changed, insertions, deletions, files_created, files_removed}
})

/**
 * Reads repository tag references without changing the existing commit
 * response shape. Annotated tags use their tagger timestamp; lightweight tags
 * use the target commit timestamp through Git's creator-date expansion.
 *
 * @param {string} output tab-delimited `git for-each-ref` output
 * @returns {Array<Object>} raw tag records for later milestone normalization
 */
const parse_tag_records = output => output.split(/\r?\n/).filter(Boolean).map(line => {
   const [name, object_hash, peeled_hash, object_type, created_at] = line.split('\t')
   return {
      name,
      object_hash,
      target_hash: peeled_hash || object_hash,
      object_type,
      created_at,
      annotated: object_type === 'tag',
      timestamp_source: created_at
         ? (object_type === 'tag' ? 'tagger' : 'commit')
         : null,
   }
})

/**
 * Resolves a missing tag timestamp from the referenced commit. This is mainly
 * for lightweight tags on Git versions or packed repositories that do not
 * expose `creatordate` through `for-each-ref`.
 *
 * @param {Object} repository allowlisted repository descriptor
 * @param {Object} record parsed tag record
 * @returns {Object} tag record with a best-effort timestamp source
 */
const resolve_tag_timestamp = (repository, record) => {
   if (record.created_at || !record.target_hash) return record
   try {
      const created_at = run_git(repository.directory, [
         'show', '-s', '--format=%cI', record.target_hash,
      ]).trim()
      if (created_at) {
         return {...record, created_at, timestamp_source: 'commit-fallback'}
      }
   } catch (error) {
      console.warn(`Unable to resolve timestamp for tag ${record.name}:`, error.message)
   }
   return {...record, timestamp_source: 'unavailable'}
}

const collect_tag_records = repository => {
   const output = run_git(repository.directory, [
      'for-each-ref', 'refs/tags',
      '--format=%(refname:strip=2)%09%(objectname)%09%(*objectname)%09%(objecttype)%09%(creatordate:iso-strict)',
   ])
   return parse_tag_records(output).map(record => resolve_tag_timestamp(repository, record))
}

/**
 * Groups the repository-level tag records into one milestone event per tag.
 * The earliest occurrence is used as the event date until the timeline policy
 * is finalized; every occurrence remains available for auditing.
 *
 * @param {Array<Object>} records raw repository tag records
 * @returns {Array<Object>} normalized tag events sorted newest first
 */
const normalize_tag_events = records => {
   const grouped = new Map()
   records.forEach(record => {
      if (!record.name) return
      const event = grouped.get(record.name) || {
         name: record.name,
         occurrences: [],
         repositories: [],
      }
      event.occurrences.push({
         repository: record.repository,
         target_hash: record.target_hash,
         created_at: record.created_at,
         annotated: record.annotated,
         timestamp_source: record.timestamp_source,
      })
      if (!event.repositories.includes(record.repository)) {
         event.repositories.push(record.repository)
      }
      grouped.set(record.name, event)
   })
   return [...grouped.values()]
      .map(event => ({
         ...event,
         created_at: event.occurrences
            .map(occurrence => occurrence.created_at)
            .filter(Boolean)
            .sort()[0] || null,
      }))
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
}

const load_commit_snapshot = () => {
   const snapshot_path = path.join(root_directory, 'build-info.json')
   if (!fs.existsSync(snapshot_path)) return []
   try {
      const snapshot = JSON.parse(fs.readFileSync(snapshot_path, 'utf8'))
      return {
         commits: Object.entries(snapshot.repositories || {}).flatMap(([repository, info]) =>
            (info.commits || []).map(commit => ({repository, ...commit}))),
         tag_records: Array.isArray(snapshot.tag_records) ? snapshot.tag_records : [],
         tag_events: Array.isArray(snapshot.tag_events) ? snapshot.tag_events : [],
      }
   } catch (error) {
      console.error('Unable to read commit snapshot:', error.message)
      return {commits: [], tag_records: [], tag_events: []}
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
   const tag_records = []
   let snapshot_tag_events = []
   const repositories_found = new Set()
   repository_paths.forEach(repository => {
      if (!fs.existsSync(path.join(repository.directory, '.git'))) return
      try {
         collect_tag_records(repository).forEach(tag => {
            tag_records.push({repository: repository.name, ...tag})
         })
         const log = run_git(repository.directory, [
            'log', `-${limit}`, '--date=iso-strict',
            '--pretty=format:%x1e%H%x1f%aI%x1f%an%x1f%s%x1f%D',
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
      commits.push(...snapshot.commits.filter(commit => !repositories_found.has(commit.repository)))
      tag_records.push(...snapshot.tag_records.filter(record =>
         !repositories_found.has(record.repository),
      ))
      snapshot_tag_events = snapshot.tag_events
   }
   commits.sort((left, right) => new Date(right.date) - new Date(left.date))
   const normalized_tag_events = tag_records.length
      ? normalize_tag_events(tag_records)
      : snapshot_tag_events
   res.json({
      commits: commits.slice(0, limit),
      tag_records,
      tag_events: normalized_tag_events,
   })
}

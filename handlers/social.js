import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {
   get_social_snapshot_status,
   refresh_social_snapshot,
} from './social_sync_service.js'

const handler_directory = path.dirname(fileURLToPath(import.meta.url))
const root_directory = path.resolve(handler_directory, '..', '..', '..')
const social_directory = path.join(root_directory, 'social')
const social_files = [
   'README.md',
   'CONTENT_GUIDELINES.md',
   'CAMPAIGN_FRAMEWORK.md',
   'Bluesky/README.md',
   'Bluesky/POST_ARCHIVE.md',
   'Bluesky/RESPONSE_LOG.md',
   'Bluesky/media/MEDIA_UPLOADS.md',
]

const document_title = (content, fallback) => {
   const title_line = content.split(/\r?\n/).find(line => line.trim().startsWith('# '))
   return title_line ? title_line.trim().slice(2) : fallback
}

/**
 * Reads the root social communication documents for the Admin UI.
 * @param {import('express').Request} req Unused request object.
 * @param {import('express').Response} res JSON response containing documents.
 * @returns {Promise<void>}
 * @calledBy AdminBackend.social and AdminSocial componentDidMount.
 * @notes The allowlisted filenames prevent the endpoint from becoming an
 * arbitrary filesystem reader. A stale local snapshot is refreshed through
 * the bounded social sync service before reading. The social folder is a shared root-level
 * editorial source, not a client-side UI asset directory.
 */
export const handle_social = async (req, res) => {
   let sync_status
   let sync_error = null
   try {
      sync_status = await refresh_social_snapshot({
         force: req.query.refresh === 'true',
      })
   } catch (error) {
      sync_error = error.message
      sync_status = get_social_snapshot_status()
      console.warn('Social snapshot refresh failed:', error.message)
   }
   try {
      const documents = social_files.map(relative_path => {
         const content = fs.readFileSync(path.join(social_directory, relative_path), 'utf8')
         const id = relative_path.replace(/\.md$/i, '').toLowerCase().replaceAll('\\', '/')
         return {
            id,
            path: relative_path.replaceAll('\\', '/'),
            filename: path.basename(relative_path),
            title: document_title(content, relative_path),
            content,
         }
      })
      res.json({
         documents,
         social_sync: {
            ...sync_status,
            error: sync_error,
         },
      })
   } catch (error) {
      console.error('Unable to read social documents:', error.message)
      res.status(500).json({
         error: 'Unable to load social documents',
         social_sync: {
            ...(sync_status || get_social_snapshot_status()),
            error: sync_error,
         },
      })
   }
}

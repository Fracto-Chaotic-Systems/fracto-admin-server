import test from 'node:test'
import assert from 'node:assert/strict'

import {
   handle_reference_document,
   handle_reference_tree,
   build_reference_repository_listing,
   list_parent_directories,
   parse_tracked_markdown_paths,
   parse_tracked_repository_paths,
} from './handlers/reference.js'

test('reference tree path parsing keeps tracked Markdown paths and handles unusual names', () => {
   const files = parse_tracked_markdown_paths([
      'README.md',
      'docs/Getting Started.MD',
      'social/drafts/weekly plan.md',
      'assets/logo.svg',
      'notes.txt',
      '../outside.md',
      '/absolute.md',
      'folder\\outside.md',
      'folder//empty-segment.md',
      '.',
      '',
   ].join('\0'))

   assert.deepEqual(files, [
      'README.md',
      'docs/Getting Started.MD',
      'social/drafts/weekly plan.md',
   ])
})

test('tracked repository paths expose folders containing only non-Markdown files', () => {
   const paths = parse_tracked_repository_paths([
      'README.md',
      'images/logo.svg',
      'images/icons/menu.png',
      'docs/guide.md',
   ].join('\0'))

   assert.deepEqual(list_parent_directories(paths), [
      'docs',
      'images',
      'images/icons',
   ])
   assert.deepEqual(parse_tracked_markdown_paths(paths.join('\0')), [
      'README.md',
      'docs/guide.md',
   ])
})

test('Reference listings omit dot-prefixed directories and their Markdown files', () => {
   const listing = build_reference_repository_listing([
      '.github/workflows/guide.md',
      '.github/config.yml',
      'docs/.internal/notes.md',
      'docs/README.md',
      'docs/assets/image.svg',
   ])

   assert.deepEqual(listing.files, ['docs/README.md'])
   assert.deepEqual(listing.folders, ['docs', 'docs/assets'])
})

const mock_response = () => ({
   headers: {},
   status_code: 200,
   setHeader(name, value) { this.headers[name] = value },
   status(code) { this.status_code = code; return this },
   json(value) { this.body = value; return this },
})

test('Reference tree returns tracked Markdown files and all tracked parent folders', () => {
   const res = mock_response()
   handle_reference_tree({}, res)

   assert.equal(res.status_code, 200)
   assert.ok(res.body.repositories.length >= 1)
   res.body.repositories.forEach(repository => {
      assert.ok(Array.isArray(repository.files))
      assert.ok(Array.isArray(repository.folders))
      assert.ok(repository.files.every(file_path => /\.md$/i.test(file_path)))
   })
})

test('Reference document endpoint serves tracked Markdown from the allowlist', () => {
   const res = mock_response()
   handle_reference_document({query: {repository: 'fracto-admin-server', path: 'README.md'}}, res)

   assert.equal(res.status_code, 200)
   assert.equal(res.body.repository, 'fracto-admin-server')
   assert.equal(res.body.path, 'README.md')
   assert.match(res.body.content, /^# /)
   assert.equal(res.headers['Cache-Control'], 'no-store')
})

test('Reference document endpoint rejects unknown repositories and unsafe paths', () => {
   for (const query of [
      {repository: 'external', path: 'README.md'},
      {repository: 'fracto-admin-server', path: '../README.md'},
      {repository: 'fracto-admin-server', path: 'package.json'},
      {repository: 'fracto-admin-server', path: ['README.md']},
   ]) {
      const res = mock_response()
      handle_reference_document({query}, res)
      assert.equal(res.status_code, 404)
      assert.deepEqual(res.body, {error: 'Reference document not found'})
   }
})

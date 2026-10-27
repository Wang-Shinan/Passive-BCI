import { expect, it } from 'vitest'
import { selectNewVideos, videoFileId } from './playlist'
const file = (name: string, webkitRelativePath = '') => ({ name, webkitRelativePath, size: 100, lastModified: 123 })
it('appends only new videos without modifying existing identities', () => {
  const first = file('first.mp4'), next = file('next.webm')
  const ids = [videoFileId(first)]
  const result = selectNewVideos([first, next, next, file('notes.txt')], ids)
  expect(result).toEqual({ added: [next], duplicates: 2, ignored: 1 })
  expect(ids).toEqual([videoFileId(first)])
})
it('keeps same-named videos in distinct subfolders and skips a repeated folder import', () => {
  const files = [file('clip.MP4', 'set/a/clip.MP4'), file('clip.MP4', 'set/b/clip.MP4')]
  expect(selectNewVideos(files, []).added).toEqual(files)
  expect(selectNewVideos(files, files.map(videoFileId))).toEqual({ added: [], duplicates: 2, ignored: 0 })
})

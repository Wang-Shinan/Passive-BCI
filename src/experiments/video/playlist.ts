export type VideoFileInfo = Pick<File, 'name' | 'size' | 'lastModified' | 'webkitRelativePath'>

// Metadata identity, not a content hash. Relative paths distinguish same-named folder entries.
export function videoFileId(file: VideoFileInfo): string {
  return JSON.stringify([file.webkitRelativePath || file.name, file.size, file.lastModified])
}

export function selectNewVideos<T extends VideoFileInfo>(files: T[], existingIds: Iterable<string>) {
  const known = new Set(existingIds)
  const added: T[] = []
  let duplicates = 0
  let ignored = 0
  for (const file of files) {
    if (!/\.(mp4|webm|ogg|ogv|mov|m4v)$/i.test(file.name)) { ignored++; continue }
    const id = videoFileId(file)
    if (known.has(id)) { duplicates++; continue }
    known.add(id)
    added.push(file)
  }
  return { added, duplicates, ignored }
}

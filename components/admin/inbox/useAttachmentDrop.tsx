'use client'

import { useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent } from 'react'
import { MAX_DROPPED_FILES, refuseDroppedFile } from '@/modules/unified-inbox/lib/uploads'
import type { Attachment } from './AttachmentPicker'

// Dragging a file onto a message you are writing.
//
// A hook rather than a wrapper component, because the two composers put the
// drop target and the words about it in different places: the reply composer
// hangs it on its own box, the new-message dialog on the whole card. What they
// share is the behaviour, and the behaviour is all that is here.
//
// SAFARI, which is the browser this was written against and the one that breaks
// every naive version of it:
//
//   The files must be taken out of the drop event SYNCHRONOUSLY. A DataTransfer
//   is emptied the moment the handler returns, so a single `await` before the
//   files are read leaves an empty list and a drop that silently does nothing.
//   Everything below gathers first and uploads afterwards, and that order is the
//   whole reason the gathering is its own function.
//
//   dragenter and dragleave fire for every element the pointer crosses INSIDE
//   the target, so "left the box" cannot be read off a dragleave. It is counted
//   instead: enter adds one, leave takes one, and the highlight goes when the
//   count reaches nought. Without it the overlay flickers off the moment the
//   pointer passes over the textarea.
//
//   The overlay drawn while dragging must not take pointer events, or it
//   becomes the thing being dragged over, which fires a leave for the box
//   underneath and an enter for itself, forever.
//
//   dragover must have its default prevented on every single event or the drop
//   never happens at all. It is not enough to do it on dragenter.
//
// A folder is refused rather than uploaded. Safari and Chrome both hand one
// over as a zero-byte File named after the folder, which would otherwise be
// emailed to a customer as an empty attachment.

/** What the browser is offering: files, or a dragged selection of text that has
 *  nothing to do with us and must be left alone so it can be dropped in the box
 *  as text. */
function hasFiles(transfer: DataTransfer | null): boolean {
  if (!transfer) return false
  // A DOMStringList on older Safari rather than an array, so it is walked
  // rather than searched.
  const types = transfer.types
  for (let i = 0; i < types.length; i += 1) if (types[i] === 'Files') return true
  return false
}

/** Everything dropped, read out of the event before it is emptied. Folders and
 *  anything refused come back as sentences rather than files. */
function gather(transfer: DataTransfer): { files: File[]; refusals: string[] } {
  const files: File[] = []
  const refusals: string[] = []

  // items carries the one thing files does not: whether the entry is a folder.
  const items = transfer.items
  if (items && items.length > 0) {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]
      if (!item || item.kind !== 'file') continue
      const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null
      if (entry?.isDirectory) {
        refusals.push(`"${entry.name}" is a folder. Drop the files inside it instead.`)
        continue
      }
      const file = item.getAsFile()
      if (file) files.push(file)
    }
  } else {
    const list = transfer.files
    for (let i = 0; i < list.length; i += 1) {
      const file = list[i]
      if (file) files.push(file)
    }
  }

  const accepted: File[] = []
  for (const file of files) {
    const refusal = refuseDroppedFile({ name: file.name, type: file.type, size: file.size })
    if (refusal) refusals.push(refusal)
    else accepted.push(file)
  }
  return { files: accepted, refusals }
}

/** How many go up at once. Enough that three small files feel instant, few
 *  enough that a slow line is not asked to carry eight at a time. */
const AT_ONCE = 3

export type AttachmentDrop = {
  /** Spread onto whatever element is the target. */
  dropProps: {
    onDragEnter: (event: ReactDragEvent<HTMLElement>) => void
    onDragOver: (event: ReactDragEvent<HTMLElement>) => void
    onDragLeave: (event: ReactDragEvent<HTMLElement>) => void
    onDrop: (event: ReactDragEvent<HTMLElement>) => void
  }
  /** Something with files in it is over the target right now. */
  dragging: boolean
  /** How far through, while anything is going up. */
  progress: { done: number; total: number } | null
  /** Everything the last drop could not take, as one sentence per file. */
  errors: string[]
  dismissErrors: () => void
}

export function useAttachmentDrop({ disabled = false, onAttached }: {
  disabled?: boolean
  /** Called as each file lands, rather than once at the end, so the chips
   *  appear one by one instead of all at the finish. */
  onAttached: (attachment: Attachment) => void
}): AttachmentDrop {
  const [dragging, setDragging] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [errors, setErrors] = useState<string[]>([])

  // Counted rather than flagged - see the note at the top of the file.
  const depth = useRef(0)

  // Read out of boxes so the handlers below can be built once and left alone.
  const attachedRef = useRef(onAttached)
  useEffect(() => { attachedRef.current = onAttached })
  const disabledRef = useRef(disabled)
  useEffect(() => { disabledRef.current = disabled })

  // Everything still in flight when the composer goes, so a reply that has been
  // sent and cleared is not still adding files to itself a second later. ONE
  // controller for the life of the composer rather than one per drop: a second
  // drop while the first is still going must not cancel the first, which is
  // exactly what a fresh controller per batch did.
  //
  // Minted on the first drop rather than on mount, and let go of again when the
  // composer does: React mounts a component twice in development, so a
  // controller made on mount is a controller aborted before the first file is
  // ever picked up - and uploads that work in production and nowhere else.
  const aborter = useRef<AbortController | null>(null)
  useEffect(() => () => {
    aborter.current?.abort()
    aborter.current = null
  }, [])

  // One queue, drained by at most AT_ONCE workers, whatever it was filled from.
  // Dropping three files and then two more while those are going is five files
  // going up, counted as five - not two batches racing each other over the same
  // progress line.
  const queue = useRef<File[]>([])
  const workers = useRef(0)
  const counted = useRef({ done: 0, total: 0 })
  const failures = useRef<string[]>([])

  const send = useCallback((files: File[]) => {
    queue.current.push(...files)
    counted.current = { done: counted.current.done, total: counted.current.total + files.length }
    setProgress({ ...counted.current })

    let controller = aborter.current
    if (!controller || controller.signal.aborted) {
      controller = new AbortController()
      aborter.current = controller
    }

    const work = async () => {
      for (;;) {
        const file = queue.current.shift()
        if (!file || controller.signal.aborted) break
        const body = new FormData()
        body.append('file', file)
        try {
          const response = await fetch('/api/m/unified-inbox/uploads', {
            method: 'POST',
            body,
            signal: controller.signal,
          })
          const data = await response.json().catch(() => null)
          if (!response.ok) {
            failures.current.push(
              typeof data?.error === 'string' && data.error
                ? data.error
                : `"${file.name}" could not be attached.`,
            )
          } else {
            const added: Attachment[] = Array.isArray(data?.attachments) ? data.attachments : []
            for (const attachment of added) attachedRef.current(attachment)
          }
        } catch {
          // The composer going while a file was on its way is not a failure to
          // report to somebody who is no longer looking at it.
          if (controller.signal.aborted) break
          failures.current.push(`"${file.name}" could not be attached. The site could not be reached.`)
        }
        counted.current = { done: counted.current.done + 1, total: counted.current.total }
        setProgress({ ...counted.current })
      }

      workers.current -= 1
      // The last one out puts the lights off: the counters only mean anything
      // again once nothing at all is in flight.
      if (workers.current === 0) {
        queue.current = []
        counted.current = { done: 0, total: 0 }
        if (controller.signal.aborted) return
        setProgress(null)
        if (failures.current.length > 0) {
          const said = failures.current
          failures.current = []
          setErrors((prev) => [...prev, ...said])
        }
      }
    }

    while (workers.current < AT_ONCE && workers.current < queue.current.length) {
      workers.current += 1
      void work()
    }
  }, [])

  const onDragEnter = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (disabledRef.current || !hasFiles(event.dataTransfer)) return
    event.preventDefault()
    depth.current += 1
    setDragging(true)
  }, [])

  const onDragOver = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (disabledRef.current || !hasFiles(event.dataTransfer)) return
    // Every event, not just the first - see the note at the top of the file.
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDragLeave = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (disabledRef.current || !hasFiles(event.dataTransfer)) return
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current === 0) setDragging(false)
  }, [])

  const onDrop = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (!hasFiles(event.dataTransfer)) return
    event.preventDefault()
    depth.current = 0
    setDragging(false)
    if (disabledRef.current) return

    // Synchronously, before anything is awaited - see the note at the top.
    const { files, refusals } = gather(event.dataTransfer)

    if (files.length > MAX_DROPPED_FILES) {
      setErrors([`That is ${files.length} files at once. Drop up to ${MAX_DROPPED_FILES} at a time.`])
      return
    }
    setErrors(refusals)
    if (files.length === 0) return
    send(files)
  }, [send])

  const dismissErrors = useCallback(() => setErrors([]), [])

  return {
    dropProps: { onDragEnter, onDragOver, onDragLeave, onDrop },
    dragging,
    progress,
    errors,
    dismissErrors,
  }
}

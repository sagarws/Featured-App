import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { TRANSCRIBER_IPC } from '@shared/constants/channels'
import type { Result } from '@shared/types/agent'
import { isMediaFile, isTranscriptLanguage, isTranscriptModel, MEDIA_EXTENSIONS } from '@shared/utils/transcriber'
import { logger } from '../logger'
import { isRendererUrl } from '../window'
import { cancelJob, exportJob, listJobs, modelInfo, removeJob, startJobs } from './service'

/** Every call must come from this app's own page. */
const handle = <A extends unknown[], T>(channel: string, fn: (event: IpcMainInvokeEvent, ...args: A) => T | Promise<T>): void => {
  ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<Result<T>> => {
    if (!isRendererUrl(event.senderFrame?.url ?? '')) return { ok: false, error: 'Not allowed.' }
    try {
      return { ok: true, value: await fn(event, ...(args as A)) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn(`[transcriber] ${channel} failed: ${message}`)
      return { ok: false, error: message }
    }
  })
}

const isId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v)
const id = (v: unknown): string => {
  if (!isId(v)) throw new Error('Invalid transcript id.')
  return v
}

export const registerTranscriberIpc = (): void => {
  handle(TRANSCRIBER_IPC.chooseFiles, async (event): Promise<string[]> => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: 'Choose video or audio',
      properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[],
      filters: [
        { name: 'Video or audio', extensions: MEDIA_EXTENSIONS },
        { name: 'All files', extensions: ['*'] }
      ]
    }
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    return result.canceled ? [] : result.filePaths
  })

  handle(TRANSCRIBER_IPC.start, (_event, files: unknown, language: unknown, model: unknown) => {
    if (!Array.isArray(files) || !files.length || files.length > 50 || !files.every(f => typeof f === 'string' && f.length < 4096))
      throw new Error('Choose one or more files.')
    const bad = (files as string[]).find(f => !isMediaFile(f))
    if (bad) throw new Error(`Not a video or audio file: ${bad.split(/[\\/]/).pop()}`)
    if (!isTranscriptLanguage(language)) throw new Error('Choose English or Hindi.')
    if (!isTranscriptModel(model)) throw new Error('Unknown model.')
    return startJobs(files as string[], language, model)
  })

  handle(TRANSCRIBER_IPC.list, () => listJobs())
  handle(TRANSCRIBER_IPC.models, () => modelInfo())
  handle(TRANSCRIBER_IPC.cancel, (_event, jobId: unknown) => cancelJob(id(jobId)))
  handle(TRANSCRIBER_IPC.remove, (_event, jobId: unknown) => removeJob(id(jobId)))
  handle(TRANSCRIBER_IPC.exportFile, (event, jobId: unknown, format: unknown) => {
    if (format !== 'txt' && format !== 'srt' && format !== 'vtt') throw new Error('Unknown format.')
    return exportJob(BrowserWindow.fromWebContents(event.sender), id(jobId), format)
  })
}

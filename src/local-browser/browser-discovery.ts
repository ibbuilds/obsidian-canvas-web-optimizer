import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

export type BrowserCandidate = {
  name: string
  executablePath: string
}

function addCandidate(
  candidates: BrowserCandidate[],
  seen: Set<string>,
  name: string,
  executablePath: string | undefined
) {
  if (!executablePath || seen.has(executablePath) || !existsSync(executablePath)) return

  seen.add(executablePath)
  candidates.push({ name, executablePath })
}

function findOnPath(command: string): string | null {
  try {
    const result = execFileSync('which', [command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()

    return result || null
  } catch {
    return null
  }
}

export function detectBrowserCandidates(): BrowserCandidate[] {
  const candidates: BrowserCandidate[] = []
  const seen = new Set<string>()
  const currentPlatform = platform()

  if (currentPlatform === 'win32') {
    const programFiles = process.env.ProgramFiles
    const programFilesX86 = process.env['ProgramFiles(x86)']
    const localAppData = process.env.LOCALAPPDATA

    addCandidate(
      candidates,
      seen,
      'Microsoft Edge',
      programFilesX86
        ? join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
        : undefined
    )
    addCandidate(
      candidates,
      seen,
      'Microsoft Edge',
      programFiles
        ? join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
        : undefined
    )
    addCandidate(
      candidates,
      seen,
      'Microsoft Edge',
      localAppData
        ? join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
        : undefined
    )
    addCandidate(
      candidates,
      seen,
      'Google Chrome',
      localAppData ? join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined
    )
    addCandidate(
      candidates,
      seen,
      'Google Chrome',
      programFiles ? join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined
    )
    addCandidate(
      candidates,
      seen,
      'Google Chrome',
      programFilesX86
        ? join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe')
        : undefined
    )
    addCandidate(
      candidates,
      seen,
      'Brave',
      programFiles
        ? join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')
        : undefined
    )
    addCandidate(
      candidates,
      seen,
      'Brave',
      localAppData
        ? join(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')
        : undefined
    )

    return candidates
  }

  if (currentPlatform === 'darwin') {
    const userApplications = join(homedir(), 'Applications')

    for (const root of ['/Applications', userApplications]) {
      addCandidate(
        candidates,
        seen,
        'Google Chrome',
        join(root, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome')
      )
      addCandidate(
        candidates,
        seen,
        'Microsoft Edge',
        join(root, 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge')
      )
      addCandidate(
        candidates,
        seen,
        'Brave',
        join(root, 'Brave Browser.app', 'Contents', 'MacOS', 'Brave Browser')
      )
      addCandidate(
        candidates,
        seen,
        'Chromium',
        join(root, 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
      )
    }

    return candidates
  }

  const linuxCommands: Array<[string, string]> = [
    ['Google Chrome', 'google-chrome-stable'],
    ['Google Chrome', 'google-chrome'],
    ['Chromium', 'chromium'],
    ['Chromium', 'chromium-browser'],
    ['Microsoft Edge', 'microsoft-edge-stable'],
    ['Microsoft Edge', 'microsoft-edge'],
    ['Brave', 'brave-browser']
  ]

  for (const [name, command] of linuxCommands) {
    addCandidate(candidates, seen, name, findOnPath(command) ?? undefined)
  }

  return candidates
}

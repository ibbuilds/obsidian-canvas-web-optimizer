import type { LinkNode } from 'obsidian'
import { resolveGuestWebContents } from '../platform/electron-runtime'
import { LIGHT_THEME_SCRIPT } from '../web-theme'

export type LightPreferenceResult = {
  applied: boolean
  status: string
  error?: Error
}

export async function forceGuestLightPreference(
  frameEl: LinkNode['frameEl']
): Promise<LightPreferenceResult> {
  if (!frameEl?.isConnected) {
    return { applied: false, status: 'frame unavailable' }
  }

  const guest = resolveGuestWebContents(frameEl)

  if (!guest || guest.isDestroyed?.()) {
    return { applied: false, status: 'guest WebContents unavailable' }
  }

  try {
    if (!guest.debugger.isAttached()) {
      try {
        guest.debugger.attach('1.3')
      } catch {
        guest.debugger.attach()
      }
    }

    await guest.debugger.sendCommand('Emulation.setEmulatedMedia', {
      media: 'screen',
      features: [{ name: 'prefers-color-scheme', value: 'light' }]
    })

    await Promise.allSettled([
      guest.debugger.sendCommand('Emulation.setAutoDarkModeOverride', {
        enabled: false
      }),
      guest.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: LIGHT_THEME_SCRIPT
      })
    ])

    return { applied: true, status: 'CDP applied' }
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error))

    return {
      applied: false,
      status: `CDP failed: ${normalized.message}`,
      error: normalized
    }
  }
}

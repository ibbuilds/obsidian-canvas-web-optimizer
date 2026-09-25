export const GENERATION_LIGHT_THEME_CSS = `
  :root {
    color-scheme: light !important;
  }
`

export const LIGHT_THEME_SCRIPT = `
  (() => {
    document.documentElement.style.setProperty('color-scheme', 'light', 'important')

    let meta = document.querySelector('meta[name="color-scheme"]')

    if (!meta) {
      meta = document.createElement('meta')
      meta.setAttribute('name', 'color-scheme')
      document.head?.appendChild(meta)
    }

    meta.setAttribute('content', 'light')
  })()
`

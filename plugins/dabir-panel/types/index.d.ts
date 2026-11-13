/** The paper the session works on: its folder and main file, and the PDF once one exists. */
export type Paper = { root: string; main: string; pdf: string | null }

export type Finding = { at: string; message: string }

/** The last `dabir-check` run: errors stop a compile, warnings are worth a look. */
export type Check = { errors: Finding[]; warnings: Finding[]; isMissing: boolean; at: number }

/** One edit the agent made to a .tex or .bib file, enough to show it and to take it back. */
export type Change = {
  id: string
  file: string
  tool: 'Edit' | 'Write'
  oldText: string
  newText: string
  diff: string
  added: number
  removed: number
  at: number
  isUndone: boolean
}

export type Build = { isOk: boolean; message: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'dabir-panel': {
      paper: Shaped<Paper | null>
      check: Shaped<Check | null>
      changes: Shaped<Change[]>
      build: Shaped<Build | null>
      busy: string
    }
  }
}

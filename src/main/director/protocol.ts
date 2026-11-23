// Parser for the director's line protocol. Pure. Re-parse the accumulated text on every chunk:
// replies are a few hundred bytes, so this is simpler than an incremental state machine and just as fast.
//
//   @none | @new | @extend
//   > one sentence to say now
//   - talking point            (2 to 4)
//   ? what they asked          (the section label)
//   +deep | +code              (optional: the deep model should add a diagram / depth, or the code for a coding problem)
//   ##
//   optional markdown detail

export type CueKind = 'none' | 'new' | 'extend'

export interface ParsedCue {
  kind: CueKind | null // null until the directive is known
  say: string
  sayDone: boolean // the say line has ended (a later line started, or the stream is done)
  points: string[]
  prompt: string
  detail: string
  deep: boolean // the model asked for a deep pass (`+deep` or `+code`, accepted on any line before the detail, or as its last line)
  code: boolean // `+code`: a coding problem the user will type out
}

const DIRECTIVE = /^@(none|new|extend)\b[:\s]*(.*)$/i
const DEEP = /^\+(deep|code)\s*$/i
const clean = (s: string): string => s.replace(/^\*\*(.*)\*\*$/, '$1').trim()

/** Parse everything received so far. `done` = the stream has ended, so the last line is complete. */
export function parseCue(text: string, done = false): ParsedCue {
  const out: ParsedCue = {
    kind: null,
    say: '',
    sayDone: false,
    points: [],
    prompt: '',
    detail: '',
    deep: false,
    code: false
  }
  const lines = text.replace(/\r/g, '').split('\n')
  let inDetail = false
  const detail: string[] = []

  lines.forEach((raw, i) => {
    const partial = !done && i === lines.length - 1
    const line = raw.trim()
    const marker = DEEP.exec(line)
    if (marker && !partial) {
      out.deep = true
      if (marker[1].toLowerCase() === 'code') out.code = true
      return
    }
    if (partial && /^\+[a-z]*$/i.test(line)) return // "+de": a marker still streaming
    if (inDetail) {
      detail.push(raw)
      return
    }
    if (!line || line.startsWith('```')) return
    if (line.startsWith('+')) return // an unknown marker

    if (out.kind === null) {
      const m = DIRECTIVE.exec(line)
      if (m) {
        // a partial "@ne" does not match; "@new" mid-stream is accepted once the word is whole
        if (partial && !/^@(none|new|extend)\s*$/i.test(line)) return
        out.kind = m[1].toLowerCase() as CueKind
        let rest = m[2]
        const inline = /(^|\s)\+(deep|code)\b/i.exec(rest) // "@new +deep"
        if (inline) {
          out.deep = true
          if (inline[2].toLowerCase() === 'code') out.code = true
          rest = rest.replace(inline[0], ' ').trim()
        }
        if (rest && out.kind !== 'none') out.prompt = clean(rest) // tolerate "@new <label>"
        return
      }
      if (!line.startsWith('>')) return // junk before the directive
      out.kind = 'new' // a say line without a directive: treat as a new card
    }
    if (out.kind === 'none') return

    if (line.startsWith('##')) {
      inDetail = true
      if (out.say) out.sayDone = true
      return
    }
    if (line.startsWith('>')) {
      const s = clean(line.slice(1))
      out.say = out.say ? `${out.say} ${s}` : s
      if (!partial) out.sayDone = true
      return
    }
    if (out.say) out.sayDone = true
    if (/^[-*•]\s?/.test(line)) {
      const p = clean(line.replace(/^[-*•]\s?/, ''))
      if (p) out.points.push(p)
    } else if (line.startsWith('?')) {
      out.prompt = clean(line.slice(1))
    } else if (!out.say) {
      out.say = clean(line) // model forgot the '>'
      if (!partial) out.sayDone = true
    }
  })

  out.detail = detail.join('\n').trim()
  if (out.kind === 'none') out.deep = out.code = false
  if (done && out.say) out.sayDone = true
  return out
}

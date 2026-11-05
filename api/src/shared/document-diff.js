import { createPatch } from 'diff'
import { documentLimits } from '../model.js'
import { error } from './http.js'

const exceeded = () => error(413, 'Comparación demasiado grande o compleja; descarga las versiones para compararlas fuera de Sugar / Comparison too large or complex; download the versions to compare outside Sugar')
export function documentDiff(file, before, after, beforeLabel, afterLabel) {
  for (const text of [before, after]) {
    if (Buffer.byteLength(text) > documentLimits.yamlBytes) exceeded()
    let lines = 1
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10 && ++lines > documentLimits.diffLines) exceeded()
  }
  const patch = createPatch(file, before, after, beforeLabel, afterLabel, { maxEditLength: documentLimits.diffEdits, timeout: documentLimits.diffTimeoutMs })
  // jsdiff aborts with undefined. Never return a successful empty response.
  if (patch === undefined) exceeded()
  return patch
}

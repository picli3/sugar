import { githubError } from './protocol.js'
// No queue of remote tasks: a disconnected HTTP caller retains its slot until
// the provider operation and its credential/transaction cleanup actually end.
export function createGithubGate({ maxConcurrent = 4 } = {}) {
  const active = new Set()
  return async (userId, task) => {
    if (active.has(userId) || active.size >= maxConcurrent) throw githubError('GITHUB_BUSY', 429)
    active.add(userId)
    try { return await task() } finally { active.delete(userId) }
  }
}

import { createGithubGate } from './gate.js'
import { createUserRepository } from '../users/repository.js'
import { githubLinkConfig } from './config.js'
import { createGithubClient } from './client.js'
import { createGithubLinkRepository } from './repository.js'
import { createGithubLinkService } from './service.js'
import { createGithubTargets } from './targets.js'
import { createGithubSynchronizer } from './worker.js'
export function createGithubIntegration({ q, transaction, env, client, runCredential, runProvider }) {
  const config = githubLinkConfig(env)
  runProvider ||= createGithubGate()
  client ||= createGithubClient(config)
  const links = createGithubLinkService({ repository: createGithubLinkRepository(q, transaction), users: createUserRepository(q, transaction), config, client, runCredential, runProvider })
  const targets = createGithubTargets({ q, links, client }), worker = createGithubSynchronizer({ q, links, client, config })
  return { config, client, links, targets, worker }
}

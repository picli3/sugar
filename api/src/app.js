import express from 'express'
import cookieParser from 'cookie-parser'
import { asyncRoute, errorHandler } from './shared/http.js'
import { requireAdmin, requireEdit } from './auth/policies.js'
import { createSessionRepository } from './auth/sessions.js'
import { createAccessControls, limitsConfig, proxyList } from './security/limits.js'
import { apiHeaders, publicOrigin, requestOrigin } from './security/headers.js'
import { createAuthService } from './auth/service.js'
import { authenticate, registerAuthRoutes, registerSessionRoutes } from './auth/routes.js'
import { createUserRepository } from './users/repository.js'
import { createUserService } from './users/service.js'
import { registerUserRoutes } from './users/routes.js'
import { createProjectRepository } from './projects/repository.js'
import { createProjectService } from './projects/service.js'
import { registerProjectRoutes, registerPublicProjectRoutes } from './projects/routes.js'
import { createBlockRepository } from './blocks/repository.js'
import { createBlockService } from './blocks/service.js'
import { registerBlockRoutes } from './blocks/routes.js'
import { createImageRepository } from './images/repository.js'
import { createImageService } from './images/service.js'
import { registerImageContentRoute, registerImageRoutes } from './images/routes.js'
import { registerCategoryRoutes } from './categories/routes.js'
import { projectCategoryIcons, validateCategory } from './categories.js'
import { replaceEmbeddedImages } from './images.js'
import { registerDocumentRoutes } from './documents.js'
import { createAiQuotas } from './ai/quotas.js'
import { createAiStorage } from './ai/storage.js'
import { registerAi } from './ai.js'
import { createProjectSyncService } from './github.js'
import { registerSyncRoutes } from './github/routes.js'
import { createReadiness, databaseProbe } from './monitoring/readiness.js'
import { securityAudit } from './monitoring/audit.js'
import { registrationConfig as loadRegistrationConfig, emailFeatureConfig } from './registration/config.js'
import { createRegistrationRepository, registrationSchemaReady } from './registration/repository.js'
import { createRegistrationService } from './registration/service.js'
import { registerRegistrationRoutes } from './registration/routes.js'
import { createMailService } from './mail/service.js'
import { registerMailRoutes } from './mail/routes.js'
import { createRecoveryRepository, recoverySchemaReady } from './recovery/repository.js'
import { createRecoveryService } from './recovery/service.js'
import { registerRecoveryRoutes, registerAccountEmailRoutes } from './recovery/routes.js'
import { createImageStorage } from './images/quotas.js'
import { registerImageStorageRoutes } from './images/quota-routes.js'
import { createDocumentStorage } from './document-storage/service.js'
import { createDocumentStorageRepository } from './document-storage/repository.js'
import { registerDocumentStorageRoutes } from './document-storage/routes.js'
import { createTotalStorage } from './storage-total/service.js'
import { registerTotalStorageRoutes } from './storage-total/routes.js'
import { createTrashRepository } from './trash/repository.js'
import { createTrashService } from './trash/service.js'
import { registerTrashRoutes } from './trash/routes.js'

// Composition only: no DB initialization, listener, timers or background workers.
// Query, transaction, session secret and GitHub operations belong to the caller.
export function createApp({ q, transaction, secret, enqueue, syncOne, callProvider, auditWriter, sendVerification, mailService, registrationConfig = loadRegistrationConfig(), recoveryConfig = emailFeatureConfig(process.env, 'ACCOUNT_RECOVERY_ENABLED'), sessionSecure = process.env.SESSION_SECURE === 'true', accessConfig = limitsConfig(), trustedProxies = process.env.TRUSTED_PROXIES || '', origin = process.env.PUBLIC_ORIGIN || '' }) {
  const app = express()
  app.set('trust proxy', proxyList(trustedProxies))
  app.disable('x-powered-by')
  app.disable('etag')
  app.use('/api', apiHeaders, requestOrigin(publicOrigin(origin)))
  const controls = createAccessControls({ secret, config: accessConfig })
  app.use('/api', controls.api)
  app.use('/api', securityAudit({ write: auditWriter }))
  app.post(['/api/login', '/api/me/password', '/api/me/email', '/api/users', '/api/registration/request', '/api/registration/verify', '/api/recovery/request', '/api/recovery/reset', '/api/recovery/confirm-email'], express.json({ limit: '4kb' }))
  app.put('/api/mail', express.json({ limit: '8kb' }))
  app.use(express.json({ limit: '3mb' }))
  app.use(cookieParser())

  const userRepository = createUserRepository(q, transaction)
  const auth = createAuthService({ users: userRepository, sessions: createSessionRepository(q, transaction), secret, runCredential: controls.runCredential })
  const mail = mailService || createMailService({ q })
  const recovery = createRecoveryService({ repository: createRecoveryRepository(q, transaction), config: recoveryConfig, mail, runCredential: controls.runCredential })
  const imageStorage = createImageStorage({ q, transaction })
  const documentStorage = createDocumentStorage({ repository: createDocumentStorageRepository(q), transaction })
  const images = createImageService(createImageRepository(q), imageStorage)
  const migrateEmbeddedImages = (yaml, kind, tx, options) => replaceEmbeddedImages(yaml, kind, tx, { ...options, storage: imageStorage })
  const projects = createProjectService({
    projects: createProjectRepository(q), transaction, enqueue, storage: documentStorage,
    categoryIcons: yaml => projectCategoryIcons(yaml, q), replaceEmbeddedImages: migrateEmbeddedImages, attachImages: images.attach,
  })
  const blocks = createBlockService({ blocks: createBlockRepository(q), transaction, storage: documentStorage, validateCategory, replaceEmbeddedImages: migrateEmbeddedImages, attachImages: images.attach })
  const sync = createProjectSyncService({ query: q, projects, synchronize: syncOne })

  // Public endpoints must precede the session middleware, just as before.
  app.get('/api/health', (_, res) => res.json({ ok: true }))
  const probe = databaseProbe(q)
  const ready = createReadiness({ probe: async () => (await probe()) && (!registrationConfig.enabled || await registrationSchemaReady(q)) && (!recoveryConfig.enabled || await recoverySchemaReady(q)) })
  app.get('/api/ready', asyncRoute(async (_req, res) => {
    const ok = await ready()
    if (!ok) res.set('Retry-After', '1')
    res.status(ok ? 200 : 503).json({ ok })
  }))
  registerImageContentRoute(app, images, auth)
  registerPublicProjectRoutes(app, projects)
  registerAuthRoutes(app, { auth, sessionSecure, loginGate: controls.login })
  registerRegistrationRoutes(app, {
    registration: createRegistrationService({ repository: createRegistrationRepository(q, transaction), config: registrationConfig, sendVerification: sendVerification || mail.sendVerification, runCredential: controls.runCredential }),
    gate: controls.registration,
  })
  registerRecoveryRoutes(app, { recovery, gate: controls.recovery })
  app.use('/api', authenticate(auth))

  app.post('/api/me/password', controls.credentials)
  app.post('/api/users', controls.credentials)
  registerSessionRoutes(app, auth)
  registerAccountEmailRoutes(app, { recovery, gate: [controls.credentials, controls.emailChange] })
  registerMailRoutes(app, { mail, gate: controls.credentials })
  registerImageRoutes(app, images)
  registerImageStorageRoutes(app, imageStorage)
  registerDocumentStorageRoutes(app, documentStorage)
  registerTotalStorageRoutes(app, createTotalStorage({ q, transaction }))
  registerTrashRoutes(app, createTrashService({ trash: createTrashRepository(q), transaction }))
  registerDocumentRoutes(app, q)
  registerUserRoutes(app, createUserService(userRepository, { runCredential: controls.runCredential, passwordChanged: recovery.passwordChanged }))
  registerCategoryRoutes(app, { query: q, transaction, storage: documentStorage })
  registerBlockRoutes(app, blocks)
  registerProjectRoutes(app, projects)
  registerSyncRoutes(app, sync)
  // Preserve the established AI module and its request-based policy interface.
  registerAi(app, {
    q, callProvider, quota: createAiQuotas({ q, transaction, storage: createAiStorage(createDocumentStorageRepository(q)) }),
    requireAdmin: req => requireAdmin(req.user),
    requireEdit: req => requireEdit(req.user),
    requireProject: (req, edit = false, ownerOnly = false) => projects.get(req.params.id, req.user, { edit, ownerOnly }),
  })
  app.use(errorHandler)
  return app
}
